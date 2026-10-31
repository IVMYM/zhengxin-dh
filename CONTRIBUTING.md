# 参与贡献

感谢关注本项目！欢迎提交 Issue 和 Pull Request。

## 开发流程

1. Fork 后新建分支：`git checkout -b feat/xxx`
2. 安装：`npm install`（仅开发依赖 playwright-core）；Python 3 + `pip install edge-tts`
3. 运行：`npm run dev`，浏览器打开 http://localhost:43200
4. 提交前：`npm test` 全部通过；改了界面请附截图（`npm run check:layout` / `check:fullscreen` 可生成）
5. 提交信息用中文或英文均可，一句话说清改了什么、为什么

## 约定

- 前端是原生 JS，无构建步骤；服务端只用 Node 内置模块
- 话术、口径类改动请注明依据（如《征信业管理条例》条款），不要写入未经核实的费用、时限等数字
- **不要提交任何密钥**：`.env`、`.dev.vars` 已被忽略；示例配置写进 `.env.example`，只放占位符
- 不要提交真实客户信息、身份证号、手机号；示例数据一律打码（张*、138****5678）
- 大文件（>10MB）不要直接入库：离线识别模型用 `scripts/fetch-asr.sh` 下载，MuseTalk 权重由 GPU 端脚本下载

## 报告问题

请附：操作系统与浏览器版本、复现步骤、浏览器控制台中 `[语音]` / `[tts]` / `[llm]` 开头的日志（注意先删去任何密钥）。
