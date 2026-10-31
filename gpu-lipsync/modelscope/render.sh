#!/usr/bin/env bash
# 批量渲染并打包。用法：
#   bash render.sh                 默认头像 xiaoxin × 37 句
#   bash render.sh all             25 套服装全部（925 段）
#   bash render.sh qipao,sailor    指定头像
# 可以随时 Ctrl+C，再次运行会跳过已渲染的视频。建议用 nohup 放后台：
#   nohup bash render.sh all > $ZX_WORK/render.out 2>&1 &
set -uo pipefail
ZX="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${ZX_WORK:-/mnt/workspace}"; export ZX_WORK="$WORK"
if [ "${ZX_ENV:-$(cat "$ZX/env.txt" 2>/dev/null)}" = colab ]; then PY="$(command -v python3)"; else PY="$ZX/venv/bin/python"; fi
"$PY" "$ZX/render.py" --avatars "${1:-xiaoxin}" "${@:2}"
rc=$?
"$PY" "$ZX/pack.py"
exit $rc
