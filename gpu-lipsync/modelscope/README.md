# MuseTalk 离线预渲染口型视频（魔搭 Notebook / Google Colab）

## 上传
在 WebIDE 左侧的资源管理器里打开 `/mnt/workspace`，把 `ms-bundle.tar`（约 27MB）右键上传或拖进去。
`ms-faceparse.tar`（约 100MB）**只在 setup 报 hf-mirror 下载人脸分割模型失败时**才需要上传。

## 终端里依次执行
```bash
cd /mnt/workspace && tar -xf ms-bundle.tar          # 解压到 /mnt/workspace/zx
bash zx/setup.sh                                     # 装依赖 + 下模型（约 3.9GB），日志 /mnt/workspace/setup.log；出错会停在第一处并打印失败的命令
bash zx/smoke_test.sh                                # 打印 PASS/FAIL，生成 /mnt/workspace/smoke.mp4，先下载看一眼嘴型
nohup bash zx/render.sh xiaoxin > /mnt/workspace/render.out 2>&1 &   # 默认头像 × 37 句
tail -f /mnt/workspace/render.log                    # 看进度（Ctrl+C 只退出查看，不影响渲染）
```
全部 25 套服装：`nohup bash zx/render.sh all > /mnt/workspace/render.out 2>&1 &`（已渲染的会跳过）。
只想重新打包：`zx/venv/bin/python zx/pack.py`。

渲染结束会生成 `/mnt/workspace/out_001.tar`、`out_002.tar`…（每个 ≤190MB，都能单独解压），在资源管理器里右键下载。

## 放回 Mac
在项目目录 `zhengxin-dh` 里：
```bash
mkdir -p cache/lipsync && for f in ~/Downloads/out_*.tar; do tar -xf "$f" -C cache/lipsync; done
```
重启 `node server.mjs`。页面发现 `cache/lipsync/<头像>-full1/` 下有视频就会自动启用口型播放；没有视频的句子（例如大模型实时回答）照旧用循环说话视频。

## 说明
- setup 先测镜像自带的 torch 能不能用 GPU（驱动 550 只支持到 CUDA 12.4）。能用就沿用；不能用就在 `zx/venv` 里装 torch 2.6.0+cu124（阿里云 pytorch-wheels）和之前验证过的 diffusers 0.30.2 / transformers 4.39.2。可用 `ZX_TORCH=cu124 bash zx/setup.sh` 强制走后一种。
- 虚拟环境和模型都在 `/mnt/workspace/zx` 下，实例重启后不用重装，直接从 smoke_test 开始。
- MuseTalk 代码已在 `zx/lipsync/musetalk`（不需要 GitHub）。头像的人脸框已预先算好（coords.json），不需要 mmpose / dwpose。
- 用完记得在 Notebook 页面点「Close」关机，否则一直扣 GPU 时长。

## Google Colab（免费 T4）
用仓库里的 `gpu-lipsync/colab/zhengxin_musetalk_colab.ipynb`：Colab 菜单 文件 > 上传笔记本，运行时 > 更改运行时类型 > T4 GPU，运行时 > 全部运行，提示时上传本包。
脚本同一份，靠环境变量切换：`ZX_ENV=colab`（不建 venv、沿用 Colab 自带 torch/numpy、只补缺的包、权重从 Hugging Face 直连下载，sha256 与魔搭相同），`ZX_WORK=<工作目录>`（日志/输出/smoke.mp4 的位置，默认 `/mnt/workspace`）。
手动等价命令：
```bash
export ZX_ENV=colab ZX_WORK=/content/drive/MyDrive/zhengxin_lipsync
tar -xf ms-bundle.tar -C "$ZX_WORK" && bash "$ZX_WORK/zx/setup.sh" && bash "$ZX_WORK/zx/smoke_test.sh" && bash "$ZX_WORK/zx/render.sh" xiaoxin
```
