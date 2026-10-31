"""把 $ZX_WORK/out（默认 /mnt/workspace/out） 下的视频打成若干个独立的 tar（每个 ≤ 190MB），写到 $ZX_WORK/out_001.tar …
每个 tar 都能单独解压：在 Mac 项目目录里  tar -xf out_001.tar -C cache/lipsync"""
import os, tarfile, glob
WORK = os.environ.get('ZX_WORK', '/mnt/workspace')
OUT, LIMIT = os.path.join(WORK, 'out'), int(float(os.environ.get('ZX_PACK_MB', '190')) * 1024 * 1024)
for f in glob.glob(os.path.join(WORK, 'out_*.tar')):
    os.remove(f)
files = sorted(p for p in glob.glob(os.path.join(OUT, '*', '*.mp4')) if not p.endswith('.part.mp4'))
parts, cur, size = [], [], 0
for p in files:
    s = os.path.getsize(p)
    if cur and size + s > LIMIT:
        parts.append(cur); cur, size = [], 0
    cur.append(p); size += s
if cur: parts.append(cur)
for i, group in enumerate(parts, 1):
    name = os.path.join(WORK, f'out_{i:03d}.tar')
    with tarfile.open(name, 'w') as t:
        for p in group:
            t.add(p, arcname=os.path.relpath(p, OUT))
    print(f'{name}  {len(group)} 个视频  {os.path.getsize(name) / 1e6:.1f}MB')
print(f'共 {len(files)} 个视频，{len(parts)} 个包')
