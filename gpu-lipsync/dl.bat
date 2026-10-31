@echo off
rem 下载 MuseTalk 1.5 及依赖模型（经 hf-mirror.com），约 3.9GB
set M=D:\lipsync\models
mkdir %M%\musetalkV15 %M%\sd-vae %M%\whisper %M%\face-parse-bisent 2>nul
set H=https://hf-mirror.com
curl -sSL --retry 5 -C - -o %M%\musetalkV15\musetalk.json %H%/TMElyralab/MuseTalk/resolve/main/musetalkV15/musetalk.json
curl -sSL --retry 5 -o %M%\sd-vae\config.json %H%/stabilityai/sd-vae-ft-mse/resolve/main/config.json
curl -sSL --retry 5 -C - -o %M%\sd-vae\diffusion_pytorch_model.bin %H%/stabilityai/sd-vae-ft-mse/resolve/main/diffusion_pytorch_model.bin
for %%f in (config.json pytorch_model.bin preprocessor_config.json) do curl -sSL --retry 5 -C - -o %M%\whisper\%%f %H%/openai/whisper-tiny/resolve/main/%%f
for %%f in (79999_iter.pth resnet18-5c106cde.pth) do curl -sSL --retry 5 -C - -o %M%\face-parse-bisent\%%f %H%/ManyOtherFunctions/face-parse-bisent/resolve/main/%%f
curl -sSL --retry 10 -C - -o %M%\musetalkV15\unet.pth %H%/TMElyralab/MuseTalk/resolve/main/musetalkV15/unet.pth
echo DLDONE > D:\lipsync\dl.done
