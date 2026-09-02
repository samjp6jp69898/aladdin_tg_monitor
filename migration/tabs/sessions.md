> ⚠️ 行號基準：本文件引用的 **server.ts 行號是舊快照，已不可直接使用**——後續多次改動讓漂移
> 變成非均勻的 53~91 行，先前「一律 +15」的指示已作廢。要查 server.ts 現行位置請以
> `migration/00-api-inventory.md`（行號已依現行檔案重新生成）為準。
> **index.html 的行號則是準確的歷史記錄**；該檔已於 2026-09-02 經使用者核准刪除，
> 需要對照原檔時：`git show 624ae25:public/index.html`。

# 分頁規格：使用 Session（sessions）

route 值：`sessions`　section id：`tab-sessions`　HTML 行號：111–120　主要 render 函式：`loadSessions()`（第 358–362 行）

---

## 1. 畫面結構

```
section#tab-sessions
├─ div.bar                                              ← 篩選列
│   ├─ select#ss-service                                ← 首個 option: "全部服務"（value=""），其餘由 fillServiceSelects() 動態填入
│   ├─ input#ss-identity          placeholder="identity"
│   ├─ select#ss-days
│   │   ├─ option value="1"     "1 天"
│   │   ├─ option value="7"  (selected)  "7 天"
│   │   ├─ option value="30"    "30 天"
│   │   └─ option value="365"   "1 年"
│   ├─ button#ss-reload            "查詢"
│   └─ span.mute
│       "同一人連續請求間隔 < "  span#ss-gap "10"  " 分鐘視為同一段 session；tool 欄為該段依序呼叫的工具"
├─ div.scroll (style: max-height:80vh)
│   └─ table
│       ├─ thead > tr: th "使用者" / "服務" / "開始" / "結束" / "時長" / "請求" / "錯誤" / "登入帳號" / "IP" / "tool 序列" / ""（操作欄）
│       └─ tbody#ss-body            ← 動態列
```

`#ss-gap` 內文字 `10` 是佔位，實際被 API 回傳的 `gapMin`（後端常數 `SESSION_GAP_MIN`，`server.ts` 第 32 行值為 `10`）覆寫。

---

## 2. 資料來源

| API | 方法 | 參數 | 呼叫時機 |
|---|---|---|---|
| `/api/sessions` | GET | `service`（可省）、`identity`（可省）、`days` | 首次進入分頁（全域 `refresh()`）；每 5 秒全域輪詢（**本分頁沒有像 events 的「自動更新」開關，只要在此分頁就每次輪詢都重查**，見 `01-shell-and-shared.md` 5.1 表格）；點「查詢」按鈕；`#ss-service`/`#ss-days` 變動（`onchange`）；`#ss-identity` 按 Enter |

參數組裝（第 359 行）：
```js
const p=new URLSearchParams()
if($('#ss-service').value)p.set('service',$('#ss-service').value)
if($('#ss-identity').value.trim())p.set('identity',$('#ss-identity').value.trim())
p.set('days',$('#ss-days').value)
```
`service`/`identity` 空值時不帶參數；`days` 永遠帶（預設下拉值 `7`）。

後端邏輯（`server.ts` 第 149–181 行）：
1. 依 `days` 算出 `since = now - days*86400000`。
2. 查詢條件：`ts >= since AND identity IS NOT NULL`，可選 `service`/`identity` 精確比對（非模糊搜尋）。
3. 取出符合條件的 raw events，`ORDER BY service, identity, ts`（先分組再照時間排）。
4. 在記憶體中依序掃描：同一 `(service, identity)`、且與前一筆事件時間差 `<= gap`（`SESSION_GAP_MIN * 60000` 毫秒）即視為同一段 session；否則另開新段。
5. 每段累積：`start`/`end`（首尾事件時間）、`count`（事件數）、`errors`（`result` 以 `error:` 開頭的計數）、`tools`（依序收集 `tool` 值，含重複）、`logins`（去重後的 `agrabah_identifier` 清單）、`ips`（Set，去重後的 `source_ip`）。
6. 最終 `sessions.sort((a,b) => a.end < b.end ? 1 : -1)`（依結束時間新到舊排序）。

回應：`{ sessions: SessionRow[], gapMin: number, days: number }`，`SessionRow = {service, identity, start, end, count, errors, tools: string[], logins: string[], ips: string[], firstId, lastId}`。

---

## 3. 渲染邏輯

`loadSessions()`（第 358–362 行）：
```js
$('#ss-body').innerHTML = d.sessions.map(s=>`<tr>...</tr>`).join('') || '<tr><td colspan="11" class="mute">無資料</td></tr>'
```

