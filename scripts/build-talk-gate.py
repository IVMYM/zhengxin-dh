#!/usr/bin/env python3
"""音量门控说话视频的素材表（CPU 离线，每套服装一次，只读视频不改画面）。

对每套服装的“说话循环视频”逐帧判断嘴是否闭着（自己和前后一帧都闭着才算可停帧），
并标出其中和待机画面姿势一致的帧。输出：
  public/media/gate/<头像id>.json  { fps, n, closed: "0101…", endOk: "0001…", startOk: "0101…" }
页面播报时：按语音的逐词时间戳提前知道停顿在哪，微调说话视频的播放速度（0.8~1.25 倍），
让画面正好在停顿开始时走到一帧闭嘴画面并停住，出声时从那一帧接着播。
画面全部是原视频的真实帧，没有贴图、变形，也没有两帧混合。

用法：python3 scripts/build-talk-gate.py [头像id ...]   （不带参数 = 全部服装）
依赖：opencv-python、numpy。
"""
import json, os, sys
import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'media', 'gate')
END_POSE = 2.5  # 与待机首帧的平均像素差（0~255）不超过这个值，算“和待机姿势一致”
FACE_POSE = 2.6  # 脸部原分辨率的平均像素差：缩略图看不出头微微偏转，淡入淡出时会出现双眼重影


def frames(path):
    cap = cv2.VideoCapture(path)
    while True:
        ok, f = cap.read()
        if not ok:
            break
        yield f
    cap.release()


def mouth_center(frame, box):
    """在人脸框下半部分找嘴唇颜色（偏红、饱和度高）的中心"""
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    rx1, ry1, rx2, ry2 = x1 + int(.25 * w), y1 + int(.6 * h), x2 - int(.25 * w), y1 + int(.88 * h)
    hsv = cv2.cvtColor(frame[ry1:ry2, rx1:rx2], cv2.COLOR_BGR2HSV).astype(int)
    lip = (((hsv[..., 0] < 12) | (hsv[..., 0] > 165)) & (hsv[..., 1] > 85)).astype(np.uint8)
    ys, xs = np.nonzero(lip)
    if len(xs) < 20:
        return (x1 + x2) / 2, y1 + .73 * h
    return rx1 + float(np.median(xs)), ry1 + float(np.median(ys))


def aperture(patch):
    """张嘴程度：嘴中线附近“口腔暗部 + 牙齿”所占的行数（闭嘴为 0）"""
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV).astype(int)
    h, w = patch.shape[:2]
    band = hsv[int(h * .35):int(h * .88), int(w * .4):int(w * .6)]
    inside = (band[..., 2] < 100) | ((band[..., 1] < 40) & (band[..., 2] > 200))
    return int((np.median(inside, axis=1) > .5).sum())


def lip_width(patch):
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV).astype(int)
    h = patch.shape[0]
    lip = ((hsv[..., 0] < 12) | (hsv[..., 0] > 165)) & (hsv[..., 1] > 80)
    cols = np.where(lip[int(h * .3):].any(axis=0))[0]
    return int(cols.max() - cols.min()) if len(cols) else 0


