# Toolsmith 分頁 parity 對照表

實作檔案：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/ToolsmithPage.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/toolsmith/ToolsmithDetail.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/toolsmith/format.ts`

規格依據：`/Users/user/aladdin/tg-monitor/migration/tabs/toolsmith.md`（下稱「規格」）、
`/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md`（下稱「契約」）。

---

## 1. 互動功能對照（規格 §4，共 4 項）

| 規格項次 | 內容 | 實作位置 |
|---|---|---|
| §4.1 `#ts-reload` 重新整理 | `onclick=loadToolsmith`，無 confirm | `ToolsmithPage.tsx:134`（`<Button onClick={() => resource.reload()}>重新整理</Button>`） |
| §4.2 每列「研究log」連結 | `onclick="openLog(agentLogPath);return false"`，僅 `agentLogExists===true` 才可點；切到 Logs 分頁並載入該路徑 | `ToolsmithPage.tsx:102-108`（可點時 `<a href={logsPath(row.agentLogPath)} onClick={openLog(row.agentLogPath)}>研究log</a>`；`openLog` 定義於 `:44-47`，`e.preventDefault()` 對應舊版 `return false`，`navigate(logsPath(path))` 對應舊版 `openLog()` 切分頁 + 代填路徑，契約 §6.2） |
| §4.3 每列「部署log」連結 | 同上，`deployLogPath`，僅 `deployLogExists===true` 才可點 | `ToolsmithPage.tsx:110-116`（同一個 `openLog` helper，`deployLogPath`） |
| §4.4 每列展開/收合按鈕 `#ts-t-{requestId}` | `onclick="toggleTsDetail(requestId)"`：切換對應詳情列 `hidden`，同步切換按鈕文字 `▸`/`▾`；純前端狀態，不打 API | `ToolsmithPage.tsx:120-128`（`Button` 內 `{expanded.has(row.requestId) ? '▾' : '▸'}`，`onClick={() => toggleExpand(row.requestId)}`）；`toggleExpand` 定義於 `:35-42`（`Set<string>` 增刪）；`DataTable.renderExpanded`（`:146`）依 `expanded.has(row.requestId)` 決定是否掛載 `<ToolsmithDetail>` |

log 連結「不可點時降級為灰字」的分支（規格 §5「log 檔不存在」）：`ToolsmithPage.tsx:106-107`、`114-115`（`<span className="mute">研究log</span>` / `部署log`）。

---

## 2. 渲染欄位對照表（規格 §3「渲染邏輯」）

### 2.1 主列（10 欄，`ToolsmithPage.tsx:49-129`）

| 欄位 | 規格 | 實作位置 |
|---|---|---|
| requestId | `slice(0,8)`，完整值放 `title`，等寬 | `:50-56`（`className:'mono'`、`cellTitle: row => row.requestId`、`render: row => row.requestId.slice(0,8)`） |
| target | 原文，等寬 | `:57-62` |
| 發起人 | `requestedBy` 原文 | `:63-67` |
| 狀態 | `tsStatusPill()`：中文標籤 + 顏色（`done`綠/`failed`紅/`needs_clarification`橘/其餘橘） | `:68-72`（`<Badge variant={tsStatusVariant(row.status)}>{tsStatusLabel(row.status)}</Badge>`）；顏色與標籤邏輯見 `toolsmith/format.ts:22-35` |
| 輪次 | `roundsCount`，等寬 | `:73-78` |
| 建立 | `fmt(createdAt)` | `:79-84` |
| 更新 | `fmt(updatedAt)`，`title` 附 `ago(updatedAt)` | `:85-91`（`cellTitle: row => ago(row.updatedAt)`） |
| 摘要 | `request` 超過 60 字截斷 + `…`，否則原文 | `:92-96`（`SUMMARY_MAX=60`，`:26`） |
| log | 研究log/部署log 兩連結，`·` 分隔，不存在則灰字不可點 | `:97-119`（見上表互動點 §4.2/§4.3） |
| 展開按鈕 | 文字 `▸`/`▾` | `:120-128` |

空表頭第 10 欄（規格「（空表頭，展開欄）」）：`ToolsmithPage.tsx:121`（`header: ''`）。

### 2.2 詳情列（規格 §3「詳情列」，`toolsmith/ToolsmithDetail.tsx`）