逐段 session 產生一列，欄位對應：

| 表格欄 | 資料欄位 | 格式化方式 |
|---|---|---|
| 使用者 | `s.identity` | `<b style="color:var(--acc)">{esc(identity)}</b>`（強調色） |
| 服務 | `s.service` | `esc(service)` 原樣 |
| 開始 | `s.start` | `fmt(s.start)`（`.mono`） |
| 結束 | `s.end` | `fmt(s.end)} <span class="mute">{ago(s.end)}</span>`（`.mono`，附加相對時間） |
| 時長 | `s.start`、`s.end` | `dur(s.start, s.end)`（`.mono`） |
| 請求 | `s.count` | 原樣數字（`.mono`） |
| 錯誤 | `s.errors` | `.mono`；`s.errors` 真值時額外加 `err`（紅字）class，`class="mono {errors?'err':''}"` |
| 登入帳號 | `s.logins` | `esc(s.logins.join(', '))`（`.mono`）——多個帳號以逗號+空白串接 |
| IP | `s.ips` | `esc(s.ips.join(', '))`（`.mono.mute`） |
| tool 序列 | `s.tools` | 見 3.1（`.tools` class） |
| （操作欄） | `s.service`、`s.identity` | `<a href="#events" onclick="jumpEvents('{esc(service)}','{esc(identity)}')">看事件</a>` |

### 3.1 tool 序列欄渲染
```js
s.tools.length ? s.tools.map(t=>`<span>${esc(t)}</span>`).join('') : '<span class="mute">（只有握手，未呼叫 tool）</span>'
```
- `s.tools` 非空 → 每個 tool 名各自包一個 `<span>`（套用 `.tools span` 樣式：等寬字體、小標籤外觀），**依序排列、允許重複**（同一 tool 在段內被呼叫多次會顯示多個相同標籤，不去重、不加次數統計）。
- `s.tools` 為空 → 灰字提示「（只有握手，未呼叫 tool）」——代表該段 session 內的請求都是 MCP 握手類型（`tool IS NULL`），未曾真正呼叫工具。

### 3.2 排序

完全依 API 回傳順序（後端已 `sort` 依 `end` 新到舊），前端不重新排序。

---

## 4. 互動功能

| 元件 | 觸發方式 | 行為 |
|---|---|---|
| `select#ss-service` | `onchange` | `loadSessions()` |
| `select#ss-days` | `onchange` | `loadSessions()` |
| `input#ss-identity` | `onkeydown`，僅 `Enter` 鍵 | `loadSessions()` |
| `button#ss-reload`（"查詢"） | `onclick` | `loadSessions()` |
| 每列的「看事件」連結 | `onclick="jumpEvents(service, identity)"` | `window.jumpEvents`（第 363 行，見 `01-shell-and-shared.md` 3.4）：把該 session 的 `service`/`identity` 填入 events 分頁的對應篩選欄位（`#ev-service`、`#ev-identity`），再呼叫 `showTab('events')` 跳轉並觸發該分頁重新查詢——用於「從這段 session 直接看它產生的原始事件明細」 |

無任何 confirm/alert 對話框（唯讀分頁）。

---

## 5. 狀態與邊界

| 情境 | 畫面表現 |
|---|---|
| 查無資料（`d.sessions.length===0`） | `<tr><td colspan="11" class="mute">無資料</td></tr>`（單列，跨 11 欄置中提示文字，class 為 `mute` 灰字） |
| 段內請求全是握手、無 tool 呼叫 | tool 序列欄顯示「（只有握手，未呼叫 tool）」（3.1） |
| API 呼叫例外 | 透過 `refresh()` 觸發時被外層 `try/catch` 吞掉，畫面維持舊資料、無錯誤提示 |
| 首次載入 | 無 loading 骨架/spinner |
| `services` 尚未載入（下拉選單為空） | 進入本分頁時 `refresh()` 先檢查 `if (!services.length) await loadOverview()` 自動補上 |

---

## 6. 原始碼行號對照

| 內容 | 行號 |
|---|---|
| `<section id="tab-sessions">` HTML | 111–120 |
| `loadSessions()` | 358–362 |
| `window.jumpEvents` | 363 |
| 查詢鈕/篩選變更綁定 | 367 |
| 共用函式 `esc`/`fmt`/`ago`/`dur` | 271–275（見 `01-shell-and-shared.md` 第 4 節） |
| `refresh()` 對 sessions 分頁的輪詢邏輯 | 830 |
