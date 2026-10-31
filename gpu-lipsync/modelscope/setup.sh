#!/usr/bin/env bash
# 一次性安装（可重复运行，已完成的步骤会跳过）。日志：$ZX_WORK/setup.log
# 魔搭 Notebook：bash /mnt/workspace/zx/setup.sh        强制装 cu124 版 torch：ZX_TORCH=cu124 bash setup.sh
# Google Colab： ZX_ENV=colab ZX_WORK=/content/... bash zx/setup.sh
#   colab 模式：不建 venv，直接用 Colab 自带的 python/torch/numpy（版本钉死不动），只补缺的包；权重从 Hugging Face 直连下载
set -Eeuo pipefail
ZX="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVK="${ZX_ENV:-modelscope}"
WORK="${ZX_WORK:-/mnt/workspace}"
LOG="$WORK/setup.log"
exec > >(tee -a "$LOG") 2>&1
trap 'rc=$?; set +x; echo; echo "!!!! SETUP FAILED (exit $rc) at line $LINENO: $BASH_COMMAND"; echo "!!!! 完整日志：$LOG"; exit $rc' ERR
echo "==== setup start $(date '+%F %T')  ZX=$ZX  env=$ENVK  work=$WORK"
set -x

M="$ZX/lipsync/models"
VENV="$ZX/venv"
IDX1="${PIP_INDEX_URL:-https://mirrors.cloud.aliyuncs.com/pypi/simple/}"
IDX2="https://mirrors.aliyun.com/pypi/simple/"
TORCH_WHL="https://mirrors.aliyun.com/pytorch-wheels/cu124/"
SYSPY="$(command -v python3.12 || command -v python3)"

# ---- 1. 环境 ----
nvidia-smi
"$SYSPY" -V
command -v ffmpeg
df -h "$WORK"

# ---- 2. 系统自带 torch 能不能在这块卡上跑（驱动 550 只支持到 CUDA 12.4，cu13 的 torch 多半不行）----
cat > /tmp/zx_gpu_check.py <<'PY'
import torch, sys
print('torch', torch.__version__, 'built for cuda', torch.version.cuda)
ok = torch.cuda.is_available()
print('cuda available:', ok)
if ok:
    a = torch.randn(512, 512, device='cuda', dtype=torch.float16)
    print('matmul ok, sum =', float((a @ a).float().sum()), 'gpu =', torch.cuda.get_device_name(0))
sys.exit(0 if ok else 3)
PY
MODE="${ZX_TORCH:-auto}"
if [ "$ENVK" = colab ]; then MODE=colab; fi
if [ "$MODE" = auto ]; then
  if "$SYSPY" /tmp/zx_gpu_check.py; then MODE=system; else MODE=cu124; fi
fi
if [ "$MODE" != colab ]; then echo "torch mode: $MODE" | tee "$ZX/torch_mode.txt"; fi

pipi() {  # 先用默认（阿里云内网）源，失败再用阿里云公网源
  "$VENV/bin/python" -m pip install --disable-pip-version-check "$@" -i "$IDX1" || \
  "$VENV/bin/python" -m pip install --disable-pip-version-check "$@" -i "$IDX2"
}

if [ "$ENVK" = colab ]; then
  # ---- Colab：用自带 python，不建 venv、不重装 torch ----
  PY="$(command -v python3)"
  "$PY" /tmp/zx_gpu_check.py || { set +x; echo "!!!! Colab 没有可用 GPU：菜单 运行时 > 更改运行时类型 > T4 GPU，然后重新运行"; exit 3; }
  echo "torch mode: colab-system" | tee "$ZX/torch_mode.txt"
  "$PY" -m pip freeze | grep -iE '^(torch|torchvision|torchaudio|numpy)==' > "$ZX/constraints.txt" || true
  cat "$ZX/constraints.txt"
  # 只装缺的包（Colab 通常已有 transformers / diffusers / accelerate / librosa / opencv / einops）
  MISSING="$("$PY" - <<'PY'
import importlib.util as u
need = {'diffusers': 'diffusers', 'transformers': 'transformers', 'accelerate': 'accelerate', 'librosa': 'librosa',
        'soundfile': 'soundfile', 'einops': 'einops', 'omegaconf': 'omegaconf', 'cv2': 'opencv-python-headless'}
print(' '.join(p for m, p in need.items() if u.find_spec(m) is None))
PY
)"
  [ -z "$MISSING" ] || "$PY" -m pip install --disable-pip-version-check -c "$ZX/constraints.txt" $MISSING
  # 自带版本导入失败时，换成在 numpy 2 + 新版 torch 上验证过的组合（torch/numpy 仍钉死）
  if ! (cd "$ZX/lipsync" && "$PY" -c "import diffusers, transformers; from transformers import WhisperModel, AutoFeatureExtractor; from diffusers import AutoencoderKL, UNet2DConditionModel; from musetalk.utils.utils import load_all_model"); then
    "$PY" -m pip install --disable-pip-version-check -c "$ZX/constraints.txt" "diffusers==${ZX_DIFFUSERS:-0.42.1}" "transformers==${ZX_TRANSFORMERS:-5.22.1}" accelerate
  fi
  VENV=""
else
# ---- 3. 虚拟环境放在 /mnt/workspace（实例重启后还在）----
if [ ! -x "$VENV/bin/python" ]; then
  if [ "$MODE" = system ]; then "$SYSPY" -m venv --system-site-packages "$VENV"; else "$SYSPY" -m venv "$VENV"; fi
fi
"$VENV/bin/python" -m pip --version

