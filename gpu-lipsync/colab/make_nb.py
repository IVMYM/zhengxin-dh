import nbformat as nbf
nb = nbf.v4.new_notebook()
C = []
def md(s): C.append(nbf.v4.new_markdown_cell(s.strip()))
def code(s): C.append(nbf.v4.new_code_cell(s.strip()))

md("""
# 征信数字人 · MuseTalk 口型离线预渲染（Google Colab 免费 GPU）

把知识库固定话术（37 句）× 头像渲染成带口型的视频，放回 Mac 项目的 `cache/lipsync/` 后页面会自动使用。

**用法**：先 `运行时 > 更改运行时类型 > T4 GPU`，再 `运行时 > 全部运行`；第 3 步弹出上传按钮时选 `ms-bundle.tar`。
- 勾选 Google Drive 后，模型（约 3.9GB）和渲染结果存在 `我的云端硬盘/zhengxin_lipsync`，断线重连后不用重下，渲染可续跑。
- 每一步都可以单独重跑；已完成的部分会自动跳过。
""")

md("## 1. 检查 GPU")
code(r"""
!nvidia-smi
import torch, numpy
print('torch', torch.__version__, '| CUDA', torch.version.cuda, '| numpy', numpy.__version__)
assert torch.cuda.is_available(), '没有 GPU：菜单 运行时 > 更改运行时类型 > 选 T4 GPU，保存后重新运行'
p = torch.cuda.get_device_properties(0)
print('GPU:', p.name, f'{p.total_memory / 2**30:.1f} GB')
""")

md("## 2. 工作目录（可选挂载 Google Drive，模型和结果断线后还在）")
code(r"""
import os
USE_DRIVE = True  #@param {type:"boolean"}
if USE_DRIVE:
    from google.colab import drive
    drive.mount('/content/drive')
    WORK = '/content/drive/MyDrive/zhengxin_lipsync'
else:
    WORK = '/content/zhengxin_lipsync'   # 会话结束就没了，记得及时下载结果
ZX = f'{WORK}/zx'
os.makedirs(WORK, exist_ok=True)
os.environ['ZX_WORK'] = WORK      # 脚本里的日志、输出、smoke.mp4 都写到这里
os.environ['ZX_ENV'] = 'colab'    # setup.sh 走 Colab 模式：不建 venv、不重装 torch、权重从 Hugging Face 下载
%cd {WORK}
print('工作目录:', WORK)
""")

md("## 3. 获取部署包 ms-bundle.tar（上传，或用 Drive 里已有的）")
code(r"""
import os, tarfile
FORCE_REUPLOAD = False  #@param {type:"boolean"}
tar_path = f'{WORK}/ms-bundle.tar'
if FORCE_REUPLOAD or not os.path.exists(tar_path):
    from google.colab import files
    print('请选择 ms-bundle.tar（约 26MB）')
    up = files.upload()
    name = next(n for n in up if n.endswith('.tar'))
    if os.path.abspath(name) != tar_path:
        with open(tar_path, 'wb') as f: f.write(up[name])
else:
    print('用已有的', tar_path)
# 解压到 WORK/zx；模型 models/ 和头像缓存 prepared.pt 不在包里，不会被覆盖
with tarfile.open(tar_path) as t:
    try: t.extractall(WORK, filter='data')
    except TypeError: t.extractall(WORK)
!ls -la "{ZX}"
""")

md("## 4. 安装依赖 + 下载模型权重（首次约 5–10 分钟，之后几十秒）")
code(r"""
import subprocess, sys
# 只补缺的包，torch / numpy 用 Colab 自带版本并钉死（不会降级 numpy，不需要重启运行时）
before = subprocess.run([sys.executable, '-c', 'import numpy, torch; print(numpy.__version__, torch.__version__)'], capture_output=True, text=True).stdout.strip()
!bash "{ZX}/setup.sh"
after = subprocess.run([sys.executable, '-c', 'import numpy, torch; print(numpy.__version__, torch.__version__)'], capture_output=True, text=True).stdout.strip()
print('numpy/torch 安装前:', before, '| 安装后:', after)
if before != after:
    print('⚠️ numpy 或 torch 版本变了：菜单 运行时 > 重启会话，然后从第 2 步重新运行（第 4 步会很快跳过）')
assert os.path.exists(f'{ZX}/setup.ok'), f'安装失败，看上面第一处 SETUP FAILED，完整日志 {WORK}/setup.log'
""")

