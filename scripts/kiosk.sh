#!/usr/bin/env bash
# Linux 展厅一体机：全屏启动（自动允许麦克风与自动播放，隐藏鼠标）
URL=${1:-http://localhost:43200/?kiosk=1}
CHROME=${CHROME:-google-chrome}
exec "$CHROME" --kiosk --app="$URL" --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --disable-features=Translate --overscroll-history-navigation=0 --no-first-run --user-data-dir="$HOME/.zhengxin-kiosk"