| 欄位 | 規格 | 實作位置 |
|---|---|---|
| notes | 有值原文，無值 `<span class="mute">（無）</span>` | `:18-21` |
| 完整需求 | `request` 全文，`white-space:pre-wrap` | `:22-26` |
| 待回答問題 | 僅 `pendingQuestions` 有值才顯示整列，`<ul>` 逐條 | `:27-38`（`run.pendingQuestions && run.pendingQuestions.length > 0 && {...}`，falsy 時 `KeyValueGrid` 會濾掉整列——見契約 §4 `KeyValueGrid` 的 falsy-row 語意） |
| 部署關卡 | `gates===null` → 「（部署尚未開始）」；否則每個 gate 一個 pill，`title=label`，內容 `{key}{符號}`，`pass`綠/`fail`紅/`pending`無色 | `:39-52`（`Badge` 迴圈，`tsGateVariant`/`tsGateSymbol` 見 `format.ts:38-49`） |
| 終局結果 | 僅 `finalResult` 有值才顯示；`success`→綠 pill "success"，否則紅 pill "failed"；後接 `stage`（或 `errorKind`）與 `message` | `:53-64` |

外層 `padding:4px 0 8px`（舊版 `<div class="kv" style="padding:4px 0 8px">`）：`ToolsmithDetail.tsx:14`（額外包一層 `<div style={{padding:'4px 0 8px'}}>` 包住 `KeyValueGrid`，因為共用 `KeyValueGrid` 本身不支援 inline style）。

### 2.3 空資料

規格：`<tr><td colspan="10" class="mute">無資料</td></tr>`。實作：`ToolsmithPage.tsx:144`（`emptyText="無資料"`），`columns` 陣列長度剛好 10（`:49-129`），`DataTable` 內部自動用 `colSpan={columns.length}`（`components/shared/DataTable.tsx`），色調預設 `mute`，不需另外指定 `emptyTone`。

---

## 3. 狀態與邊界對照（規格 §5）

| 規格 | 實作位置 |
|---|---|
| 載入中：無 loading 骨架 | `ToolsmithPage.tsx:31`（`resource.data?.rows ?? []`），沒有任何 `loading` 分支渲染，`useResource` 背景輪詢時不清空舊 `data`，天然維持上次內容 |
| 空資料 | 見上方 2.3 |
| 部署尚未開始（`gates===null`）：詳情列顯示「（部署尚未開始）」 | `ToolsmithDetail.tsx:42-51` |
| log 檔不存在：連結降級為灰字純文字，不是隱藏整格 | `ToolsmithPage.tsx:106-107`、`114-115` |
| 錯誤：`GET /api/toolsmith` 例外被外層吞掉，畫面停留舊資料，無 UI 提示 | 本頁完全不讀 `resource.error`，只消費 `resource.data`（`:31`）；`useResource` 出錯時 `data` 維持上一次成功值不被清空，等同「畫面停留舊資料」；未渲染任何錯誤訊息 UI，符合「無 UI 提示」 |
| 排序：無自訂排序，依 API 回傳順序 | `rows = resource.data?.rows ?? []` 直接傳給 `DataTable`（`:142`），未做任何 `sort()` |

---

## 4. 展開狀態在輪詢下保持不收合（契約 §8-2）

契約明文：舊版展開的詳情列每 5 秒被輪詢重繪收合（`innerHTML` 整表重建的副作用）；新版定調
「展開狀態存 React state，輪詢不影響」，不要刻意重現舊版收合行為。

`ToolsmithPage.tsx` 的關鍵 5 行（`:34-42`）：

```tsx
const [expanded, setExpanded] = useState<Set<string>>(new Set())
function toggleExpand(id: string) {
  setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
}
```

- `expanded` 是 `ToolsmithPage` 元件自己的 `useState`，生命週期跟隨元件掛載，與 `useResource` 的
  背景輪詢完全獨立——`topics.toolsmith` 每 5 秒重新 `fetch()` 只會更新 `resource.data`，不會觸發
  `ToolsmithPage` 重新 mount，`expanded` 因此不會被重置。
- `DataTable.renderExpanded`（`:146`：`row => (expanded.has(row.requestId) ? <ToolsmithDetail run={row} /> : null)`）
  每次 render 都依「目前的 `expanded` state + 這一輪拿到的 `row`」重新算要不要展開，所以展開的列
  即使資料內容被輪詢刷新（例如 `status`/`updatedAt` 變了），只要 `requestId` 沒變，仍然保持展開，
  而且展開區塊裡顯示的是**最新一輪**的 `run` 資料（不是凍結在展開當下的舊快照）。
- `rowKey={row => row.requestId}`（`:143`）確保 `DataTable` 用穩定 key，不會因為陣列順序或索引重算
  而錯位到別的列的展開狀態。

---

## 5. 未達成項目

無。規格 §4 列出的 4 個互動點、§3 的欄位渲染、§5 的狀態與邊界，以及契約 §8-2 的展開狀態行為，
皆已對應實作，無遺漏或刻意折衷。

---

## 6. SHARED_LAYER_GAPS

無。本頁未撞到任何共用層缺口——`DataTable`（含 `renderExpanded`）、`Badge`、`KeyValueGrid`、
`Toolbar`、`Button`、`lib/format.ts` 的 `fmt`/`ago`、`lib/navigation.ts` 的 `logsPath()` 均已滿足
本頁需求，未使用任何頁面私有繞法。
