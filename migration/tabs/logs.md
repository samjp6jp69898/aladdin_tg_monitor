> ⚠️ 行號基準：本文件引用的 **server.ts 行號是舊快照，已不可直接使用**——後續多次改動讓漂移
> 變成非均勻的 53~91 行，先前「一律 +15」的指示已作廢。要查 server.ts 現行位置請以
> `migration/00-api-inventory.md`（行號已依現行檔案重新生成）為準。
> **index.html 的行號則是準確的歷史記錄**；該檔已於 2026-09-02 經使用者核准刪除，
> 需要對照原檔時：`git show 624ae25:public/index.html`。

# 分頁規格：Logs（logs）

route 值：`logs`　section id：`tab-logs`　HTML 行號：258–267　主要 render 函式：`loadLogList()`（第 733–739 行）+ `loadLog()`（第 740–757 行）+ `window.openLog()`（第 758 行）

---

## 1. 畫面結構

```
section#tab-logs
├─ div.bar
│   ├─ select#lg-file          style="min-width:420px"       ← 動態填入 option（見 3.1）
│   ├─ select#lg-kb
│   │   ├─ option value="16"              "16KB"
│   │   ├─ option value="64"  (selected)  "64KB"
│   │   ├─ option value="256"             "256KB"
│   │   └─ option value="1024"            "1MB"
│   ├─ label > input[type=checkbox]#lg-follow  (checked)  "即時跟隨"
│   ├─ button#lg-reload            "重新載入"
│   └─ span.mute#lg-info            ← 動態文字（檔案大小）
└─ pre.log#lg-out                   ← 動態內容（log 檔案文字）
```

---

## 2. 資料來源

| API | 方法 | 參數 | 呼叫時機 |
|---|---|---|---|
| `/api/logs` | GET | 無 | 進入分頁且 `force=true`（切換分頁/按全域刷新鈕）；非 force 輪詢時，只要目前焦點**不在** `#lg-file` 下拉選單上，每 5 秒也會呼叫（見 `01-shell-and-shared.md` 5.1 表格）；由 `window.openLog(path)` 呼叫（見第 4 節） |
| `/api/log/tail` | GET | `path`、`kb`（來自 `#lg-kb`） | `loadLog()` 每次被呼叫時（見 3.2 觸發時機） |
| `/api/log/since` | GET | `path`、`offset`（內部狀態 `lgOffset`） | 僅當 `#lg-follow` 勾選且上次 tail 結果非 `missing` 時，由 `loadLog()` 內開啟的 **1500ms 專屬 timer** 持續呼叫（見第 5 節） |

`/api/logs` 回應結構（`server.ts` 第 748–761 行）：
```ts
{
  registered: Array<{service, label, path, exists: boolean, size: number}>,
  pipelineLogs: Array<{service:'dispatcher', label, path, exists:true, size, mtime}>,
}
```
- `registered`：各服務在登錄表中設定的固定 log 檔（如稽核 log、launchd stdout/stderr）。
- `pipelineLogs`：`telegram-dispatcher/logs` 目錄下符合 `^[A-Z]+-\d+\..*\.log$` 命名的逐票 log 檔案，依 `mtime` 新到舊排序（`server.ts` 內 `.sort((a,b)=>a.mtime<b.mtime?1:-1)`）。

`/api/log/tail` 回應：`{text: string, size: number}` 或（檔案不存在時）`{text:'', size:0, missing:true}`。後端邏輯（`server.ts` 第 764–786 行）：從檔尾往回讀 `kb*1024` bytes，若非從檔頭開始讀（`start>0`）則捨棄第一個不完整的行（`text.slice(text.indexOf('\n')+1)`），確保回傳內容不含被截斷的半行。`kb` 上限 `2048`（即 2MB，`Math.min(Number(kb),2048)`——注意此上限比下拉選單最大選項 `1024`（1MB）還大，UI 選單本身已限制使用者能選的最大值）。

`/api/log/since` 回應：`{text: string, offset: number}` 或 `{text:'', offset:0, missing:true}`。後端邏輯（`server.ts` 第 789–804 行）：若請求的 `offset` 大於檔案目前大小（代表檔案被截斷或輪替過）→ `offset` 重設為 `0`（下次會從頭重讀，前端據此清空畫面重新累積，見 3.3）；若 `offset===size`（無新內容）→ 回傳空 `text`、`offset` 不變；否則讀取 `[offset, size)` 區間新增內容，單次最多讀 `2MB`（`Math.min(size-offset, 2*1024*1024)`），回傳讀到的內容與新的 `offset`（`offset + 實際讀到的 bytes 數`——若新增內容超過 2MB，前端下次呼叫會用這個中繼 offset 再繼續讀剩餘部分，等同分批追上）。

