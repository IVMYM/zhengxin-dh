# 服务器部署（Docker，含 OCI arm64）

镜像同时支持 `linux/arm64` 与 `linux/amd64`，在目标服务器上直接构建即可。

## 组成

| 内容 | 来源 | 位置 |
|---|---|---|
| 程序（Node，无第三方依赖） | 仓库 | 镜像 `/app` |
| edge-tts（Python） | 构建时 `pip install edge-tts==7.3.1` | 镜像 |
| 离线语音识别模型（sherpa-onnx WASM，约 210MB，在浏览器端运行，与 CPU 架构无关） | 构建时 `scripts/fetch-asr.sh` 下载 | 镜像 `public/asr` |
| 预合成语音（知识库话术、播放单） | 构建上下文 `cache/tts`（不入库，从已有环境拷贝；没有也能运行，可用 `npm run prewarm` 生成） | 镜像种子目录，启动时补入 `runtime/cache` |
| 播放单 | `runtime/data/playlist.json` | 卷挂载 |
| 密钥与管理密码 | `.env`（chmod 600） | 只通过 `env_file` 注入，不进镜像、不发给前端 |

## 步骤

```bash
git clone https://github.com/IVMYM/zhengxin-dh.git ~/zhengxin-dh
cd ~/zhengxin-dh
# 1) 把 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 写进 .env（chmod 600，不要回显）
# 2) 可选：拷入已有的 cache/tts 与 runtime/data/playlist.json
bash deploy/server-up.sh
```

`deploy/server-up.sh` 可重复执行：

- `.env` 没有 `ADMIN_PASSWORD` 时生成随机密码写入（不打印），查看需登录服务器读取该文件；
- `TS_BIND_IP` 默认取 `tailscale ip -4`，容器端口只绑定 `127.0.0.1:43200` 与 `TS_BIND_IP:43200`，不绑定 `0.0.0.0`；
- 43200 被其他程序占用时直接退出，不影响已有服务；
- 构建并启动容器 `zhengxin-dh`（`restart: unless-stopped`），等待 `/api/health`。

## 安全

- 设置 `ADMIN_PASSWORD` 后，播放单的所有写操作（增删改、排序、导入、合成、播放控制）都需先在控制面板登录；登录态是 12 小时的 HttpOnly + SameSite=Strict 签名 Cookie。展厅屏只可汇报「当前条目播完」。
- 限流（每个 IP、每分钟）：对话 `RATE_CHAT_PER_MIN`（默认 30），语音合成未命中缓存 `RATE_TTS_PER_MIN`（默认 120），登录 10 次 / 10 分钟。
- 经 Docker 端口转发后，容器看到的来源地址可能是网关地址，此时限流相当于全局限流；放在反向代理后面时设置 `TRUST_PROXY=1`（镜像默认）并让代理传 `X-Forwarded-For`。

## HTTPS 与麦克风

浏览器只在 HTTPS 或 localhost 下开放麦克风。只在 tailnet 内使用时可用：

```bash
sudo tailscale serve --bg --https=10443 http://127.0.0.1:43200
# 访问 https://<机器名>.<tailnet>.ts.net:10443
```

对公网开放需另行决定域名，并用 nginx（或 Caddy）配置 HTTPS 反向代理到 `127.0.0.1:43200`，同时放通防火墙 / 安全列表端口。

## 运维

```bash
docker logs -f zhengxin-dh
docker compose -f deploy/docker-compose.yml --env-file .env restart
git pull && bash deploy/server-up.sh      # 升级
```

开机时如果 Docker 先于 Tailscale 启动，绑定 Tailscale 地址可能失败；`restart: unless-stopped` 会自动重试，必要时执行一次 `docker start zhengxin-dh`。
