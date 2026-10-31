#!/usr/bin/env bash
# macOS：用独立的 Chrome 配置全屏启动（自动允许麦克风与自动播放，开机即可语音唤醒，无需点屏幕）
# 首次运行时 macOS 会询问“Google Chrome 想访问麦克风”，请点“允许”。
URL=${1:-http://localhost:43200/?kiosk=1}
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
exec "$CHROME" --kiosk --app="$URL" --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --disable-features=Translate --overscroll-history-navigation=0 --no-first-run \
  --user-data-dir="$HOME/.zhengxin-kiosk" >/dev/null 2>&1
