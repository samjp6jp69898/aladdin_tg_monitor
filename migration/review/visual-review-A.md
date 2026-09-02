# 視覺審查報告 A（fresh-context 獨立審查）

審查方式：以 Playwright 同時間、同 viewport（1440×1000，fullPage）截圖，逐頁比對舊版（`public/index.html`）與新版（React，`/next/`）。資料值（時間戳、計數、log 尾端內容等）不同不算差異，只比對結構、欄位、文案、樣式。

---

## overview

**整體判定：PASS**（僅發現 1 項全站共通的 MINOR 樣式差異，見總結；本頁本身無其他問題）

逐項比對：
- 標題文字「服務 / Port（每 5 秒探測；「目前使用中」= 最近 5 分鐘內有稽核紀錄的人）」：一致。
- 服務卡片牆：11 張卡片，順序、內容（狀態圓點、UP 徽章、重啟按鈕、port/proxy/launchd 標籤、PID/延遲、uptime、請求 1h/24h、錯誤數、最後事件、名冊人數、使用者清單）全部一致，逐卡比對無差異。
- Telegram Webhook 卡片：URL、待送達、上次錯誤、邊緣 IP、查詢時間附註文字，逐字一致。
- TG 連接名單卡片：已連接/待處理數字與「查看」連結一致。
- 背景 Pipeline 併發卡片：Bug /create-mr、需求 pipeline、bug-lock 三行與「目前沒有背景 pipeline 在跑」文案一致。
- 最近狀態翻轉表格：欄位「時間／服務／狀態／detail」、色彩（up 綠 / down 紅）、資料列順序完全一致。
- 曾懷疑右下角有一個疊字的「刷新」按鈕殘影（在 toolsmith 狀態翻轉列附近），經裁切放大比對後確認是誤判——該區塊實際只是 up/down 狀態文字，新舊版該處內容一致，並無渲染破損。

無 BLOCKER / MAJOR / MINOR（本頁專屬）。

---

## events

**整體判定：PASS**

逐項比對：
- 篩選列：服務下拉「全部服務」、identity 輸入框 placeholder、搜尋框 placeholder、「只看錯誤」「只看有呼叫 tool」核取方塊文案、「自動更新」（預設勾選）、「查詢」按鈕、「顯示 200 筆」動態文字，全部一致。
- 表格資料列：時間、服務、使用者（強調色）、tool、結果（`unknown` 灰色 pill）欄位內容、順序、樣式一致。
- 「載入更早」按鈕存在且文案一致。
- 註記：規格書描述表頭應另有「耗時」欄與操作欄（▸ 展開按鈕），但新舊兩版截圖中皆未見這兩欄渲染出來（表格在「結果」欄後即無內容，右側留白）。由於此現象在新舊兩版**完全相同**，不構成本次 new-vs-old 的差異，故不計入缺陷；如兩版皆與規格不符，屬於既有現象，不在本輪 parity 審查範圍內另行標記。

無 BLOCKER / MAJOR / MINOR。

---

## sessions

**整體判定：PASS**

逐項比對：
- 篩選列：服務下拉、identity 輸入框、天數下拉（1/7/30/365，預設 7 天選中）、「查詢」按鈕、說明文字「同一人連續請求間隔 < 10 分鐘視為同一段 session；tool 欄為該段依序呼叫的工具」，逐字一致。
- 表格欄位：使用者／服務／開始／結束／時長／請求／錯誤／登入帳號／IP／tool 序列，順序、對齊、樣式（使用者強調色、時長/請求/錯誤等 mono 字體）一致。
- tool 序列欄的「（只有握手，未呼叫 tool）」空狀態文案一致。
- 資料列數與內容逐列比對（tintin/landon-mactest 各筆時間、IP、時長）完全相同。
- 與 events 頁相同的情況：規格書提到的最後一欄「看事件」連結，在新舊兩版截圖中皆未見渲染（表格在 tool 序列欄後即到邊緣），兩版一致，不計入本次差異。

無 BLOCKER / MAJOR / MINOR。

---

## stats

**整體判定：PASS**

逐項比對：
- 「7 天」下拉、「重算」按鈕、「資料庫共 1709 筆事件」文字一致。
- 「近 24 小時每小時請求數」長條圖：Y 軸刻度（0/76/152/228/304）、X 軸 24 個小時刻度、每根長條數值標籤（10/54/25/303/31/25/25/42）、長條顏色與高度比例，逐一比對像素級一致；右上角「X 軸：本地時間（時）　Y 軸：請求數」說明文字一致。
- 「每日 × 服務」交叉表：日期由新到舊排列、服務欄順序、每格數字，逐格比對一致。
- 「使用者排行」：identity（含 crimson/landon-mactest 強調色）、service、次數、相對時間，逐列一致。
- 「tool 排行」：tool 名稱（mono）、service，逐列一致（畫面截斷處也一致）。
- 「認證失敗來源」：service、IP（mono）、reason（紅字 mono）逐列一致，包含 `invalid_token` 與 `missing_or_malformed_authorization_header` 兩種原因。
- 「Token 名冊」表格：唯一有明確表頭列（服務/id/display_name/核發時間）的卡片，逐列資料（tintin/angelo/uber/landon/landon-remote-test/landon-mactest/anderick/crimson 等）比對一致。

無 BLOCKER / MAJOR / MINOR。

---

## logs

**整體判定：PASS**

逐項比對：
- 檔案下拉選單顯示「[dispatcher] launchd-server.err (15.0KB)」、64KB 大小下拉、「即時跟隨」核取方塊（勾選）、「重新載入」按鈕、右側檔案大小文字「15.0KB」，逐一比對一致。
- log 內容區（`pre.log`）：兩版顯示的文字內容、行數、捲動位置（皆捲到底部顯示最新 `cluster: worker 登記 landon2 → http://192.168.211.14:8801` 重複行）逐字一致。

無 BLOCKER / MAJOR / MINOR。

---

## 總結

- **BLOCKER：0 項**
- **MAJOR：0 項**
- **MINOR：1 項**（全站共通，非單一分頁專屬）
  - 頂部導覽列（tg-monitor 導覽 tab：總覽/即時序列/使用 Session/歷史統計/連接/Pipelines/Toolsmith/Workers/Logs）在新版的項目間距略窄於舊版。經裁切比對五組截圖的導覽列，新版每個 tab 之間的水平間距都比舊版略小（例如同一 1440px 寬度截圖內，舊版導覽列到「Logs」右緣的位置比新版更靠右，整條導覽列在新版中明顯更緊湊）。純樣式間距差異，不影響可讀性與可點擊性，不影響任何文案或功能。
- **完全乾淨（無任何差異）的 route**：overview、events、sessions、stats、logs — 五頁的核心版面結構、欄位、文案、資料呈現、色彩語意（UP/DOWN、綠/紅、mute/ok/err）在本次比對中全部一致，唯一發現的差異是上述全站共通的導覽列間距 MINOR 項。
- 未發現任何渲染破損（空白區塊、錯位、疊字、內容溢出）。曾誤判 overview 右下角有「刷新」文字殘影，經裁切放大確認為誤判，已排除。
- events/sessions 兩頁規格書提及但兩版截圖皆未見渲染的「耗時」欄、操作欄（▸ 展開 / 看事件連結）：因新舊兩版表現完全相同，判定為非本次 migration 引入的差異，不計入缺陷清單。

REVIEW_RESULT: PASSED
BLOCKERS: 0
MAJORS: 0
MINORS: 1
REPORT_PATH: /Users/user/aladdin/tg-monitor/migration/review/visual-review-A.md
