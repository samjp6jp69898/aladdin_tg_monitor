# 視覺驗收複驗報告（shots-v2）

驗收方式：Read 工具逐頁目視比對 11 組（old/new）截圖，並用 Python/Pillow 對每組截圖做像素級 diff（含 nav bar 專項比對），交叉驗證目視結論。

## A. nav 間距

**結論：已修復。**

對全部 11 個 route，各截取 nav bar 區域（0,0)-(1440,70)）做像素級 diff，結果全部 `bbox = None`（完全零差異，非僅視覺相近）：
overview / events / sessions / stats / tokens / tg-connected / tg-pending / pipelines / toolsmith / workers / logs 皆為 pixel-identical。新舊版 nav 分頁按鈕水平間距、字重、底線/邊框樣式完全一致。

## B. 括號間距

**結論：已修復。**

- tokens 頁「Token 持有人（ 8 人）」：old/new 目視一致，括號內外皆有空白；像素 diff 僅命中同頁下方「新增 token」勾選列的次像素抗鋸齒雜訊（<0.01% 像素），與括號區域無關。
- tg-connected 頁「已連接（ 17 ）」：old/new **位元組完全相同**（bytewise identical PNG），像素 diff 為 None。
- workers 頁「已註冊 Worker （ 1 ）」：old/new 目視一致，括號內外空白皆保留；像素 diff 僅一列的次像素雜訊（0 顯著像素），與括號區域無關。
- tg-pending 頁「待處理（ 0 ）」（對照組，原本就正確）：old/new **位元組完全相同**，確認未被改壞。

四頁括號間距（含全形括號內外空白）皆與舊版一致，未發現緊貼現象。

## overview

判定：發現 1 項結構差異（非資料漂移）。

- **MAJOR**：頁面下半「最近狀態翻轉」卡片（右下角，TG 連接名單卡片右側）的表格，**舊版沒有欄位標題列**（直接從 `2026/9/1 17:42:55  dispatcher  up` 資料列開始），**新版新增了一列欄位標題「時間 / 服務 / 狀態 / detail」**。此為此輪 fix 說明外、未被列為「已知不修」的差異，且直接對應到「表格欄位數量與順序、欄位標題文字」的比對重點，也解釋了本頁 fullPage 截圖新版比舊版多出約 8px 高度（2462→2470）與約 2.4KB 檔案差異的主要來源。
- 其餘差異（服務卡片 PID/延遲 ms 數值、uptime 分鐘數、請求數等）皆為即時監控數值隨秒級時間漂移，非樣式/結構問題，不列入缺陷。
- nav 間距、頂部版面結構、卡片順序、Telegram Webhook / TG 連接名單 / 背景 Pipeline 併發區塊順序與文案皆一致。

## events

判定：乾淨。

像素 diff 僅命中頂部搜尋列「只看有呼叫 tool（隱藏…」文字區塊的次像素抗鋸齒雜訊（501 像素 / 152 萬像素，占比 <0.04%），目視裁切比對後文字內容、位置完全相同，非真實差異。表格欄位（時間/服務/使用者/tool/結果）、篩選列、按鈕文字皆一致。耗時/操作連結欄兩版皆未顯示（已知既有特性，非本次差異）。

## sessions

判定：乾淨。

像素 diff 命中的大範圍 bbox 目視裁切核對後，逐字逐值完全相同（時長/請求/錯誤/登入帳號/IP/tool 序列欄），純屬全表格區域的次像素抗鋸齒雜訊（2016 像素 / 144 萬像素，占比 0.14%），非真實差異。耗時/操作連結欄兩版皆未顯示（已知既有特性）。

## stats

判定：完全乾淨（byte-identical，像素 diff bbox = None）。近 24 小時請求數長條圖、每日×服務表、使用者排行、tool 排行、認證失敗來源、Token 名冊六個區塊順序與內容全部一致。

## tokens

判定：乾淨（含 B 項括號間距已修復，見上）。表格欄位（id/display_name/操作）、按鈕（詳情/重發 token/移除 token）、下方「新增 token」核發表單的核取方塊與文字皆一致。像素 diff 僅次像素抗鋸齒雜訊。

## tg-connected

判定：完全乾淨（byte-identical）。含 B 項括號間距已修復。

## tg-pending

判定：完全乾淨（byte-identical）。對照組「待處理（ 0 ）」未被改壞，確認見上。

## pipelines

判定：乾淨，僅命中已知且刻意不修的差異。

像素 diff bbox 落在每列右側「重試」按鈕位置——舊版按鈕在 1440px 下被裁掉半個字（顯示「重]」），新版完整顯示「重試」。此為說明中明確列出的**已知差異 #1**（新版比較好、維持現狀），不算缺陷。其餘票號、Worker、發起人、時間、耗時、tokens in/out、結果標籤、log 連結欄位全部一致。

## toolsmith

判定：乾淨。像素 diff 命中頂部說明文字「…son（即時現讀，非收集器）。企劃呼叫 alad…」區域，目視裁切核對文字完全相同，屬次像素抗鋸齒雜訊（1509 像素 / 144 萬，占比 0.1%）。表格欄位（requestId/target/發起人/狀態/輪次/建立/更新/摘要）、狀態徽章顏色（完成=綠、失敗=紅）皆一致。摘要欄在 viewport 邊緣的截斷兩版一致（已知差異 #3）。

## workers

判定：完全乾淨。像素 diff bbox 命中一條表格分隔線位置但「pixels>15sum: 0」，即無顯著像素差異，純屬幾何邊緣的次像素取樣雜訊。表格欄位、狀態徽章（UP，綠框）、操作按鈕（詳情/中斷/重連/移除）、下方名冊來源說明文字皆一致。

## logs

判定：完全乾淨。像素 diff bbox 命中檔案選單旁一小塊區域但「pixels>15sum: 0」，無顯著像素差異。log 內容（cluster: worker 登記 landon2 → ...）、檔案選單「[dispatcher] launchd-server.err (15.1KB)」、64KB 選項、即時跟隨勾選、15.1KB 檔案大小顯示皆一致。

## 總結

- **BLOCKER：0 項**
- **MAJOR：1 項**（overview 頁「最近狀態翻轉」表格新版新增欄位標題列，舊版沒有）
- **MINOR：0 項**
- 完全乾淨（無任何差異或僅次像素抗鋸齒雜訊）的 route：events、sessions、stats、tokens、tg-connected、tg-pending、pipelines（含已知差異）、toolsmith、workers、logs，共 10 條。
- A（nav 間距）與 B（括號間距）兩項前一輪發現的問題，經像素級與目視雙重驗證，**皆已修復**，11 頁 nav bar 逐像素完全一致；tokens/tg-connected/workers 三頁括號間距與舊版一致，tg-pending 對照組未被改壞。

VISUAL_RESULT: FAILED
NAV_SPACING: FIXED
PAREN_SPACING: FIXED
BLOCKERS: 0
MAJORS: 1
REPORT_PATH: /Users/user/aladdin/tg-monitor/migration/review/visual-verify.md
