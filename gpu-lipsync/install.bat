@echo off
rem 在 GPU 机（Windows + NVIDIA）上安装口型同步服务：把本目录内容放到 D:\lipsync 后以管理员身份运行
cd /d D:\lipsync
if not exist venv D:\Python312\python.exe -m venv venv
set PIP=-i https://pypi.tuna.tsinghua.edu.cn/simple
venv\Scripts\python -m pip install %PIP% --find-links D:\wheels torch==2.6.0+cu124 torchvision==0.21.0+cu124
venv\Scripts\python -m pip install %PIP% "numpy<2" diffusers==0.30.2 transformers==4.39.2 accelerate==0.28.0 huggingface_hub==0.25.2 opencv-python-headless librosa soundfile einops omegaconf fastapi uvicorn python-multipart
if not exist models\musetalkV15\unet.pth call dl.bat
rem 开机自启（SYSTEM 账户，不需要登录）
schtasks /Create /F /TN ZhengxinLipsync /SC ONSTART /RU SYSTEM /TR "D:\lipsync\start.bat"
rem 只放行 Tailscale 网段访问 8787
netsh advfirewall firewall add rule name="Zhengxin Lipsync 8787" dir=in action=allow protocol=TCP localport=8787 remoteip=100.64.0.0/10
schtasks /Run /TN ZhengxinLipsync
