#!/usr/bin/env python3
"""按 render-gate-sample.mjs 的逐帧计划，用原视频真实帧合成样片（白底，带 TTS 音频）。"""
import json, os, subprocess, sys, tempfile
import cv2
import numpy as np

plan = json.load(open(sys.argv[1]))
tmp = tempfile.mkdtemp(prefix='gate-')
# 说话视频要随机取帧：先解成图片（只占临时目录，不占内存）
subprocess.run(['ffmpeg', '-v', 'error', '-i', plan['talk'], '-q:v', '2', os.path.join(tmp, '%04d.jpg')], check=True)
talk = lambda f: cv2.imread(os.path.join(tmp, '%04d.jpg' % (f + 1))).astype(np.float32)
PAD = 40
OW, OH = 720 + 2 * PAD, 1280 + 2 * PAD
ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{OW}x{OH}', '-r', str(plan['fps']), '-i', '-',
                       '-itsoffset', str(plan['lead']), '-i', plan['audio'], '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                       '-crf', '18', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '96k', plan['out']], stdin=subprocess.PIPE)
cap = cv2.VideoCapture(plan['idle'])
for fr in plan['frames']:
    ok, idle = cap.read()
    if not ok:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0); ok, idle = cap.read()
    img = idle.astype(np.float32)
    if fr['wrap'] > 0:
        layer = np.zeros_like(img); la = 0.0
        for d in fr['decks']:  # 由下到上
            if d['a'] <= 0: continue
            layer = talk(d['f']) * d['a'] + layer * (1 - d['a']); la = d['a'] + la * (1 - d['a'])
        if la > 0:
            layer = layer / la
            a = fr['wrap'] * la
            img = layer * a + img * (1 - a)
    canvas = np.full((OH, OW, 3), 255, np.uint8)
    canvas[PAD:PAD + 1280, PAD:PAD + 720] = np.clip(img, 0, 255).astype(np.uint8)
    ff.stdin.write(canvas.tobytes())
ff.stdin.close()
code = ff.wait()
subprocess.run(['rm', '-rf', tmp])
sys.exit(code)
