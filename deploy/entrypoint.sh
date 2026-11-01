#!/bin/sh
# 把镜像里附带的预合成语音补进 cache 卷（已有的不覆盖），然后启动服务
set -e
mkdir -p /app/cache/tts /app/data
cp -rn /app/seed/tts/. /app/cache/tts/ 2>/dev/null || true
exec "$@"
