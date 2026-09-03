#!/bin/zsh
# launchd wrapper：每天跑一次 Phase 9 七天雙軌觀察（phase9-readiness.md §6，a7-D37）。
#
# 不像 run-monitor.sh 需要手動 export MON_DB_* 給常駐 server 行程：這裡是一次性
# 呼叫 `bun run scripts/dual-track-daily.ts`，Bun 對 cwd 下的 .env 有內建自動載入
# （已驗證：手動在 tg-monitor 目錄跑 switch-readiness.ts 不另外 export 也能連上
# 監控 DB），不需要重複 run-monitor.sh 的 grep/export 手法。
#
# 純觀察：本腳本不自動切換、不自動退役、不改任何資料（§6.4）——唯一的副作用是
# 對 telegram-dispatcher/logs/monitor-dual-track.log 的 append。
set -u
TG_MONITOR_DIR="/Users/user/aladdin/tg-monitor"
BUN="/Users/user/.bun/bin/bun"

cd "$TG_MONITOR_DIR" || exit 1
exec "$BUN" run scripts/dual-track-daily.ts
