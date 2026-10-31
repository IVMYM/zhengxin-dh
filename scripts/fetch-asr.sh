#!/usr/bin/env bash
# 下载 sherpa-onnx 中英双语流式识别模型（WebAssembly 版，约 180MB），放到 public/asr/
set -euo pipefail
cd "$(dirname "$0")/.."
VER=v1.13.7
NAME=sherpa-onnx-wasm-simd-${VER}-zh-en-asr-zipformer
URL=${ASR_URL:-https://github.com/k2-fsa/sherpa-onnx/releases/download/${VER}/${NAME}.tar.bz2}
mkdir -p public/asr /tmp/asr-dl
curl -L --fail -o /tmp/asr-dl/asr.tar.bz2 "$URL"
python3 -c "import tarfile;tarfile.open('/tmp/asr-dl/asr.tar.bz2','r:bz2').extractall('/tmp/asr-dl')"
cp /tmp/asr-dl/${NAME}/sherpa-onnx-asr.js /tmp/asr-dl/${NAME}/sherpa-onnx-wasm-main-asr.* public/asr/
echo "完成：$(ls public/asr)"
