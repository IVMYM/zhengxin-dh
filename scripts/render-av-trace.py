"""把 check-av-sync.mjs 录下的真实时间线（每一帧画面何时呈现、是哪一帧、说话图层透明度，每句音频何时被听到）
还原成带声音的视频，前后两段拼在一起对比。画面全部来自原视频帧，声音来自 TTS 缓存。
用法：python3 scripts/render-av-trace.py out/sync-before-after.mp4 out/av-sync/before.json:修改前 out/av-sync/after.json:修改后
"""
import hashlib, json, os, subprocess, sys
import numpy as np, cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H, FPS, SR = 360, 640, 25, 24000
VOICE = 'zh-CN-XiaoxiaoNeural|+0%|+0Hz|'


def speakable(t):
    return t.replace('www.pbccrc.org.cn', '征信中心官网').replace('www.zhongdengwang.org.cn', '中登网').replace('*', '').strip()


def frames(path):
    cap = cv2.VideoCapture(path); out = []
    while True:
        ok, f = cap.read()
        if not ok: break
        out.append(cv2.resize(f, (W, H), interpolation=cv2.INTER_AREA))
    return out, cap.get(cv2.CAP_PROP_FPS) or 24


def pcm(mp3):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', mp3, '-f', 's16le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32)


def last_before(arr, t, key='x'):
    lo, hi = 0, len(arr) - 1
    if not arr or arr[0][key] > t: return None
    while lo < hi:
        m = (lo + hi + 1) // 2
        if arr[m][key] <= t: lo = m
        else: hi = m - 1
    return arr[lo]


def segment(path, label, idle, talk, ifps, tfps):
    d = json.load(open(path))
    lat = ((d.get('lat') or {}).get('base', 0) + (d.get('lat') or {}).get('output', 0)) * 1000
    s = [x for x in d['s'] if x['t'] >= d['askAt']]
    voiced = [x['t'] + lat for x in s if x['r'] > 0.012]
    t0, t1 = voiced[0] - 900, voiced[-1] + 2200
    fi = sorted([f for f in d['frames']['vIdle']], key=lambda f: f['x'] or f['t'])
    ft = sorted([f for f in d['frames']['vTalk']], key=lambda f: f['x'] or f['t'])
    for f in fi + ft: f['x'] = f['x'] or f['t']
    n = int((t1 - t0) / 1000 * FPS)
    video = []
    for i in range(n):
        T = t0 + i * 1000 / FPS
        a = last_before(fi, T); b = last_before(ft, T); smp = last_before(s, T, 't')
        im = idle[int(round(a['mt'] * ifps)) % len(idle)] if a else idle[0]
        op = smp['oT'] if smp else 0
        if b and op > 0.01:
            tk = talk[int(round(b['mt'] * tfps)) % len(talk)]
            im = cv2.addWeighted(tk, op, im, 1 - op, 0) if op < 0.99 else tk
        im = im.copy()
        video.append(im)
    # 声音：每句音频在“听到第 0 秒”的时刻放进去，句子被提前结束（跳过结尾静音）时在那一刻截断
    audio = np.zeros(int((t1 - t0) / 1000 * SR) + SR, np.float32)
    ends = sorted([e['at'] for e in d.get('dhEvents', []) if e['type'] == 'done'] + [e['t'] for e in d['ev'] if e['e'] == 'ended'])
    for k, tx in enumerate(d['texts']):
        nxt = d['texts'][k + 1]['t'] if k + 1 < len(d['texts']) else 1e18
        cs = [x for x in s if tx['t'] <= x['t'] < nxt and x['pl'] and x['ct'] > 0.05]
        if not cs: continue
        start = float(np.median([x['t'] - x['ct'] * 1000 for x in cs])) + lat
        key = hashlib.sha1((VOICE + speakable(tx['text'])).encode()).hexdigest()
        mp3 = os.path.join(ROOT, 'cache', 'tts', key + '.mp3')
        if not os.path.exists(mp3): print('缺音频', tx['text']); continue
        x = pcm(mp3)
        stop = next((e for e in ends if e > tx['t'] + 50), None)
        if stop is not None: x = x[:max(0, int((stop + lat - start) / 1000 * SR))]
        o = int((start - t0) / 1000 * SR)
        if o < 0: x = x[-o:]; o = 0
        x = x[:len(audio) - o]; audio[o:o + len(x)] += x
    for im in video:
        cv2.rectangle(im, (0, 0), (W, 34), (255, 255, 255), -1)
    return video, audio[:int(len(video) / FPS * SR)], label


def put_label(video, label):
    # 用 PIL 写中文标签（微软雅黑不可用时用系统中文字体）
    from PIL import Image, ImageDraw, ImageFont
    font = None
    for f in ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc']:
        if os.path.exists(f): font = ImageFont.truetype(f, 20); break
    out = []
    for im in video:
        p = Image.fromarray(cv2.cvtColor(im, cv2.COLOR_BGR2RGB)); dr = ImageDraw.Draw(p)
        dr.text((12, 6), label, fill=(40, 40, 40), font=font)
        out.append(cv2.cvtColor(np.array(p), cv2.COLOR_RGB2BGR))
    return out


def main():
    out = sys.argv[1]
    outfit = [o for o in json.load(open(os.path.join(ROOT, 'config', 'outfits.json')))['outfits'] if o['lipsyncAvatar'] == 'xiaoxin'][0]
    idle, ifps = frames(os.path.join(ROOT, 'public', outfit['idle'].lstrip('/')))
    talk, tfps = frames(os.path.join(ROOT, 'public', outfit['talk'].lstrip('/')))
    vids, auds = [], []
    for arg in sys.argv[2:]:
        path, label = arg.rsplit(':', 1)
        v, a, _ = segment(path, label, idle, talk, ifps, tfps)
        vids += put_label(v, label); auds.append(a)
    audio = np.concatenate(auds)
    wav = out + '.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '1', '-i', '-', wav], input=np.clip(audio, -32768, 32767).astype(np.int16).tobytes())
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-i', wav,
                          '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', out], stdin=subprocess.PIPE)
    for im in vids: p.stdin.write(im.tobytes())
    p.stdin.close(); p.wait(); os.remove(wav)
    print(out, len(vids), '帧')


if __name__ == '__main__':
    main()
