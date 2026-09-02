# Token 權限分頁 — Parity 對照表

實作範圍：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/TokensPage.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/tokens/TokenListView.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/tokens/TokenDetailView.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/tokens/constants.ts`

規格依據：`migration/tabs/tokens.md`（14 個互動點，§4）、`migration/02-frontend-contract.md` §8 第 3 條。

---

## 1. 互動功能對照表（tokens.md §4，14 項）

| # | 規格項目 | 實作位置 |
|---|---|---|
| 1 | subnav「Token 權限」/「TG 已連接」/「TG 待處理」 | 由共用層 `src/components/shell/ConnectLayout.tsx` 統一渲染（`App.tsx` 的 `<Route element={<ConnectLayout />}>` 包住 tokens/tg-connected/tg-pending 三條路由）。本頁不重畫，依契約 §4「SubNav」段落規則。 |
| 2 | 重新整理 `#tk-reload` | `TokensPage.tsx:44`（`<Button onClick={() => reload()}>重新整理</Button>`），無 confirm，直接呼叫共用 `reload()`。 |
| 3 | 新增 token 表單 → `#tkc-create`「核發並發送到 Landon TG」 | `TokenListView.tsx:71-99`（`handleCreate`）：id/name/services 前端校驗（`TOKEN_ID_PATTERN`）→ `useAction.run` 帶 `confirm` → `postTokenGrantCreate` → 成功清空欄位並 `reload()`、失敗不清空不重載。 |
| 4 | 列表頁每列「詳情」按鈕 | `TokenListView.tsx:32-35`（`openDetail`）：`reload()` 後 `navigate(tokensPath(id))`，無 confirm。 |
| 5 | 列表頁每列「重發 token」按鈕（不帶 services） | `TokenListView.tsx:37-45`（`resendKitFromList`），呼叫 `postTokenGrantResend(person.id)`（不傳 services）。 |
| 6 | 列表頁每列「移除 token」按鈕 | `TokenListView.tsx:47-54`（`removeAllFromList`）：`managedEnvsOf` 算交集、空則直接 return，否則 confirm → `postTokenGrantRevoke(id, managed)`。 |
| 7 | 詳情頁「← 返回列表」 | `TokenDetailView.tsx:60-64`（`handleBack`）：`reload()` 後 `navigate(tokensPath())`。 |
| 8 | 詳情頁「改名」`#tkd-rename` | `TokenDetailView.tsx:66-77`（`handleRename`）：`window.prompt` → 取消/空值/同名各自中止 → `postTokenGrantRename`。 |
| 9 | 詳情頁每環境列「簽發」按鈕 | `TokenDetailView.tsx:79-89`（`handleAddGrant`），依 `service==='toolsmith'` 切換 note 文案，`postTokenGrantAdd`。 |
| 10 | 詳情頁每環境列「移除」按鈕 | `TokenDetailView.tsx:91-97`（`handleRevokeGrant`），`postTokenGrantRevoke(id, [service])`。 |
| 11 | `resendKit(id, services?)` 共用邏輯 | 兩個呼叫端各自內嵌對應分支：`TokenListView.tsx:37-45`（無 services 分支）、`TokenDetailView.tsx:99-111`（有 services 分支，`handleResendChecked`）。未抽共用函式，因兩處的「managed 為空判斷」與「confirm 文案組裝」來源不同（列表頁用 `person.grants`、詳情頁用 `checkedEnvs` state），各自内嵌比硬拉共用函式更符合 Rule 2/3（簡單、不過度抽象）。 |
| 12 | 詳情頁「依勾選重發 token」`#tkd-resend` | `TokenDetailView.tsx:99-111`（`handleResendChecked`）：`checkedEnvs` 空 → alert 並中止（不進 resend 分支、不彈 confirm）；否則呼叫 `postTokenGrantResend(id, services)`。 |
| 13 | 詳情頁「刪除此人全部 token」`#tkd-delete` | `TokenDetailView.tsx:113-121`（`handleRemoveAll`），邏輯與第 6 項相同（用 `person.grants` 算 managed）。 |
| 14 | 詳情頁 9 個 `.tkd-env` checkbox（純狀態輸入） | `TokenDetailView.tsx:40-58`（`checkedEnvs` state + `toggleEnv`），供第 12 項讀取；新增表單 9 個 `.tkc-env` 對應 `TokenListView.tsx:26-70`（`newEnvs` state + `toggleNewEnv`），供第 3 項讀取。 |

**14/14 對應完成。**

---

## 2. 渲染欄位對照表

### 列表頁 `#tk-table`（`TokenListView.tsx` 內 `DataTable`）

| 舊版欄位 | 實作 |
|---|---|
| id（等寬、強調色） | `<b style={{color:'var(--acc)'}}>` in `className:'mono'` 欄，`TokenListView.tsx:112-117` |
| display_name | 原文直出 |
| 操作（詳情/重發/移除） | 三個 `Button`（default/warn/danger），對應第 4/5/6 項 |
| 標題 `Token 持有人（N 人）` | `Card title` 用模板字串內插 `data.people.length`（不需要舊版的 `#tk-n` span，React 隨資料重繪） |
| 空資料 `名冊為空` | `DataTable` `emptyMode="replace"` `emptyText="名冊為空"` |

