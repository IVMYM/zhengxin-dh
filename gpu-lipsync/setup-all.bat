@echo off
rem 一次性部署（可重复运行）：拉模型→核对→装服务→开机自启→防火墙→关闭睡眠和网卡节能。日志 D:\lipsync\setup.log
cd /d D:\lipsync
echo ==== %date% %time% setup start
rem Tailscale 直连：放行 UDP 41641 入站
netsh advfirewall firewall delete rule name="Tailscale UDP 41641" >nul 2>&1
netsh advfirewall firewall add rule name="Tailscale UDP 41641" dir=in action=allow protocol=UDP localport=41641
rem 关闭睡眠/休眠（接通电源时）
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
rem 网卡节能：关闭“允许计算机关闭此设备以节约电源”
powershell -NoProfile -Command "Get-NetAdapter -Physical | ForEach-Object { try { Disable-NetAdapterPowerManagement -Name $_.Name -NoRestart -ErrorAction Stop; 'NIC PM off: ' + $_.Name } catch { 'NIC PM skip: ' + $_.Name } }"
if "%MODEL_MIRROR%"=="" (echo 请先 set MODEL_MIRROR=http://^<模型镜像主机^>:^<端口^> & exit /b 1)
venv\Scripts\python.exe fetch_models.py %MODEL_MIRROR% || (echo MODELS_FAILED & exit /b 1)
rem 口型服务：开机自启（SYSTEM，不需要登录）
schtasks /Create /F /TN ZhengxinLipsync /SC ONSTART /RU SYSTEM /TR "D:\lipsync\start.bat"
netsh advfirewall firewall delete rule name="Zhengxin Lipsync 8787" >nul 2>&1
netsh advfirewall firewall add rule name="Zhengxin Lipsync 8787" dir=in action=allow protocol=TCP localport=8787 remoteip=100.64.0.0/10
schtasks /End /TN ZhengxinLipsync >nul 2>&1
schtasks /Run /TN ZhengxinLipsync
echo ==== %date% %time% setup done
