"""离线批量渲染口型视频（MuseTalk 1.5，fp16）。与 gpu-lipsync/server.py 同一套推理与融合代码，输出直接可被页面使用：
  out/<头像>-<rev>/<cacheKey>.mp4   （H.264 + AAC，25fps，与头像源视频同尺寸）
用法：
  python render.py --avatars xiaoxin          # 默认头像 × 全部固定话术
  python render.py --avatars all              # 25 套服装全部
  python render.py --smoke                    # 冒烟测试：1 段短音频 → $ZX_WORK/smoke.mp4
已存在的视频自动跳过（可随时中断、重跑续上）。进度写到 $ZX_WORK/render.log。
"""
import os, sys, json, glob, time, argparse, subprocess, logging

ZX = os.path.dirname(os.path.abspath(__file__))
LS = os.path.join(ZX, 'lipsync')
WORK = os.environ.get('ZX_WORK', '/mnt/workspace')  # 魔搭默认 /mnt/workspace；Colab 由 notebook 设置
ap = argparse.ArgumentParser()
ap.add_argument('--jobs', default=os.path.join(ZX, 'jobs.json'))
ap.add_argument('--avatars', default='xiaoxin', help='逗号分隔，或 all')
ap.add_argument('--out', default=os.path.join(WORK, 'out'))
ap.add_argument('--batch', type=int, default=int(os.environ.get('LIPSYNC_BATCH', '16')))
ap.add_argument('--limit', type=int, default=0, help='每个头像最多渲染几段（调试用）')
ap.add_argument('--smoke', action='store_true')
args = ap.parse_args()

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s',
                    handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(os.path.join(WORK, 'smoke.log' if args.smoke else 'render.log'))])
log = logging.getLogger('render')
os.chdir(LS); sys.path.insert(0, LS)
T0 = time.time()

import numpy as np, cv2, torch
log.info('torch %s cuda=%s available=%s', torch.__version__, torch.version.cuda, torch.cuda.is_available())
DEV = os.environ.get('ZX_DEVICE', 'cuda')  # ZX_DEVICE=cpu 只用于无显卡机器上做流程自检（float32，很慢）
if DEV == 'cuda' and not torch.cuda.is_available():
    log.error('FAIL: torch.cuda.is_available() = False'); sys.exit(2)
from transformers import WhisperModel
from musetalk.utils.utils import load_all_model, datagen
from musetalk.utils.audio_processor import AudioProcessor
from musetalk.utils.face_parsing import FaceParsing
from musetalk.utils.blending import get_image_prepare_material

FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')
FPS = 25
EXTRA_MARGIN = 10
device = torch.device(DEV)
vae, unet, pe = load_all_model(unet_model_path=os.path.join('models', 'musetalkV15', 'unet.pth'), vae_type='sd-vae',
                               unet_config=os.path.join('models', 'musetalkV15', 'musetalk.json'), device=device)
DT = torch.float16 if DEV == 'cuda' else torch.float32  # T4/A10 都用 fp16
pe = pe.to(device=device, dtype=DT)
vae.vae = vae.vae.to(device=device, dtype=DT)
unet.model = unet.model.to(device=device, dtype=DT)
dtype = unet.model.dtype
timesteps = torch.tensor([0], device=device)
audio_processor = AudioProcessor(feature_extractor_path='models/whisper')
whisper = WhisperModel.from_pretrained('models/whisper').to(device=device, dtype=dtype).eval()
whisper.requires_grad_(False)
fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)
log.info('models loaded in %.1fs on %s', time.time() - T0, torch.cuda.get_device_name(0) if DEV == 'cuda' else DEV)


