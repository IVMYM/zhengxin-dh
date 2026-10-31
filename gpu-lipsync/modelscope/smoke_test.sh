#!/usr/bin/env bash
# 冒烟测试：GPU 检查 + 默认头像 xiaoxin × 最短一句话 → $ZX_WORK/smoke.mp4（默认 /mnt/workspace），最后打印 PASS / FAIL 和耗时
ZX="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${ZX_WORK:-/mnt/workspace}"; export ZX_WORK="$WORK"
if [ "${ZX_ENV:-$(cat "$ZX/env.txt" 2>/dev/null)}" = colab ]; then PY="$(command -v python3)"; else PY="$ZX/venv/bin/python"; fi
t0=$(date +%s)
[ -x "$PY" ] && [ -f "$ZX/setup.ok" ] || { echo "FAIL: 还没装好（没有 $PY 或 $ZX/setup.ok），先运行 bash $ZX/setup.sh"; exit 1; }
"$PY" - <<'PY' || { echo "FAIL: GPU 不可用（看上面的报错；可试 ZX_TORCH=cu124 bash setup.sh 重装 torch）"; exit 1; }
import torch
print('torch', torch.__version__, 'cuda', torch.version.cuda, 'available', torch.cuda.is_available())
a = torch.randn(1024, 1024, device='cuda', dtype=torch.float16)
torch.cuda.synchronize(); print('matmul ok', float((a @ a).float().mean()), torch.cuda.get_device_name(0))
PY
rm -f "$WORK/smoke.mp4"
if "$PY" "$ZX/render.py" --smoke; then
  echo "==== SMOKE PASS  用时 $(( $(date +%s) - t0 ))s  视频：$WORK/smoke.mp4（右键下载看一眼嘴型）"
else
  echo "==== SMOKE FAIL  用时 $(( $(date +%s) - t0 ))s  日志：$WORK/smoke.log"; exit 1
fi
