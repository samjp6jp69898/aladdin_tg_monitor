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
#
# MON_READ_SOURCE（Phase 8，plan §8.1）：讀取面資料源 sqlite|mysql，預設 sqlite。
# 它與寫入面的 MON_DB_ENABLED **各自獨立**——讀取面可以在寫入面還關著時先切。
# 「回滾＝改 .env 一個字 + launchctl kickstart -k com.aladdin.tg-monitor」這顆
# 按鈕成立的前提就是這個 key 有被逐一匯出，漏了它 launchd 起的行程永遠讀不到。
set -u
TG_MONITOR_DIR="/Users/user/aladdin/tg-monitor"
ENV_FILE="$TG_MONITOR_DIR/.env"
BUN="/Users/user/.bun/bin/bun"

if [ -f "$ENV_FILE" ]; then
  for KEY in MON_DB_ENABLED MON_READ_SOURCE MON_DB_HOST MON_DB_PORT MON_DB_SCHEMA MON_DB_USER MON_DB_PASSWORD; do
    VALUE=$(grep "^${KEY}=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n')
    export "${KEY}=${VALUE}"
  done
fi

cd "$TG_MONITOR_DIR" || exit 1

# D48 啟動來源留痕（2026-09-03）：記下這次啟動是不是經由 scripts/safe-kickstart.sh。
# guard **只記錄、不阻擋**，理由見 scripts/kickstart-guard.sh 檔頭（KeepAlive=true 下
# 阻擋 = 無限 crash loop，而且擋在這一層本來就擋不住裸 kickstart）。
#
# 兩層隔離，缺一不可：
#   - `|| true`：guard 執行失敗（語法壞掉、git 不可用、log 寫不進去）不影響下面的 exec；
#   - 背景化：guard **卡住**也不影響 exec。fail-open 擋得住失敗，擋不住 hang。
# 而 guard 是獨立一支檔、不是寫在這裡的幾行：它自己壞掉時，壞的是一個被隔離的子行程，
# 不是這支「服務能不能起來」的腳本本身。一支為了保護部署而寫的東西若自己會讓服務起不來，
# 期望損失會高於它防的東西。
GUARD="$TG_MONITOR_DIR/scripts/kickstart-guard.sh"
[ -f "$GUARD" ] && { bash "$GUARD" & } || true

# exec 讓 bun 取代 shell 行程本身，launchd SIGTERM 才殺得到 bun（同 run-server.sh）。
exec "$BUN" run server.ts
