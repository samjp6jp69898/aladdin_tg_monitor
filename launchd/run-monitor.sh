#!/bin/zsh
# launchd wrapper：啟動 tg-monitor（只綁 127.0.0.1:8799）。
# 環境變數讀取手法比照 telegram-dispatcher/launchd/run-server.sh：
# grep '^KEY=' 從 tg-monitor 自己的 .env 逐一匯出，不用 dotenv、
# token/密碼不出現在這支腳本或 plist 明文裡。
#
# pipeline 監控 DB 化（2026-09-02，Phase 0 補完 BL-C2）：tg-monitor 用
# mon_ui 帳號（唯讀 + runs 欄位級 cancel 寫入），不給任何欄位加密金鑰
# （見 telegram-dispatcher/deploy/monitor-db/README.md）。全部 5 個 key
# 皆非必要變數，缺了／MON_DB_ENABLED 非 '1' 一律視同監控 DB 功能關閉，
# 不擋伺服器啟動、行為與遷移前相同。
set -u
TG_MONITOR_DIR="/Users/user/aladdin/tg-monitor"
ENV_FILE="$TG_MONITOR_DIR/.env"
BUN="/Users/user/.bun/bin/bun"

if [ -f "$ENV_FILE" ]; then
  for KEY in MON_DB_ENABLED MON_DB_HOST MON_DB_PORT MON_DB_SCHEMA MON_DB_USER MON_DB_PASSWORD; do
    VALUE=$(grep "^${KEY}=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
    export "${KEY}=${VALUE}"
  done
fi

cd "$TG_MONITOR_DIR" || exit 1

# exec 讓 bun 取代 shell 行程本身，launchd SIGTERM 才殺得到 bun（同 run-server.sh）。
exec "$BUN" run server.ts
