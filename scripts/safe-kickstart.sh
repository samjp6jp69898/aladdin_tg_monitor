#!/bin/bash
# safe-kickstart.sh — 重啟 tg-monitor 前的工作樹把關與紀錄
#
#   bash scripts/safe-kickstart.sh --mine server.ts --mine frontend/src/App.tsx
#   bash scripts/safe-kickstart.sh --dry-run          # 只檢查，絕不重啟
#   bash scripts/safe-kickstart.sh --force            # 明知有未宣告改動仍重啟（留紀錄）
#
# ── 為什麼需要這支 ───────────────────────────────────────────────────────────
# tg-monitor 的部署 = 工作樹：`launchctl kickstart` 會把**當下工作樹**的程式碼載進
# 常駐服務，包含所有未 commit 的改動。多個 session 並行時，這代表你為了驗自己的改動
# 隨手重啟，會把別人寫到一半的碼一起送上 live——而且**重啟者與被改動者雙方都不會知道**。
#
# 這是一種沒有觀察者的失敗：不像測試會紅、不像 lint 會叫，它完全沒有輸出可供檢查。
# 2026-09-02 實例：有 session 為了驗自己的路由改動重啟兩次，第二次載進了另一人未提交的
# lib/cluster-state.ts 與 lib/ingest.ts。沒出事純屬那些改動剛好是完整的。
#
# ── 設計上的取捨（重要）─────────────────────────────────────────────────────
# 腳本**無法自己判斷檔案屬於誰**——git 不記錄「哪個 session 改的」，mtime 也不可靠。
# 所以本腳本不猜，改為要求操作者用 `--mine` 明確宣告自己的改動；**任何未被宣告的
# 未提交改動一律擋下**。把判斷交還給唯一知道答案的人，並讓那個判斷留下痕跡。
#
# ── `--mine` 全部宣告完（工作樹只剩自己的改動）為何放行 ──────────────────────
# 這一格刻意放行。要防的是「不知情地部署別人的半成品」，不是「部署自己未提交的碼」——
# 後者正是開發中驗證改動的正常動作，擋掉它等於要求每次驗證都先 commit，那會逼出更糟的
# 習慣（為了重啟而 commit 半成品）。宣告的動作本身就達成了目的：你看過清單、你知道
# 現在要送上 live 的是什麼。
#
# ── 紀錄 ────────────────────────────────────────────────────────────────────
# 每次重啟都追加一行到 data/kickstart.log（data/ 已 gitignore）：時間、HEAD sha、
# 宣告的檔案、未宣告的檔案、是否 --force。原本這件事完全沒有紀錄，這是它有紀錄的第一步。
#
# 本腳本只做「重啟前把關」與「留紀錄」，不做重啟後的健康檢查——那是
# telegram-dispatcher/deploy/doctor-monitor.sh 的職責，重啟後請自行跑它。

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE='com.aladdin.tg-monitor'
LOG="${REPO}/data/kickstart.log"

DRY_RUN=0
FORCE=0
MINE=()

while [ $# -gt 0 ]; do
  case "$1" in
    --mine)    shift; [ $# -gt 0 ] || { echo "--mine 後面要接檔案路徑"; exit 2; }; MINE+=("$1") ;;
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)         echo "未知參數：$1"; exit 2 ;;
  esac
  shift
done

cd "${REPO}" || exit 2

DECLARED=()
UNDECLARED=()
while IFS= read -r line; do
  [ -n "${line}" ] || continue
  path="${line:3}"
  hit=0
  for m in ${MINE+"${MINE[@]}"}; do
    [ "${m}" = "${path}" ] && hit=1 && break
  done
  if [ "${hit}" = "1" ]; then DECLARED+=("${path}"); else UNDECLARED+=("${path}"); fi
done < <(git status --porcelain)

HEAD_SHA="$(git rev-parse --short HEAD)"
echo "tg-monitor 重啟前檢查"
echo "  HEAD: ${HEAD_SHA}"
echo "  已宣告為自己的未提交改動: ${#DECLARED[@]} 個"
for f in ${DECLARED+"${DECLARED[@]}"}; do echo "    + ${f}"; done
echo "  未宣告的未提交改動: ${#UNDECLARED[@]} 個"
for f in ${UNDECLARED+"${UNDECLARED[@]}"}; do echo "    ! ${f}"; done

if [ "${#UNDECLARED[@]}" -gt 0 ] && [ "${FORCE}" = "0" ]; then
  echo ""
  echo "RESULT: BLOCKED — 上列 ${#UNDECLARED[@]} 個未提交改動不是你宣告的，重啟會把它們一起送上 live。"
  echo "  確認歸屬後，若確定可以載入：用 --mine <path> 逐一宣告，或 --force（會留紀錄）。"
  exit 1
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo ""
  echo "RESULT: DRY_RUN — 檢查通過，未重啟。"
  exit 0
fi

if [ "${#UNDECLARED[@]}" -gt 0 ]; then
  echo ""
  echo "⚠️  --force：明知有 ${#UNDECLARED[@]} 個未宣告改動仍重啟，已記入 ${LOG}"
fi

mkdir -p "$(dirname "${LOG}")"
printf '%s | head=%s | declared=%s | undeclared=%s | force=%s\n' \
  "$(date '+%Y-%m-%d %H:%M:%S')" "${HEAD_SHA}" \
  "$(IFS=,; echo "${DECLARED[*]-}")" "$(IFS=,; echo "${UNDECLARED[*]-}")" "${FORCE}" >> "${LOG}"

launchctl kickstart -k "gui/$(id -u)/${SERVICE}" || { echo "RESULT: FAILED — kickstart 失敗"; exit 1; }
echo ""
echo "RESULT: RESTARTED — 已重啟，紀錄寫入 ${LOG}"
echo "  重啟後健康檢查請跑 telegram-dispatcher/deploy/doctor-monitor.sh（本腳本不代勞）"
