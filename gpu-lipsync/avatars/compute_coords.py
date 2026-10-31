# 计算 MuseTalk 头像人脸框：在含 frames/*.png（25fps）的目录里运行，输出 coords.json。需要 pip install face_alignment opencv-python torch
import torch, torch._dynamo; torch._dynamo.config.suppress_errors=True; torch.compile=lambda m,*a,**k: m
import face_alignment, cv2, numpy as np, glob, json
fa = face_alignment.FaceAlignment(face_alignment.LandmarksType.TWO_D, device='cpu', flip_input=False)
out=[]
for p in sorted(glob.glob('frames/*.png')):
    img = cv2.imread(p)[:,:,::-1]
    lms = fa.get_landmarks_from_image(img)
    lm = lms[0].astype(np.int32)
    half = lm[29].copy()
    dist = np.max(lm[:,1]) - half[1]
    upper = max(0, half[1]-dist)
    out.append([int(np.min(lm[:,0])), int(upper), int(np.max(lm[:,0])), int(np.max(lm[:,1]))])
json.dump(out, open('coords.json','w'))
print(out[0], out[len(out)//2], out[-1])
