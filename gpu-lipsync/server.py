"""征信数字人口型同步服务（MuseTalk 1.5，fp16）。

POST /lipsync  multipart: audio=<mp3/wav>, avatar=<id>(默认 xiaoxin), with_audio=1
  -> video/mp4 (H.264 + AAC, 25fps, 与头像源视频同尺寸)
GET  /health
"""
import os, sys, io, json, glob, time, math, threading, subprocess, tempfile, logging

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

import numpy as np, cv2, torch
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import Response, JSONResponse
from transformers import WhisperModel

from musetalk.utils.utils import load_all_model, datagen
from musetalk.utils.audio_processor import AudioProcessor
from musetalk.utils.face_parsing import FaceParsing
from musetalk.utils.blending import get_image_prepare_material

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger('lipsync')
FFMPEG = os.environ.get('FFMPEG', r'C:\ffmpeg\bin\ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
FPS = 25
BATCH = int(os.environ.get('LIPSYNC_BATCH', '16'))
EXTRA_MARGIN = 10
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

vae, unet, pe = load_all_model(
    unet_model_path=os.path.join('models', 'musetalkV15', 'unet.pth'), vae_type='sd-vae',
    unet_config=os.path.join('models', 'musetalkV15', 'musetalk.json'), device=device)
DT = torch.float16 if device.type == 'cuda' else torch.float32  # CPU 只用于冒烟测试
pe = pe.to(device=device, dtype=DT)
vae.vae = vae.vae.to(device=device, dtype=DT)
unet.model = unet.model.to(device=device, dtype=DT)
dtype = unet.model.dtype
timesteps = torch.tensor([0], device=device)
audio_processor = AudioProcessor(feature_extractor_path='models/whisper')
whisper = WhisperModel.from_pretrained('models/whisper').to(device=device, dtype=dtype).eval()
whisper.requires_grad_(False)
fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)


class Avatar:
    """头像素材：frames/*.png + coords.json（[x1,y1,x2,y2] 每帧，来自 68 点人脸关键点）。首次加载时预计算 latent 和融合遮罩。"""

    def __init__(self, avatar_id):
        self.id = avatar_id
        self.dir = os.path.join(ROOT, 'avatars', avatar_id)
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
        # 正放 + 倒放，循环无跳帧
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


avatars = {}
for d in sorted(glob.glob(os.path.join(ROOT, 'avatars', '*'))):
    if os.path.isdir(d):
        aid = os.path.basename(d)
        avatars[aid] = Avatar(aid)
        log.info('avatar ready: %s %dx%d', aid, avatars[aid].w, avatars[aid].h)

gpu_lock = threading.Lock()
stats = {'requests': 0, 'last_ratio': None}


@torch.no_grad()
def render(avatar, audio_path, out_path, with_audio=True):
    wav = audio_path + '.16k.wav'
    subprocess.run([FFMPEG, '-v', 'error', '-y', '-i', audio_path, '-ac', '1', '-ar', '16000', wav], check=True)
    feats, n = audio_processor.get_audio_feature(wav, weight_dtype=dtype)
    chunks = audio_processor.get_whisper_chunk(feats, device, dtype, whisper, n, fps=FPS,
                                               audio_padding_length_left=2, audio_padding_length_right=2)
    cmd = [FFMPEG, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{avatar.w}x{avatar.h}',
           '-r', str(FPS), '-i', '-']
    if with_audio:
        cmd += ['-i', audio_path, '-c:a', 'aac', '-b:a', '128k', '-shortest']
    cmd += ['-c:v', 'libx264', '-g', '25', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out_path]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    idx = 0
    for wb, lb in datagen(chunks, avatar.latents, BATCH, device=device):
        af = pe(wb.to(device))
        pred = unet.model(lb.to(device=device, dtype=dtype), timesteps, encoder_hidden_states=af).sample
        for face in vae.decode_latents(pred.to(dtype=vae.vae.dtype)):
            enc.stdin.write(avatar.blend(idx, face).tobytes())
            idx += 1
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError('ffmpeg failed')
    os.remove(wav)
    return idx / FPS


app = FastAPI()


@app.get('/health')
def health():
    return {'ok': True, 'model': 'MuseTalk-1.5-fp16', 'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            'avatars': {k: [v.w, v.h] for k, v in avatars.items()}, 'fps': FPS, **stats}


@app.post('/lipsync')
async def lipsync(audio: UploadFile = File(...), avatar: str = Form('xiaoxin'), with_audio: int = Form(1)):
    if avatar not in avatars:
        raise HTTPException(404, 'unknown avatar')
    data = await audio.read()
    if not data or len(data) > 20 * 1024 * 1024:
        raise HTTPException(400, 'bad audio')
    tmpdir = tempfile.mkdtemp(prefix='ls_')
    src = os.path.join(tmpdir, 'in' + (os.path.splitext(audio.filename or '')[1] or '.mp3'))
    out = os.path.join(tmpdir, 'out.mp4')
    open(src, 'wb').write(data)
    t0 = time.time()
    try:
        with gpu_lock:
            dur = render(avatars[avatar], src, out, bool(with_audio))
        body = open(out, 'rb').read()
    finally:
        for f in glob.glob(os.path.join(tmpdir, '*')):
            try: os.remove(f)
            except OSError: pass
        try: os.rmdir(tmpdir)
        except OSError: pass
    took = time.time() - t0
    stats['requests'] += 1
    stats['last_ratio'] = round(dur / took, 2) if took else None
    log.info('lipsync %s: %.2fs video in %.2fs (x%.2f realtime)', avatar, dur, took, dur / took)
    return Response(body, media_type='video/mp4', headers={'x-duration': f'{dur:.3f}', 'x-compute': f'{took:.3f}'})


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host=os.environ.get('LIPSYNC_HOST', '0.0.0.0'), port=int(os.environ.get('LIPSYNC_PORT', '8787')), log_level='info')