md("## 5. 冒烟测试（fp16，T4 16GB 够用；生成 smoke.mp4 并在下面播放）")
code(r"""
!bash "{ZX}/smoke_test.sh"
from IPython.display import HTML
from base64 import b64encode
p = f'{WORK}/smoke.mp4'
if os.path.exists(p):
    HTML(f'<video width=360 controls src="data:video/mp4;base64,{b64encode(open(p, "rb").read()).decode()}"></video>')
else:
    print('没有生成 smoke.mp4，看上面的报错和', f'{WORK}/smoke.log')
""")
# HTML() as non-last expression won't display; fix below
C[-1] = nbf.v4.new_code_cell(r"""
!bash "{ZX}/smoke_test.sh"
from IPython.display import HTML, display
from base64 import b64encode
p = f'{WORK}/smoke.mp4'
if os.path.exists(p):
    display(HTML(f'<video width=360 controls src="data:video/mp4;base64,{b64encode(open(p, "rb").read()).decode()}"></video>'))
else:
    print('没有生成 smoke.mp4，看上面的报错和', f'{WORK}/smoke.log')
""".strip())

md("""
## 6. 批量渲染（可中断、可续跑）
默认头像 `xiaoxin` × 37 句；选 `all` 渲染 25 套服装（925 段，时间长，建议勾选 Drive）。也可以填逗号分隔的头像名，如 `qipao,sailor`。
中途断线或停止后，重新运行第 2、4 步和这一步即可，已渲染的视频会跳过。进度日志：`WORK/render.log`。
""")
code(r"""
AVATARS = "xiaoxin"  #@param ["xiaoxin", "all"] {allow-input: true}
!bash "{ZX}/render.sh" "{AVATARS}"
!ls -la "{WORK}"/out_*.tar
""")

md("## 7. 下载结果（out_001.tar …，每个 ≤190MB，都能单独解压）")
code(r"""
import glob
DOWNLOAD_TO_COMPUTER = True  #@param {type:"boolean"}
tars = sorted(glob.glob(f'{WORK}/out_*.tar'))
print('\n'.join(f'{t}  {os.path.getsize(t) / 1e6:.1f}MB' for t in tars) or '还没有结果包，先跑第 6 步')
if USE_DRIVE:
    print('这些文件已在 Google Drive：我的云端硬盘/zhengxin_lipsync/')
if DOWNLOAD_TO_COMPUTER:
    from google.colab import files
    for t in tars:
        files.download(t)   # 浏览器会逐个弹出下载；被拦截时允许本站“下载多个文件”
""")

md("""
## 8. 放回 Mac，用完关机
在 Mac 的项目目录 `zhengxin-dh` 里：
```bash
mkdir -p cache/lipsync && for f in ~/Downloads/out_*.tar; do tar -xf "$f" -C cache/lipsync; done
```
重启 `node server.mjs`，页面发现 `cache/lipsync/<头像>-full1/` 下有视频就自动用口型播放。

用完：菜单 `运行时 > 断开连接并删除运行时`，免得占用免费额度。
""")

nb.cells = C
nb.metadata = {
    'accelerator': 'GPU',
    'colab': {'provenance': [], 'gpuType': 'T4', 'name': 'zhengxin_musetalk_colab.ipynb'},
    'kernelspec': {'name': 'python3', 'display_name': 'Python 3'},
    'language_info': {'name': 'python'},
}
nbf.validate(nb)
nbf.write(nb, '/workspace/colab/zhengxin_musetalk_colab.ipynb')
print('cells', len(nb.cells))