---

## 3. 渲染邏輯

### 3.1 `loadLogList()`（第 733–739 行）—— 填充 `#lg-file` 下拉選單

```js
async function loadLogList(){
  const d = await api('/api/logs'); const sel=$('#lg-file'); const cur=sel.value; sel.innerHTML=''
  const add=(label,path,dis)=>{ const o=document.createElement('option'); o.value=path; o.textContent=label; if(dis) o.disabled=true; sel.appendChild(o) }
  d.registered.forEach(l=>add(`[${l.service}] ${l.label}${l.exists?` (${(l.size/1024).toFixed(1)}KB)`:' (不存在)'}`, l.path, !l.exists))
  if (d.pipelineLogs.length){ add('── pipeline 逐票 log ──','',true); d.pipelineLogs.forEach(l=>add(`${l.label} (${(l.size/1024).toFixed(1)}KB, ${ago(l.mtime)})`, l.path)) }
  if (cur) sel.value = cur
}
```
- **完全重建下拉選單**：先記下目前選中值（`cur`），清空 `sel.innerHTML`，重新逐一 `add()` 新選項，最後嘗試還原原本選中的值（若該 path 仍在新選項清單中）。
- 「registered」段每個選項文案：`[{service}] {label}{exists ? ' ('+(size/1024 保留1位小數)+'KB)' : ' (不存在)'}`。**檔案不存在的選項會被 `disabled`**（`!l.exists`），使用者無法選取。
- 若有 `pipelineLogs`，先插入一個 disabled 的分隔選項（文字「── pipeline 逐票 log ──」，`value=''`），再逐一列出：文案 `{label} ({size/1024 保留1位小數}KB, {ago(mtime)})`——注意此段用**相對時間**（`ago`），不同於 registered 段沒有時間資訊。
- 若 `d.pipelineLogs.length===0`，完全不插入分隔線與任何 pipeline log 選項（不會顯示「無 pipeline log」之類的提示）。

### 3.2 `loadLog()`（第 740–757 行）—— 載入並顯示選中檔案的內容

```js
async function loadLog(){
  const path=$('#lg-file').value; if(!path) return
  if (lgTimer) { clearInterval(lgTimer); lgTimer=null }
  const d = await api(`/api/log/tail?path=${encodeURIComponent(path)}&kb=${$('#lg-kb').value}`)
  const out=$('#lg-out'); out.textContent = d.missing?'(檔案不存在)':d.text; out.scrollTop=out.scrollHeight
  $('#lg-info').textContent = d.missing?'':`${(d.size/1024).toFixed(1)}KB`
  lgOffset = d.size || 0
  if ($('#lg-follow').checked && !d.missing){
    lgTimer = setInterval(async () => {
      try {
        const r = await api(`/api/log/since?path=${encodeURIComponent(path)}&offset=${lgOffset}`)
        if (r.offset < lgOffset) { out.textContent = '' }
        lgOffset = r.offset
        if (r.text) {
          const atBottom = out.scrollHeight-out.scrollTop-out.clientHeight<40
          out.textContent += r.text
          if (atBottom) out.scrollTop=out.scrollHeight
          $('#lg-info').textContent = `${(lgOffset/1024).toFixed(1)}KB`
        }
      } catch {}
    }, 1500)
  }
}
```
- `path` 為空（未選檔案）→ 直接 return，不做任何事。
- 先清掉舊的「即時跟隨」timer（若存在），避免多個 timer 同時疊加輪詢同一份或不同份檔案。
- 呼叫 `/api/log/tail` 取得初始內容，`out.textContent` 設為：`d.missing` 為真 → 固定文字 `(檔案不存在)`；否則 → `d.text` 原文（**不經過 `esc()`——直接用 `textContent` 賦值，瀏覽器原生防 XSS，不需手動跳脫**）。
- 載入後立即 `out.scrollTop = out.scrollHeight`（捲到最底部，顯示最新內容）。
- `#lg-info` 顯示：`d.missing` 為真 → 空字串；否則 → `{size/1024 保留1位小數}KB`。
- `lgOffset`（模組層級變數，第 732 行 `let lgTimer=null, lgOffset=0`）記錄目前已讀到的 byte 位移，供後續「即時跟隨」的 `/api/log/since` 呼叫使用。
- **若 `#lg-follow` 勾選且檔案存在**，開啟 1500ms 輪詢（見第 5 節詳述追加邏輯）。

