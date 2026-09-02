# Overview 分頁 parity 對照表

實作檔案：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/OverviewPage.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/overview/ServiceCard.tsx`

規格依據：`/Users/user/aladdin/tg-monitor/migration/tabs/overview.md`（下稱「規格」）。

---

## 1. 互動功能對照（規格 §4）

| 規格項次 | 內容 | 實作位置 |
|---|---|---|
| §4.1 服務卡片「重啟」按鈕 | confirm 文案 `確定要重啟「{name}」嗎？\n\n會執行 launchctl kickstart -k 重新拉起該 launchd job，服務會短暫離線幾秒。`；取消則不動作；確認後 POST `/api/services/restart`；alert 顯示成功/失敗訊息；無論成敗都重新整理 | 按鈕渲染：`ServiceCard.tsx:28-36`（僅 `launchdLabel` 存在時顯示，title 為 `launchctl kickstart -k {label}`）。行為：`OverviewPage.tsx:33-41`（`handleRestart`，confirm 文案逐字照抄；`window.alert` 顯示 `已送出重啟：{message}` / `重啟失敗：{message}`；`onSettled: reloadAll` 同時重打 `/api/overview` 與 `/api/status-log`，對應舊版 `refresh(true)` 會重跑整個 `loadOverview()`） |
| §4.2 TG 連接名單「查看」連結 | 「已連接」旁查看 → 跳 tg-connected；「待處理」旁查看 → 跳 tg-pending | `OverviewPage.tsx:167-176`（已連接）與 `OverviewPage.tsx:184-193`（待處理），用 `useNavigate()` + `tgConnectedPath()`/`tgPendingPath()`（`lib/navigation.ts`），`onClick` 內 `preventDefault()` 阻止 `<a href>` 預設行為，語意等同舊版 `onclick="showTab(...);return false"` |
| §4.3 Running Pipeline 表格「取消」按鈕 | 按鈕文案「取消」（`.btn.danger`），confirm 文案 `確定要取消 {kind} pipeline {ticket}？\n\n會送 SIGTERM 給整棵行程樹；wrapper 的收尾會照常執行（釋放 bug-lock、發 TG「異常終止」通知給認領人、釋放併發名額）。`；成功 alert 顯示 `已送出取消：對 {killed.length} 個子行程送出 SIGTERM（{killed.join(', ')}），wrapper {wrapperPid} 會自行收尾。幾秒後列表會更新。`；失敗 alert `取消失敗：{reason}`；之後重新整理 | 按鈕渲染：`OverviewPage.tsx:82-90`（`runningColumns` 的 `actions` 欄，`<Button variant="danger">`）。行為：`OverviewPage.tsx:43-57`（`handleCancel`，confirm 文案逐字照抄；成功分支從 `result.raw`（`CancelPipelineResponse`）取 `killed`/`wrapperPid` 組訊息，因為 `useAction` 的 `message` 欄位在成功時是空字串（後端成功回應沒有 `result`/`reason` 欄位）；失敗分支用 `result.message`；`onSettled: reloadAll`） |
| §4.4 `fillServiceSelects()` | 由 `loadOverview()` 隱含觸發，填 events/sessions 的服務下拉選單 | **不在本頁實作**——依契約 `02-frontend-contract.md §6.3`，這個職責已改由 events / sessions 兩個分頁各自呼叫 `useResource(topics.overview, undefined)` 取得 `services` 自行完成，不再是 overview 分頁的職責。見本檔「未達成項目」說明，此為契約明定的架構調整，非漏做 |

---

## 2. 渲染欄位對照表（規格 §3）

### 2.1 標題動態視窗分鐘數（§3.1）
| 規格欄位 | 實作位置 |
|---|---|
| `d.activeWindowMin` 填入標題 `<span>` | `OverviewPage.tsx:112` |

### 2.2 服務卡片牆（§3.2、§3.2.1）— `ServiceCard.tsx`
| 畫面元素 | 規格欄位 | 實作位置 |
|---|---|---|
| 狀態圓點 | `s.probe.status` | `ServiceCard.tsx:23`（`<StatusDot status={p?.status ?? null} />`） |
| 服務名稱 `.nm` | `s.name` | `ServiceCard.tsx:24` |
| UP/DOWN 徽章 | `up = p.status==='up'` | `ServiceCard.tsx:25-27` |
| 重啟按鈕 | `s.launchdLabel` | `ServiceCard.tsx:28-36` |
| port 標籤 | `s.port` | `ServiceCard.tsx:41` |
| proxy 標籤 | `s.proxyPrefix` | `ServiceCard.tsx:42` |
| launchd 標籤（去 `com.aladdin.` 前綴） | `s.launchdLabel` | `ServiceCard.tsx:43-45` |
| 「狀態」行（`p.detail` 存在才顯示） | `p.detail` | `ServiceCard.tsx:50` |
| 「PID / 延遲」行 | `p.pid`、`p.latencyMs` | `ServiceCard.tsx:51-54` |
| 「uptime」行 | `p.uptimeSeconds`、`lastStatusChange` | `ServiceCard.tsx:55-68`（`upt()` + 條件附加 `(status ago)`） |
| 「請求 1h / 24h」行（`hasAudit`） | `req1h`、`req24h`、`err24h` | `ServiceCard.tsx:69-77` |
| 「最後事件」行（`hasAudit`） | `lastEvent` | `ServiceCard.tsx:78-83` |
| 「名冊人數」行（`hasAudit`） | `rosterSize` | `ServiceCard.tsx:84` |
| 使用者清單三態 | `hasAudit`、`activeUsers` | `ServiceCard.tsx:88-108`（無稽核 / 無人使用 / 逐筆列表三分支） |

### 2.3 Telegram Webhook 卡片（§3.3）
| 規格欄位 | 實作位置 |
|---|---|
| `wh.ok` 為真時 URL / 待送達 / 上次錯誤 / 邊緣 IP 四行 + 查詢時間附註 | `OverviewPage.tsx:126-151` |
| `wh.ok` 為假時查詢失敗訊息 | `OverviewPage.tsx:154` |

### 2.4 TG 連接名單卡片（§3.4）
| 規格欄位 | 實作位置 |
|---|---|
| 已連接數 + 查看連結 | `OverviewPage.tsx:163-178` |
| 待處理數（>0 紅字）+ 查看連結 | `OverviewPage.tsx:180-195` |

### 2.5 背景 Pipeline 併發卡片（§3.5）
| 規格欄位 | 實作位置 |
|---|---|
| Bug /create-mr 併發（用量 + 排隊 pill + 後備值註記） | `OverviewPage.tsx:207-216` |
| 需求 pipeline 併發 | `OverviewPage.tsx:217-226` |
| bug-lock | `OverviewPage.tsx:227` |
| Running 表格（類型/票號/已跑/PID/附註/操作） | `OverviewPage.tsx:71-91`（欄位定義）、`231-245`（渲染 + 空狀態） |
| Queued 表格（排隊/類型/票號/已等/發起人） | `OverviewPage.tsx:93-99`（欄位定義）、`247-257`（僅有資料才渲染） |

### 2.6 最近狀態翻轉卡片（§3.6）
| 規格欄位 | 實作位置 |
|---|---|
| 時間（mono）/服務/狀態（up 綠 down 紅）/detail（mono mute） | `OverviewPage.tsx:101-106`（欄位定義） |
| 只取前 30 筆 | `OverviewPage.tsx:264`（`.slice(0, 30)`） |
| 空狀態「尚無紀錄」 | `OverviewPage.tsx:266-267`（`emptyMode="replace"`） |

---

## 3. 狀態與邊界對照（規格 §5）

| 情境 | 規格表現 | 實作位置 |
|---|---|---|
| Webhook 查詢失敗 | `查詢失敗：{error}` | `OverviewPage.tsx:154` |
| 服務無稽核 log | 「（此服務無稽核 log，無法歸屬使用者）」 | `ServiceCard.tsx:89-92` |
| 有稽核但視窗內無人 | 「目前無人使用」 | `ServiceCard.tsx:93-96` |
| 無背景 pipeline 在跑 | 「目前沒有背景 pipeline 在跑」 | `OverviewPage.tsx:241-244`（`EmptyState`） |
| 無排隊中的 pipeline | 整段不渲染 | `OverviewPage.tsx:247`（`queued.length > 0 &&`，false 時完全不渲染） |
| 狀態翻轉紀錄為空 | 「尚無紀錄」 | `OverviewPage.tsx:266-267` |
| `lastEvent` 為 `null` | 顯示 `-` | `ServiceCard.tsx:80-82` |
| `probe` 為 `null` | 灰點、DOWN 徽章、PID/延遲/uptime 顯示 `-` | `ServiceCard.tsx:16-17,23,25-27,51-54,59`（全部用 `p?.xxx` optional chaining，`p` 為 `null` 時各欄自然落到 `-` / 空字串 / `up=false`） |
| 首次載入（無資料） | 無 loading 骨架，畫面空白 | `OverviewPage.tsx:59`（`if (!overview.data) return null`，不顯示任何 loading 文字） |
| API 呼叫例外 | 畫面不顯示錯誤提示、維持舊資料 | 沿用 `useResource` 內建行為：`error` 狀態存在但本頁未讀取渲染它，等同舊版 `try/catch` 吞掉例外只 console.error；`data` 在請求失敗時維持上一次成功值不被清空（`useResource.ts:88-96` 只有成功時才 `setData`） |

---

## 4. 未達成項目

1. **規格 §4.4 `fillServiceSelects()`**：刻意未在 overview 分頁實作。依 `02-frontend-contract.md §6.3` 明定，events / sessions 分頁改為各自呼叫 `useResource(topics.overview, undefined)` 取得 `services` 陣列並自行 filter `hasAudit`，不再依賴 overview 分頁的副作用產生下拉選單。這是契約層級的架構調整（分頁間不共享可變的模組級狀態），不是遺漏。

2. **附註欄（Running 表格）`white-space:normal`**：舊版該 `<td>` 有 inline style `white-space:normal`，但共用元件 `DataTable` 的 `Column` 只支援 `className`（無法傳自訂 CSS 屬性 white-space:normal 到 `<td>` 本身），且 `global.css` 沒有現成的「白話換行」utility class 可套用又不能新增。改用在 `render()` 內包一層 `<span style={{whiteSpace:'normal'}}>`，實測可讓該欄內文字正常換行（inline 元素的 white-space 設定會覆蓋父層 `<td>` 的 nowrap），視覺效果等同，但嚴格說 CSS 作用對象從 `<td>` 換成了內層 `<span>`。已記錄於 SHARED_LAYER_GAPS。

3. **UP/DOWN 徽章 `margin-left:auto`、重啟按鈕縮小尺寸（`padding:3px 10px;font-size:14px`）**：`Badge` 元件不支援 `style` prop，改用外層 `<span style={{marginLeft:'auto'}}>` 包裹達成同樣的 flex 定位效果；`Button` 元件因繼承原生 `ButtonHTMLAttributes`，`style` prop可直接使用，未受影響。

以上 3 項均為在共用元件能力邊界內找到的等效實作，畫面渲染結果應與舊版一致；如指揮官認為需要共用層補強（例如 `Column` 支援 `cellStyle`），請參考 SHARED_LAYER_GAPS。
