#!/bin/bash
# kickstart-guard.sh — 服務每次啟動時，記下「這次是誰起的、當下工作樹長什麼樣」。
# 由 launchd/run-monitor.sh 在 exec 之前以背景子行程呼叫。
#
# ── 這支**只記錄，不阻擋**，而且是刻意的 ─────────────────────────────────────
# D48 原本的目標是讓裸 `launchctl kickstart` 不可能繞過 safe-kickstart.sh。
# **那個目標在這一層結構上做不到**，理由有三條，第三條是決定性的：
#
#   1. plist 是 KeepAlive=true。guard 若在判定不通過時中止啟動，launchd 會立刻重啟、
#      再被擋、再重啟——變成無限 crash loop，形狀跟 2026-09-02 那次
#      CLUSTER_WORKER_NAME 事故一樣。用一個為了防事故而寫的東西重現同一種事故。
#   2. 觸發條件是常態不是異常。「工作樹有未宣告的未提交改動」在多 session 並行開發時
#      隨時成立，阻擋型等於宣告：只要有人手上有未提交的檔，tg-monitor 就不准啟動。
#      用「監控整個停擺」換「可能載進別人半成品」，期望損失的方向是反的——半成品被載
#      進去多半沒事，監控死掉則是我們用來看見所有其他事情的那隻眼睛。
#   3. **能真正擋下裸 kickstart 的位置是人打指令的那一刻，不是行程啟動之後。**
#      `kickstart -k` 的 -k 就是先 kill；等這支跑起來，服務早就被殺掉了。在這一層擋，
#      只是把繞過的**後果**從「載進別人的碼」換成「服務起不來」，繞過本身完全沒被阻止。
#
# 所以達成的是「裸 kickstart 不可能**無聲**繞過」，不是「不可能繞過」。這兩件事差很多，
# 不要在文件或台帳裡把後者記成前者——那會讓下一個人以為只要更努力就能在這一層做到。
#
# ── 一個 fail-open 卻被叫做 guard 的東西，比沒有 guard 更糟 ──────────────────
# 因為它會讓人以為那個位置有防護。所以本檔的實作與敘述嚴格一致：呼叫端用
# `|| true` 加背景化包住整個呼叫，**它在結構上就不可能擋下任何東西**。
# 沒有中間態，沒有「看起來像會擋」。
#
# 痕跡寫在 data/kickstart.log（data/ 已 gitignore），與 safe-kickstart.sh 自己那行並存，
# 用第二欄 `start` 區分。寫下的痕跡由 telegram-dispatcher/deploy/doctor-monitor.sh
# 第 12 節讀出來判 WARN——沒有人讀的 log 仍然是一種沒有觀察者的失敗。

# 覆寫用的環境變數只為了讓這支能被實際測到：guard 的全部行為都繞著「某個 repo 的
# 工作樹狀態」轉，路徑寫死就只能對著正式的 repo 與正式的 log 跑測試，測試會污染稽核
# 紀錄、也造不出「git 不可用」這種格。正式路徑上沒有人會設它。
REPO="${KICKSTART_GUARD_REPO:-/Users/user/aladdin/tg-monitor}"
LOG="${REPO}/data/kickstart.log"
# safe-kickstart.sh 在呼叫 launchctl 前放這個 marker，本腳本讀完即刪。
# 它不帶時效：safe-kickstart 在 kickstart 失敗時會自己把 marker 收回去，
# 所以「marker 還在但沒有新行程」不會發生，不需要靠時間窗去猜它是不是舊的。
MARKER="${REPO}/data/.kickstart-via-safe"

cd "${REPO}" 2>/dev/null || exit 0

VIA=UNKNOWN
if [ -f "${MARKER}" ]; then
  VIA=safe-kickstart
  rm -f "${MARKER}"
fi

HEAD_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

# 分成三種結果，不把「查不到」印成「沒有」（D42）：git 整個不可用時記
# (git-unavailable)，而不是記成一個看起來像「工作樹很乾淨」的空值。
if PORCELAIN=$(git status --porcelain 2>/dev/null); then
  UNCOMMITTED=$(printf '%s' "${PORCELAIN}" | cut -c4- | paste -sd, -)
  [ -n "${UNCOMMITTED}" ] || UNCOMMITTED='(none)'
else
  UNCOMMITTED='(git-unavailable)'
fi

mkdir -p "$(dirname "${LOG}")" 2>/dev/null
printf '%s | start | head=%s | via=%s | uncommitted=%s\n' \
  "$(date '+%Y-%m-%d %H:%M:%S')" "${HEAD_SHA}" "${VIA}" "${UNCOMMITTED}" >> "${LOG}" 2>/dev/null

echo "kickstart-guard: head=${HEAD_SHA} via=${VIA} uncommitted=${UNCOMMITTED}"
