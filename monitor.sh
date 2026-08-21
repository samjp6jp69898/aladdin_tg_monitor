#!/bin/zsh
# 手動啟停 tg-monitor。刻意用完整路徑比對行程，絕不用 `pkill -f "bun run server.ts"`
# （那會連 telegram-dispatcher 本體一起殺掉——2026-08-21 踩過）。
ENTRY=/Users/user/aladdin/tg-monitor/server.ts
case "${1:-}" in
  start)  cd /Users/user/aladdin/tg-monitor && (nohup /Users/user/.bun/bin/bun run "$ENTRY" >> data/server.out.log 2>&1 &) && sleep 1 && echo "http://127.0.0.1:${TG_MONITOR_PORT:-8799}" ;;
  stop)   pkill -f "bun run $ENTRY" && echo stopped || echo "not running" ;;
  status) pgrep -fl "bun run $ENTRY" || echo "not running" ;;
  *) echo "usage: $0 start|stop|status" ;;
esac