class Avatar:
    def __init__(self, avatar_id):
        self.id = avatar_id
        self.dir = os.path.join(LS, 'avatars', avatar_id)
        files = sorted(glob.glob(os.path.join(self.dir, 'frames', '*.png')))
        src = os.path.join(self.dir, 'source.mp4')
        if not files and os.path.exists(src):
            os.makedirs(os.path.join(self.dir, 'frames'), exist_ok=True)
            subprocess.run([FFMPEG, '-v', 'error', '-y', '-i', src, '-vf', f'fps={FPS}', os.path.join(self.dir, 'frames', '%05d.png')], check=True)
            files = sorted(glob.glob(os.path.join(self.dir, 'frames', '*.png')))
        if not files:
            raise FileNotFoundError(avatar_id)
        coords = json.load(open(os.path.join(self.dir, 'coords.json')))
        frames = [cv2.imread(f) for f in files]
        if len(coords) != len(frames):
            n = min(len(coords), len(frames)); log.warning('%s: coords %d ≠ frames %d，取 %d', avatar_id, len(coords), len(frames), n)
            coords, frames = coords[:n], frames[:n]
        self.h, self.w = frames[0].shape[:2]
        cache = os.path.join(self.dir, 'prepared.pt')
        if os.path.exists(cache):
            d = torch.load(cache, weights_only=False)
            latents, coords, masks, mboxes = d['latents'], d['coords'], d['masks'], d['mboxes']
        else:
            t0 = time.time()
            latents, masks, mboxes, fixed = [], [], [], []
            for (x1, y1, x2, y2), frame in zip(coords, frames):
                y2 = min(y2 + EXTRA_MARGIN, frame.shape[0])
                fixed.append([x1, y1, x2, y2])
                crop = cv2.resize(frame[y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4)
                latents.append(vae.get_latents_for_unet(crop).cpu())
                m, box = get_image_prepare_material(frame, [x1, y1, x2, y2], fp=fp, mode='jaw')
                masks.append(m); mboxes.append(box)
            coords = fixed
            torch.save({'latents': latents, 'coords': coords, 'masks': masks, 'mboxes': mboxes}, cache)
            log.info('prepared avatar %s (%d frames) in %.1fs', avatar_id, len(frames), time.time() - t0)
        self.frames = frames + frames[::-1]
        self.coords = coords + coords[::-1]
        self.latents = latents + latents[::-1]
        self.masks = [m.astype(np.float32)[..., None] / 255.0 for m in masks]
        self.masks = self.masks + self.masks[::-1]
        self.mboxes = mboxes + mboxes[::-1]

    def blend(self, i, face):
        i %= len(self.frames)
        frame = self.frames[i].copy()
        x1, y1, x2, y2 = self.coords[i]
        face = cv2.resize(face, (x2 - x1, y2 - y1), interpolation=cv2.INTER_LANCZOS4)
        xs, ys, xe, ye = self.mboxes[i]
        large = frame[ys:ye, xs:xe].copy()
        large[y1 - ys:y2 - ys, x1 - xs:x2 - xs] = face
        m = self.masks[i]
        frame[ys:ye, xs:xe] = (large * m + frame[ys:ye, xs:xe] * (1 - m)).astype(np.uint8)
        return frame


@torch.no_grad()
def render(avatar, audio_path, out_path):
    tmp = out_path + '.part.mp4'
    wav = out_path + '.16k.wav'
    subprocess.run([FFMPEG, '-v', 'error', '-y', '-i', audio_path, '-ac', '1', '-ar', '16000', wav], check=True)
    feats, n = audio_processor.get_audio_feature(wav, weight_dtype=dtype)
    chunks = audio_processor.get_whisper_chunk(feats, device, dtype, whisper, n, fps=FPS,
                                               audio_padding_length_left=2, audio_padding_length_right=2)
    cmd = [FFMPEG, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{avatar.w}x{avatar.h}', '-r', str(FPS), '-i', '-',
           '-i', audio_path, '-c:a', 'aac', '-b:a', '128k', '-shortest',
           '-c:v', 'libx264', '-g', '25', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    idx = 0
    for wb, lb in datagen(chunks, avatar.latents, args.batch, device=device):
        af = pe(wb.to(device))
        pred = unet.model(lb.to(device=device, dtype=dtype), timesteps, encoder_hidden_states=af).sample
        for face in vae.decode_latents(pred.to(dtype=vae.vae.dtype)):
            enc.stdin.write(avatar.blend(idx, face).tobytes())
            idx += 1
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError('ffmpeg failed')
    os.remove(wav)
    os.replace(tmp, out_path)
    return idx / FPS


def probe_duration(p):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], capture_output=True, text=True)
    try: return float(r.stdout.strip())
    except ValueError: return 0.0


if args.smoke:
    jobs = json.load(open(args.jobs))
    aud = sorted(glob.glob(os.path.join(ZX, 'audio', '*.mp3')), key=os.path.getsize)[0]  # 最短的一句
    out = os.path.join(WORK, 'smoke.mp4')
    try:
        t = time.time(); av = Avatar('xiaoxin'); tp = time.time() - t
        t = time.time(); dur = render(av, aud, out); tr = time.time() - t
        vd = probe_duration(out)
        ok = os.path.getsize(out) > 10000 and vd > 0.5
        log.info('%s: smoke.mp4 %.2fs video (%d bytes), avatar prep %.1fs, render %.1fs (x%.2f realtime), total %.1fs',
                 'PASS' if ok else 'FAIL', vd, os.path.getsize(out), tp, tr, dur / tr if tr else 0, time.time() - T0)
        sys.exit(0 if ok else 1)
    except Exception:
        log.exception('FAIL: smoke test error'); sys.exit(1)

jobs = json.load(open(args.jobs))
avs = jobs['avatars'] if args.avatars == 'all' else [a for a in args.avatars.split(',') if a]
clips = jobs['clips'][: args.limit or None]
total = len(avs) * len(clips)
done = skipped = failed = 0; vsec = 0.0; tstart = time.time()
log.info('render %d avatars × %d clips = %d', len(avs), len(clips), total)
for a in avs:
    odir = os.path.join(args.out, f"{a}-{jobs['rev']}")
    os.makedirs(odir, exist_ok=True)
    todo = [c for c in clips if not os.path.exists(os.path.join(odir, c['key'] + '.mp4'))]
    skipped += len(clips) - len(todo)
    if not todo:
        log.info('[%s] all %d exist, skip', a, len(clips)); continue
    try:
        av = Avatar(a)
    except Exception:
        log.exception('[%s] avatar load failed', a); failed += len(todo); continue
    for c in todo:
        t = time.time()
        try:
            d = render(av, os.path.join(ZX, 'audio', c['key'] + '.mp3'), os.path.join(odir, c['key'] + '.mp4'))
            done += 1; vsec += d
            n = done + skipped + failed
            el = time.time() - tstart
            eta = el / max(done, 1) * (total - n)
            log.info('[%d/%d] %s %s %.1fs in %.1fs (x%.2f) ETA %.0fmin | %s', n, total, a, c['key'][:8], d, time.time() - t,
                     d / (time.time() - t), eta / 60, c['text'][:18])
        except Exception:
            failed += 1; log.exception('[%s] %s failed', a, c['key'])
    del av
    if DEV == 'cuda': torch.cuda.empty_cache()
log.info('DONE rendered %d, skipped %d, failed %d, video %.0fs, wall %.0fs', done, skipped, failed, vsec, time.time() - tstart)
sys.exit(1 if failed else 0)