### 3.3「即時跟隨」追加邏輯細節（timer callback 內）
- `r.offset < lgOffset`：代表檔案被截斷或輪替（後端已在 `/api/log/since` 偵測並把 `offset` 重設為 0 回傳），此時**清空畫面**（`out.textContent=''`）重新開始累積，避免顯示到跳號或錯亂的內容。
- `lgOffset = r.offset`：無論是否有新內容都更新位移。
- 只有 `r.text` 非空時才：(a) 先判斷目前是否已捲到底部附近（`scrollHeight - scrollTop - clientHeight < 40`，容忍 40px 誤差）；(b) 把新文字**追加**（`+=`）到 `out.textContent`；(c) 若追加前已在底部，才自動捲到新的底部（**若使用者正往上捲查看歷史內容，不會被強制拉回底部**——這是刻意的 UX 設計，重寫時需保留）；(d) 更新 `#lg-info` 為目前累積位移換算的 KB 數。
- 任何請求例外都被 `catch {}` 靜默吞掉，不影響下一輪 timer 觸發。

### 3.4 排序

`#lg-file` 選單順序：`registered` 依 `/api/logs` 回傳順序（各服務登錄表定義順序）→ 分隔線 →`pipelineLogs` 依 `mtime` 新到舊。無其他前端排序。

---

## 4. 互動功能

| 元件 | 觸發方式 | 行為 |
|---|---|---|
| `select#lg-file` | `onchange` | `loadLog()`（切換到新選中的檔案，重新讀取並視 `#lg-follow` 狀態重啟即時跟隨） |
| `select#lg-kb` | `onchange` | `loadLog()`（用新的 tail 大小重新讀取同一檔案） |
| `checkbox#lg-follow` | `onchange` | `loadLog()`（重新整個流程；若取消勾選則本次不會開啟 1500ms timer，若之前已在跑的 timer 也會在 `loadLog()` 開頭被清掉） |
| `button#lg-reload`（"重新載入"） | `onclick` | `loadLog()` |
| （程式化）`window.openLog(path)` | 由其他分頁（如 pipelines/toolsmith/workers 的「log」連結，非本次拆解範圍）呼叫 | 先 `await loadLogList()`（確保該 path 在下拉選單中存在），設定 `$('#lg-file').value = path`，再 `showTab('logs')` 跳轉到本分頁並觸發載入 |

無任何 confirm/alert 對話框（唯讀分頁）。

---

## 5. 狀態與邊界

| 情境 | 畫面表現 |
|---|---|
| 選中的檔案不存在（`d.missing===true`） | `#lg-out` 顯示固定文字「(檔案不存在)」；`#lg-info` 清空；不開啟「即時跟隨」timer（即使 checkbox 勾選也不會啟動，因為條件是 `!d.missing`） |
| 尚未選擇任何檔案（`$('#lg-file').value` 為空） | `loadLog()` 直接 return，`#lg-out` 維持上次內容（通常是初次進入分頁前的空白） |
| `registered` 中某檔案存在性為否 | 對應下拉選項 disabled、文案帶「(不存在)」，使用者無法選取該項 |
| 無任何 `pipelineLogs` | 不顯示分隔線與任何逐票 log 選項段落，無提示文案 |
| 檔案被截斷/輪替（log rotate） | 即時跟隨偵測到 `r.offset < lgOffset` 時清空畫面重新累積（3.3） |
| 使用者正往上捲查看歷史 | 新內容仍會追加到 DOM 尾端，但不會強制捲動畫面打斷使用者（3.3） |
| API 呼叫例外（tail/初次載入） | 未特別 catch（`loadLog()` 主體無 try/catch），若透過 `refresh()` 觸發則被外層 try/catch 吞掉；即時跟隨 timer 內的例外用 `catch{}` 靜默吞掉，不影響後續輪詢 |
| 首次載入 | 無 loading 骨架/spinner |

---

## 6. 原始碼行號對照

| 內容 | 行號 |
|---|---|
| `<section id="tab-logs">` HTML | 258–267 |
| `let lgTimer, lgOffset` | 732 |
| `loadLogList()` | 733–739 |
| `loadLog()`（含即時跟隨 timer） | 740–757 |
| `window.openLog(path)` | 758 |
| 篩選/按鈕綁定 | 823 |
| `refresh()` 對 logs 分頁的輪詢邏輯（force 與非 force 差異） | 838 |
| 全域輪詢 `setInterval(()=>refresh(false), 5000)` | 842 |
| server.ts：`GET /api/logs` | server.ts:748 |
| server.ts：`GET /api/log/tail`（含 `tailFile` helper） | server.ts:764–786 |
| server.ts：`GET /api/log/since` | server.ts:789–804 |
