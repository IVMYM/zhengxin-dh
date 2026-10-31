#!/usr/bin/env bash
# 在服务器上构建并启动（可重复运行）。用法：cd ~/zhengxin-dh && bash deploy/server-up.sh
# - .env（chmod 600）里放 LLM_* 与 ADMIN_PASSWORD；没有 ADMIN_PASSWORD 时自动生成（不打印）
# - 只绑定 127.0.0.1 与 TS_BIND_IP（默认取本机 Tailscale IPv4），不绑定 0.0.0.0
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
touch .env && chmod 600 .env

if ! grep -q '^ADMIN_PASSWORD=.\+' .env; then
  printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-24)" >> .env
  echo "已生成管理端密码，写入 $(pwd)/.env（ADMIN_PASSWORD，未打印）"
fi
if ! grep -q '^TS_BIND_IP=' .env; then
  TSIP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  printf 'TS_BIND_IP=%s\nTS_BIND_PORT=43200\n' "${TSIP:-127.0.0.1}" >> .env
fi

grep -q '^APP_UID=' .env || printf 'APP_UID=%s\nAPP_GID=%s\n' "$(id -u)" "$(id -g)" >> .env

# 端口检查：43200 若已被别的程序占用（不是本容器）则停止
if ss -ltnH | awk '{print $4}' | grep -Eq '[:.]43200$'; then
  if ! docker ps --format '{{.Names}}' | grep -qx zhengxin-dh; then
    echo "端口 43200 已被其他程序占用，停止部署"; ss -ltnp | grep 43200 || true; exit 1
  fi
fi

mkdir -p runtime/data runtime/cache cache/tts   # cache/tts：预合成语音（不入库，可从已有环境拷贝）
umask 022
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
# 受信任代理 = compose 网络网关（nginx / tailscale serve 经 Docker 端口转发后显示为该地址）
GW="$(docker network inspect zhengxin-dh_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
if [ -n "$GW" ] && ! grep -q "^TRUSTED_PROXIES=.*$GW" .env; then
  sed -i '/^TRUSTED_PROXIES=/d' .env && printf 'TRUSTED_PROXIES=127.0.0.1,::1,%s\n' "$GW" >> .env
  docker compose -f deploy/docker-compose.yml --env-file .env up -d
fi
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:43200/api/health >/dev/null 2>&1; then echo "健康检查通过"; break; fi
  sleep 2
done
docker ps --filter name=^zhengxin-dh$ --format '{{.Names}} {{.Status}} {{.Ports}}'