def build(avatar, idle, talk):
    box = json.load(open(os.path.join(ROOT, 'gpu-lipsync', 'avatars', avatar, 'coords.json')))[0]
    W, H = box[2] - box[0], box[3] - box[1]
    f0 = next(frames(idle))
    mcx, mcy = mouth_center(f0, box)
    PW, PH = int(round(.66 * W)) // 2 * 2, int(round(.46 * H)) // 2 * 2
    # 跟踪鼻子和两颊（说话时不动），保证每帧量的是嘴的同一位置
    nx, ny, nw, nh = int(mcx - .3 * W), int(mcy - .42 * H), int(.6 * W), int(.3 * H)
    tmpl = cv2.cvtColor(f0, cv2.COLOR_BGR2GRAY)[ny:ny + nh, nx:nx + nw]
    R = 32
    ref = cv2.getRectSubPix(f0, (PW, PH), (mcx, mcy - PH * .45 + PH / 2))
    ref_w = lip_width(ref)
    fx0, fy0 = max(0, box[0] - W // 4), max(0, box[1] - H // 4)
    fx1, fy1 = box[2] + W // 4, box[3] + H // 4
    face0 = cv2.cvtColor(f0, cv2.COLOR_BGR2GRAY)[fy0:fy1, fx0:fx1].astype(np.float32)
    aps, wids, thumbs, faces = [], [], [], []
    cap = cv2.VideoCapture(talk)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    cap.release()
    for f in frames(talk):
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        r = cv2.matchTemplate(g[ny - R:ny + nh + R, nx - R:nx + nw + R], tmpl, cv2.TM_CCOEFF_NORMED)
        _, _, _, ml = cv2.minMaxLoc(r)
        dx, dy = ml[0] - R, ml[1] - R
        p = cv2.getRectSubPix(f, (PW, PH), (mcx + dx, mcy - PH * .45 + dy + PH / 2))
        aps.append(aperture(p)); wids.append(lip_width(p))
        thumbs.append(cv2.resize(f, (90, 160), interpolation=cv2.INTER_AREA).astype(np.float32))
        faces.append(float(np.abs(g[fy0:fy1, fx0:fx1].astype(np.float32) - face0).mean()))
    n = len(aps)
    if n < 24:
        raise RuntimeError('说话视频太短')
    # 嘟嘴（“呜”的口型）嘴宽明显变窄，也不算闭嘴
    shut = [a <= 1 and w >= .9 * ref_w for a, w in zip(aps, wids)]
    # 停住用的闭嘴帧：自己完全闭着、前后一帧也基本闭着（暂停时显示的帧偏一帧也还是闭嘴）
    core = [aps[i] == 0 and shut[i] and shut[(i - 1) % n] and shut[(i + 1) % n] for i in range(n)]
    cores = [i for i in range(n) if core[i]]
    if len(cores) < 3:
        raise RuntimeError(f'说话视频里闭嘴的帧太少（{len(cores)}）')
    # 和待机画面姿势接近的闭嘴帧：整段话说完停在这些帧上，再淡回待机视频时看不出重影
    it = cv2.resize(f0, (90, 160), interpolation=cv2.INTER_AREA).astype(np.float32)
    pose = [float(np.abs(t - it).mean()) for t in thumbs]
    end_ok = [core[i] and pose[i] <= END_POSE and faces[i] <= FACE_POSE for i in range(n)]
    os.makedirs(OUT, exist_ok=True)
    meta = {'v': 2, 'fps': round(fps, 3), 'n': n,
            'closed': ''.join('1' if c else '0' for c in core),
            'endOk': ''.join('1' if c else '0' for c in end_ok),
            # 开口用的起始帧：只看全身姿势（开口时待机视频播到哪帧不确定，脸部严格对齐没有意义，多给些选择让第一个停顿也能对上）
            'startOk': ''.join('1' if core[i] and pose[i] <= END_POSE else '0' for i in range(n))}
    json.dump(meta, open(os.path.join(OUT, f'{avatar}.json'), 'w'), separators=(',', ':'))
    return meta, len(cores), sum(end_ok)


def main():
    outfits = json.load(open(os.path.join(ROOT, 'config', 'outfits.json')))['outfits']
    want = set(sys.argv[1:])
    ok = 0
    for o in outfits:
        av = o.get('lipsyncAvatar') or o['id']
        if want and av not in want and o['id'] not in want:
            continue
        idle = os.path.join(ROOT, 'public', o['idle'].lstrip('/'))
        talk = os.path.join(ROOT, 'public', (o.get('talk') or o['idle']).lstrip('/'))
        try:
            meta, nc, ne = build(av, idle, talk)
            ok += 1
            print(f'{av}: {meta["n"]} 帧，闭嘴可停 {nc} 帧，其中与待机姿势一致 {ne} 帧')
        except Exception as e:
            print(f'{av}: 跳过（{e}），这套服装播报时仍用说话循环视频')
    print(f'完成 {ok} 套')


if __name__ == '__main__':
    main()
