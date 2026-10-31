# 快速版：每 STEP 帧检测一次人脸关键点，中间帧线性插值（待机视频头部动作很小）。用法同 compute_coords.py
import torch, torch._dynamo; torch._dynamo.config.suppress_errors=True; torch.compile=lambda m,*a,**k: m
import os
torch.set_num_threads(int(os.environ.get('THREADS', '2')))
import face_alignment, cv2, numpy as np, glob, json
STEP = int(os.environ.get('STEP', '4'))
fa = face_alignment.FaceAlignment(face_alignment.LandmarksType.TWO_D, device='cpu', flip_input=False)
paths = sorted(glob.glob('frames/*.png'))
idx = sorted(set(list(range(0, len(paths), STEP)) + [len(paths) - 1]))
box = {}
for i in idx:
    img = cv2.imread(paths[i])[:, :, ::-1]
    lm = fa.get_landmarks_from_image(img)[0].astype(np.int32)
    half = lm[29].copy(); dist = np.max(lm[:, 1]) - half[1]; upper = max(0, half[1] - dist)
    box[i] = np.array([np.min(lm[:, 0]), upper, np.max(lm[:, 0]), np.max(lm[:, 1])], float)
out = []
for i in range(len(paths)):
    a = max(k for k in idx if k <= i); b = min(k for k in idx if k >= i)
    t = 0 if a == b else (i - a) / (b - a)
    out.append([int(round(v)) for v in box[a] * (1 - t) + box[b] * t])
json.dump(out, open('coords.json', 'w'))
print(len(out), out[0], out[len(out)//2], out[-1])
