#!/bin/zsh
# launchd wrapper：啟動 tg-monitor（只綁 127.0.0.1:8799）。
set -u
cd /Users/user/aladdin/tg-monitor || exit 1
exec /Users/user/.bun/bin/bun run /Users/user/aladdin/tg-monitor/server.ts