### 詳情頁 `#tkd-grants`（`TokenDetailView.tsx` 內 `DataTable`）

| 舊版欄位 | 實作 |
|---|---|
| 環境 | `s.name`（來自 API `data.services`，非硬編碼標籤） |
| 狀態 | 有權限 → `<Badge variant="ok">有權限</Badge>`（對應舊版 `.pill.ok`）；無權限 → `<span className="mute">—</span>` |
| 核發時間 | `fmt(g.issued_at)`，無權限空白 |
| 使用 | `n===0` → `未使用過`；否則 `${n} 次 · ${ago(last_ts)}`，無權限空白 |
| 操作 | 有權限 → 「移除」（danger）；無權限 → 「簽發」（default） |
| 標題 `id（display_name）` / `N 個環境` | `TokenDetailView.tsx:127-130`，直接讀 `person` |

---

## 3. 狀態與邊界對照

| 規格（tokens.md §5） | 實作 |
|---|---|
| 載入中無骨架，畫面維持上次內容 | `useResource` 的 `loading` 只在 `!data` 時顯示「載入中…」（`TokensPage.tsx`），資料到手後輪詢刷新不再顯示 loading，符合「fetch 期間 DOM 不清空」。 |
| 空資料 `名冊為空` | 見上表，`DataTable emptyMode="replace"`。 |
| 詳情頁找不到此人 → 自動切回列表、無提示 | `TokensPage.tsx:32-38`：`useEffect` 偵測 `id && data && !person` → `navigate(tokensPath(), {replace:true})`，不彈窗。 |
| 錯誤一律 `alert("XX失敗：${r.result}")` | 全部寫入操作走 `useAction().run()` → `normalizeActionResult`/`errorToActionResult` 統一成 `{ok,message}`，再手動 `alert(r.ok?...:...)`，不分網路層/業務層。 |
| 業務錯誤字串前綴（`ADD_ERR_*`等） | 不需要前端額外處理——`postResult` 已把非 2xx 的 JSON body 原樣回傳，`message` 直接顯示後端字串（含前綴），與舊版行為一致。 |

---

## 4. 9 個環境 checkbox 的狀態管理（契約 §8 第 3 條）

**規則**：舊版 `.tkd-env` 每次 `loadTokenDetail()`（含 5 秒輪詢）都會把 checkbox 狀態強制回填成「此人目前有的環境」，會沖掉使用者剛勾好、還沒送出的手動選擇。新版定調為**手動勾選狀態存 React state，只在「切換到不同的人」時才重新播種，輪詢刷新完全不碰它**。

實作（`TokenDetailView.tsx:40-49`）：

```tsx
const [checkedEnvs, setCheckedEnvs] = useState<Set<TokenService>>(
  () => new Set(Object.keys(person.grants) as TokenService[]),
)
const seededForId = useRef(person.id)
useEffect(() => {
  if (seededForId.current !== person.id) {
    setCheckedEnvs(new Set(Object.keys(person.grants) as TokenService[]))
    seededForId.current = person.id
  }
}, [person.id, person.grants])
```

`useEffect` 的依賴陣列包含 `person.grants`（每次輪詢都會是新物件參照，effect 因此每輪都會執行一次），但函式體第一行就用 `seededForId.current !== person.id` 擋掉——同一個人時這個條件恆為 false，所以**不會呼叫 `setCheckedEnvs`**，使用者手動勾選的內容原封不動留著。只有 `person.id` 真的變了（使用者切到另一個人的詳情頁）才會重新播種成新的人目前的權限，這與舊版「首次進入詳情頁時 checkbox 顯示目前權限」的行為一致，差別只在於「輪詢期間不再被沖掉」。

新增表單的 `.tkc-env`（`TokenListView.tsx`）本來就是全新表單、沒有輪詢回填的問題，用一般 `useState<Set<TokenService>>` 即可，不需要這套播種邏輯。

---

## 5. 未達成項目

無。14 個互動點、渲染欄位、狀態管理均已依規格與契約實作。

以下是實作時的**刻意技術選擇**（非缺項，記錄供 review 參考）：

1. **環境權限表的 `emptyText`**：舊版該表恆為 9 列固定資料，理論上不會觸發空狀態；`DataTable` 的 `emptyText` prop 為必填，此處填入防禦性文案 `"尚無環境資料"`（規格未定義此文案，因為舊版此情境不會發生）。
2. **`resendKit(id, services?)` 沒有抽成頁面間共用函式**：列表頁與詳情頁的呼叫時機、managed/services 來源不同（見上方互動點 #11 說明），依 Rule 2/3（簡單優先、不做非必要抽象）各自內嵌實作，行為與舊版共用函式完全一致。
3. **「詳情」「返回列表」按鈕在切換視圖前多打一次 `reload()`**：對應舊版 `openTokenDetail()`/`closeTokenDetail()` 各自呼叫 `loadTokenDetail()`/`loadTokenGrants()` 立即刷新一次的行為；由於新版列表/詳情共用同一個 `/api/token-grants` 資源，這個 reload 是「確保切換當下看到最新資料」，非必要但更貼近舊版的即時性保證。

---

## 6. 驗收

```
cd /Users/user/aladdin/tg-monitor/frontend && bunx tsc --noEmit -p tsconfig.app.json
```
結果：零錯誤（PASS）。
