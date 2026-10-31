# Google Colab：MuseTalk 口型离线预渲染

和魔搭用同一个部署包 `ms-bundle.tar`（脚本在 `../modelscope/`），笔记本设置 `ZX_ENV=colab`、`ZX_WORK=<工作目录>` 切换到 Colab 模式：
不建 venv、不重装 torch/numpy（沿用 Colab 自带版本并钉死），只补缺的包；权重从 Hugging Face 直连下载（sha256 与魔搭一致）。

## 步骤
1. 打开 https://colab.research.google.com ，菜单 **文件 > 上传笔记本**，选 `zhengxin_musetalk_colab.ipynb`。
2. **运行时 > 更改运行时类型 > T4 GPU**，保存。
3. **运行时 > 全部运行**。
   - 第 2 步弹出 Google Drive 授权，同意（不想用 Drive 就把 `USE_DRIVE` 取消勾选，结果只在本次会话里）。
   - 第 3 步出现「选择文件」按钮，选 `ms-bundle.tar`（约 26MB）。Drive 里已有就自动跳过。
4. 第 5 步下面会播放 `smoke.mp4`，看一眼嘴型对不对。
5. 第 6 步默认渲染 `xiaoxin` × 37 句；要 25 套全部，把 `AVATARS` 改成 `all` 再运行这一格。断线后重新运行第 2、4、6 步即可续跑。
6. 结果 `out_001.tar …` 在 Drive 的 `我的云端硬盘/zhengxin_lipsync/`，第 7 步也会逐个下载到电脑。
7. 在 Mac 项目目录：`mkdir -p cache/lipsync && for f in ~/Downloads/out_*.tar; do tar -xf "$f" -C cache/lipsync; done`，重启 `node server.mjs`。
8. 用完：**运行时 > 断开连接并删除运行时**。

`make_nb.py` 用来重新生成笔记本（需要 `pip install nbformat`）。