if [ "$MODE" = system ]; then
  # 沿用镜像里的 torch：把已装的 torch 版本钉死，防止被依赖顺手升级/降级
  "$VENV/bin/python" -m pip freeze | grep -iE '^(torch|torchvision|torchaudio|numpy)==' > "$ZX/constraints.txt" || true
  cat "$ZX/constraints.txt"
  pipi -c "$ZX/constraints.txt" "diffusers>=0.30" "transformers>=4.39" accelerate librosa soundfile einops omegaconf opencv-python-headless
else
  # 驱动 550：装验证过的组合 torch 2.6.0+cu124（与之前 Windows 口型服务一致）
  "$VENV/bin/python" -c "import torch; assert torch.__version__.startswith('2.6.0')" 2>/dev/null || \
    pipi torch==2.6.0+cu124 torchvision==0.21.0+cu124 -f "$TORCH_WHL"
  pipi "numpy<2" diffusers==0.30.2 transformers==4.39.2 accelerate==0.28.0 huggingface_hub==0.25.2 \
       librosa soundfile einops omegaconf opencv-python-headless
fi
"$VENV/bin/python" /tmp/zx_gpu_check.py
PY="$VENV/bin/python"
fi

# ---- 4. 模型权重（魔搭直链 / Colab 走 Hugging Face，断点续传 + sha256 校验；两边文件 sha256 相同）----
fetch() {  # fetch <url> <dst> <sha256>
  local url="$1" dst="$2" want="$3"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && [ "$(sha256sum "$dst" | cut -d' ' -f1)" = "$want" ]; then echo "OK (cached) $dst"; return 0; fi
  for i in 1 2 3 4 5; do
    curl -fL --retry 10 --retry-all-errors --retry-delay 5 -C - -o "$dst" "$url" || true
    if [ "$(sha256sum "$dst" | cut -d' ' -f1)" = "$want" ]; then echo "OK $dst"; return 0; fi
    echo "sha256 不符，重下（第 $i 次）"; rm -f "$dst"
  done
  echo "下载失败：$url"; return 1
}
MS=https://www.modelscope.cn/models
if [ "$ENVK" = colab ]; then
  HF="${HF_ENDPOINT:-https://huggingface.co}"
  U_MT=$HF/TMElyralab/MuseTalk/resolve/main; U_VAE=$HF/stabilityai/sd-vae-ft-mse/resolve/main; U_WH=$HF/openai/whisper-tiny/resolve/main
else
  U_MT=$MS/AI-ModelScope/MuseTalk/resolve/master; U_VAE=$MS/stabilityai/sd-vae-ft-mse/resolve/master; U_WH=$MS/openai-mirror/whisper-tiny/resolve/master
fi
fetch $U_MT/musetalkV15/musetalk.json "$M/musetalkV15/musetalk.json" 5b6923aee04d71692e0e9846c471e0a4ea07a4f686d39545e472bd4ba17e1b47
fetch $U_MT/musetalkV15/unet.pth "$M/musetalkV15/unet.pth" 7ebf6c98c181e20838e4c0054e96e944ac60d5d692cc01db42839fe11b787007
fetch $U_VAE/config.json "$M/sd-vae/config.json" 92d3dfb746fca211a2c9e019e285f8597412211728dce3c5bcf4eda0f2d62e7e
fetch $U_VAE/diffusion_pytorch_model.bin "$M/sd-vae/diffusion_pytorch_model.bin" 1b4889b6b1d4ce7ae320a02dedaeff1780ad77d415ea0d744b476155c6377ddc
fetch $U_WH/config.json "$M/whisper/config.json" ffdccec4f3211f4c63310f2b7098f309fe70f3952cedc5e4d11e43f5b2379b98
fetch $U_WH/preprocessor_config.json "$M/whisper/preprocessor_config.json" 9b5cd03a36fbb8a627c64d98a5b5b126ead95a77720723944487311f0110b666
fetch $U_WH/pytorch_model.bin "$M/whisper/pytorch_model.bin" 9607f98a2b22d9e229ae43c52ecea79dcede9e0c5cfae67e8da6eda86d8aac1d
# 人脸分割：魔搭上没有可靠副本，走 hf-mirror；不通时上传 ms-faceparse.tar 解压到 /mnt/workspace 即可（同一路径）
if [ "$ENVK" = colab ]; then HFM_BASE="${HF_ENDPOINT:-https://huggingface.co}"; else HFM_BASE="${HF_ENDPOINT:-https://hf-mirror.com}"; fi
HFM="$HFM_BASE/ManyOtherFunctions/face-parse-bisent/resolve/main"
fetch $HFM/79999_iter.pth "$M/face-parse-bisent/79999_iter.pth" 468e13ca13a9b43cc0881a9f99083a430e9c0a38abd935431d1c28ee94b26567
fetch $HFM/resnet18-5c106cde.pth "$M/face-parse-bisent/resnet18-5c106cde.pth" 5c106cde386e87d4033832f2996f5493238eda96ccf559d1d62760c4de0613f8

# ---- 5. 导入检查（不加载权重）----
cd "$ZX/lipsync"
"$PY" -c "import diffusers, transformers, librosa, cv2, einops; from musetalk.utils.utils import load_all_model, datagen; from musetalk.utils.face_parsing import FaceParsing; print('imports ok', diffusers.__version__, transformers.__version__)"

set +x
date '+%F %T' > "$ZX/setup.ok"
echo "==== SETUP OK $(date '+%F %T')  下一步：bash $ZX/smoke_test.sh"
echo "$ENVK" > "$ZX/env.txt"
