@echo off
REM Windows 展厅一体机：全屏启动（Chrome 或 Edge 均可，按实际安装路径修改）
set URL=http://localhost:43200/?kiosk=1
set BROWSER="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %BROWSER% set BROWSER="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
start "" %BROWSER% --kiosk %URL% --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream --noerrdialogs --disable-infobars --disable-session-crashed-bubble --no-first-run --user-data-dir=%USERPROFILE%\.zhengxin-kiosk
