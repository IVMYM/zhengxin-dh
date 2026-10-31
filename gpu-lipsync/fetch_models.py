"""从自建的模型镜像（HTTP 目录，含 SHA256SUMS）拉取 fp16 模型并逐个核对 sha256（可断点续传、可重复运行）。"""
import hashlib, os, subprocess, sys, time
BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('MODEL_MIRROR', '')).rstrip('/')
if not BASE:
    sys.exit('用法：python fetch_models.py <模型镜像地址>，或设置环境变量 MODEL_MIRROR')
ROOT = os.path.dirname(os.path.abspath(__file__))
M = os.path.join(ROOT, 'models')
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()
sums = os.path.join(ROOT, 'SHA256SUMS')
subprocess.run(['curl', '-sS', '--retry', '20', '--retry-all-errors', '-o', sums, BASE + '/SHA256SUMS'], check=True)
want = [l.split() for l in open(sums) if l.strip()]
bad = 0
for h, rel in want:
    rel = rel[2:] if rel.startswith('./') else rel
    dst = os.path.join(M, *rel.split('/'))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst) and sha(dst) == h:
        print('OK (cached)', rel, flush=True); continue
    for attempt in range(8):
        t0 = time.time()
        subprocess.run(['curl', '-sS', '-C', '-', '--retry', '30', '--retry-all-errors', '--retry-delay', '5', '-o', dst, f'{BASE}/{rel}'])
        if os.path.exists(dst) and sha(dst) == h:
            print('OK', rel, os.path.getsize(dst), f'{time.time()-t0:.0f}s', flush=True); break
        if os.path.exists(dst) and os.path.getsize(dst) >= 0 and attempt >= 3:
            os.remove(dst)  # 多次校验失败：删掉重下
        time.sleep(5)
    else:
        print('FAIL', rel, flush=True); bad += 1
open(os.path.join(ROOT, 'models_ok.txt' if not bad else 'models_fail.txt'), 'w').write(f'bad={bad}\n')
sys.exit(1 if bad else 0)
