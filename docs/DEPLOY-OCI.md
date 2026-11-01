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
- 只有直连地址在 `TRUSTED_PROXIES` 里（默认 127.0.0.1、::1；Docker 部署时为 compose 网络网关）时，才采用代理传来的 `X-Real-IP` / `X-Forwarded-For` 最右一项，其他来源自带的转发头一律忽略，防止伪造绕过限流。
- 对公网开放后，建议去掉 Tailscale 地址上的直连端口（`.env` 设 `TS_BIND_IP=127.0.0.1`、`TS_BIND_PORT=43201`），tailnet 内改用 `tailscale serve` 的 HTTPS 地址；否则经 Docker 转发的直连请求也显示为网关地址，可伪造来源头。

## HTTPS 与麦克风

浏览器只在 HTTPS 或 localhost 下开放麦克风。只在 tailnet 内使用时可用：

```bash
sudo tailscale serve --bg --https=10443 http://127.0.0.1:43200
# 访问 https://<机器名>.<tailnet>.ts.net:10443
```

对公网开放：用 `deploy/nginx/zhengxin-dh.conf.template` 配 nginx HTTPS 反向代理到 `127.0.0.1:43200`（支持 SSE），certbot webroot 申请证书，`nginx -t` 后 `systemctl reload nginx`。

当前 OCI 实例：`https://dighum.liuyuan.kdns.fr`。该机 443 由 `/etc/nginx/stream.d/sing-box-sni.conf` 按 SNI 分流，本站走本地 TLS 后端 `127.0.0.1:9460`（模板 B 布局）；证书 `/etc/letsencrypt/live/dighum.liuyuan.kdns.fr`，由 certbot.timer 自动续期，续期后 reload nginx。

## 运维

```bash
docker logs -f zhengxin-dh
docker compose -f deploy/docker-compose.yml --env-file .env restart
git pull && bash deploy/server-up.sh      # 升级
```

开机时如果 Docker 先于 Tailscale 启动，绑定 Tailscale 地址可能失败；`restart: unless-stopped` 会自动重试，必要时执行一次 `docker start zhengxin-dh`。

## 智能体工具（大模型自动调用）

| 工具 | 作用 | 数据来源 |
|---|---|---|
| `get_time` | 北京时间、星期、本周与未来 7 天日期 | 本地计算 |
| `get_weather` | 今天/明天/后天天气 | Open-Meteo（免密钥），默认城市预热、10 分钟缓存 |
| `branch_info` | 网点名称、地址、电话、营业时间、可办业务 | `data/branch.json`（服务器上为 `runtime/data/branch.json`），模板 `config/branch.example.json`；留空的项回答“以网点公示为准” |
| `search_knowledge` | 征信审定口径 | 内置知识库 |
| `web_search` | 新闻、近期事件、知识库以外的常识（征信、天气、网点及荐股/政治/医疗/征信修复等不搜） | Tavily（`TAVILY_API_KEY`，只在服务端 `.env`）；10 分钟缓存；每日上限 `WEB_SEARCH_DAILY_LIMIT`（默认 30，计数在 `data/websearch-usage.json`）；超时 `WEB_SEARCH_TIMEOUT_MS`（默认 3500） |

- 天气、网点信息类问题先按关键词预取再交给模型（一次往返）；其余由模型通过原生 `tools` 决定，最多 2 轮。任一环节失败回落知识库或工具自带口径。
- 环境变量：`WEATHER_CITY`（覆盖网点城市）、`AGENT_TOOLS=0`（关闭工具）、`TOOL_TIMEOUT_MS`（默认 3000）。
- 改 `branch.json` 后无需重启。
- 联网搜索较慢（1~3 秒），调用时先说一句“我帮您查一下网上的公开信息。”；超额度、超时或出错时说“暂时没查到可靠信息，建议以官方渠道发布为准”。
