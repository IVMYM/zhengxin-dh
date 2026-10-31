# 征信服务数字人 — 服务器镜像（linux/amd64 与 linux/arm64 通用）
# 密钥不进镜像：运行时通过 docker compose 的 env_file 注入。
FROM node:20-bookworm-slim

ARG EDGE_TTS_VERSION=7.3.1
ENV NODE_ENV=production PORT=43200 HOST=0.0.0.0 PYTHON=/usr/bin/python3 TRUST_PROXY=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl bzip2 tini \
 && pip3 install --no-cache-dir --break-system-packages "edge-tts==${EDGE_TTS_VERSION}" \
 && python3 -c "import edge_tts" \
 && apt-get purge -y python3-pip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /root/.cache

WORKDIR /app
COPY package.json ./
COPY scripts/fetch-asr.sh scripts/fetch-asr.sh
# 离线识别模型（浏览器端 WASM，与 CPU 架构无关）：构建时从 sherpa-onnx 官方 Release 下载
COPY public/asr/sherpa-onnx-asr.js public/asr/
RUN bash scripts/fetch-asr.sh && rm -rf /tmp/asr-dl && ls -la public/asr

COPY server.mjs ./
COPY lib lib
COPY config config
COPY scripts/tts_stream.py scripts/tts_stream.py
COPY public public
# 知识库话术的预合成语音（断网可播）放到种子目录，启动时补进可写的 cache 卷
COPY cache/tts /app/seed/tts
COPY deploy/entrypoint.sh /usr/local/bin/zx-entrypoint
RUN chmod +x /usr/local/bin/zx-entrypoint && mkdir -p /app/cache/tts /app/data && chown -R node:node /app/cache /app/data

USER node
EXPOSE 43200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:43200/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/zx-entrypoint"]
CMD ["node", "server.mjs"]
