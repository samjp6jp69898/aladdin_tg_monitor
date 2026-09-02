# tg-monitor React 前端改寫 — 交付說明（待人工審核）

> 產出日期：2026-09-02
> **狀態：待使用者人工審核。舊版 `public/index.html` 原封不動，未刪除、未修改。**

## 一、怎麼看

| | 網址 |
|---|---|
| **前端（React）** | **http://127.0.0.1:8799/next/** |
| 根路徑 `/` | 302 導向 `/next/`（舊書籤仍可用） |

**2026-09-02：舊版 `public/index.html` 已經使用者核准刪除**，React 版成為唯一前端。
舊版最後狀態可從 git 取回：`git show 624ae25:public/index.html`。
本文件與 `tabs/*.md`、各 review 報告中對 `public/index.html` 的引用屬**歷史記錄**（規格即由該檔逐行拆解而來），
刻意保留不改寫，需要對照時用上面的 git 指令取出原檔。

服務由 launchd 常駐（`com.aladdin.tg-monitor`）。
新版改動後要重新 build：`cd frontend && bun run build`（server 每次請求直接讀 `frontend/dist`，不必重啟服務）。
開發模式：`cd frontend && bun run dev`（port 8798，`/api` 自動 proxy 到 8799）。

## 二、架構

```
frontend/
  src/
    api/          傳輸無關的資料層：types.ts / client.ts / endpoints.ts（32 個端點各一函式）
                  / transport.ts（目前輪詢，SSE 接入點已留） / topics.ts
    hooks/        useResource / useAction / useLogFollow / refresh.tsx（↻ 刷新匯流排）
    components/
      shared/     16 個共用元件（使用者指定要有的獨立共用元件目錄）
    lib/          format.ts（移植舊版 helper，刻意保留原行為）/ routes.ts / navigation.ts / mutation.ts
    pages/        11 個分頁，各自可再有同名子目錄放分頁專屬子元件
    styles/       global.css（深色主題 token 由舊版 <style> 完整移植）
```

**設計要點：API 呼叫全部集中在 `src/api/`。** 後端負責人（另一個 session）已定案未來會加 SSE
（單一 `/api/stream?topics=...`、`event: <topic>`、payload 形狀與現有 GET 端點一致）。
屆時只需改 `transport.ts` 一個檔，11 個分頁的元件零改動。

## 三、Parity 驗收結果

11 個分頁全數完成，互動點覆蓋率 **100%**：

| 分頁 | 規格互動點 | 驗到 |
|---|---|---|
| Token 權限 | 14 | 14 |
| Pipelines | 11 | 11 |
| Workers | 7 | 7 |
| TG 已連接 | 6 | 6 |
| TG 待處理 | 5 | 5 |
| Toolsmith | 4 | 4 |
| 總覽 / 即時序列 / 使用 Session / 歷史統計 / Logs | 見各 parity 文件 | 全數 |

**雙軌 review（fresh-context，未讀實作者自述以避免錨定）**
- 視覺：Playwright 對兩版 11 條 route 同時間、同 viewport（1440×1000 fullPage）截圖比對
- 程式碼：逐條對照分頁規格與 `public/index.html` 原始碼

**最終截圖差異**（`migration/review/shots-v3/`，正值＝舊版檔案較大）：

| route | diff (bytes) | |
|---|---|---|
| stats / tg-connected / tg-pending / logs | **0** | 位元組完全相同 |
| events / workers | 1 | |
| toolsmith | 81 | |
| tokens | 89 | |
| sessions | 169 | |
| overview | -338 | 即時資料秒級漂移 |
| pipelines | -1977 | **已知且刻意不修**，見下 |

**新版 console error：0**（舊版那 1 筆是截圖工具 reload 中斷 fetch 造成，見 `review/BASELINE-NOTES.md`）

## 四、刻意與舊版不同的地方（不是缺陷，是定案）

見 `02-frontend-contract.md` §8，摘要：

1. 手動改網址列 hash 現在會正確切分頁（舊版沒監聽 `hashchange`）
2. Toolsmith 展開的詳情列不再被 5 秒輪詢收合（舊版 `innerHTML` 整表重建的副作用）
3. Token 詳情頁的環境 checkbox 不再被輪詢回填沖掉使用者的手動勾選
4. API 非 2xx 會拋 `ApiError`（舊版不檢查 HTTP status）；操作類端點另有 `postResult` 保留業務失敗訊息
5. 「連接」三個 subtab 的 subnav 改由殼層統一渲染（舊版三個 section 各自重複一份），**呈現結果相同**

另外：pipelines 每列的「重試」按鈕在 1440px 下**舊版被裁掉半個字、新版完整顯示**——新版較好，維持現狀。

## 五、已知未處理項目（請使用者裁示）

**1. 跟隨開啟時按重新載入會有短暫文字閃爍**（`useLogFollow`）
`follow=true` 時按 reload，階段 2 的新訂閱可能在階段 1 的 tail 完成前、用舊 offset 打一次 `/api/log/since`，
造成畫面短暫閃爍。由最終複驗 agent 發現，判定**非阻斷性**：不影響最終捲動行為，也不構成訊號繞過。
未修原因：屬本次 parity 範圍外的新發現，且修法會再動一次共用 hook。
**2026-09-02 使用者裁示：先不修。** 保留此紀錄，日後若造成困擾再處理（修法方向：讓階段 2 的
`/api/log/since` 訂閱以 `loadId` 為依賴，確保階段 1 的 tail 完成後才開始增量抓取）。

**2. events / sessions 表格右側的「耗時」與操作連結欄，新舊兩版都沒顯示**
兩版一致，屬既有特性，非本次重寫造成的迴歸，故未動。

## 六、產物索引

| 檔案 | 內容 |
|---|---|
| `00-api-inventory.md` | 32 個端點完整契約（**與後端負責人議定的共同基準**） |
| `01-shell-and-shared.md` | 舊版 CSS token／殼層／路由／共用工具函式盤點 |
| `02-frontend-contract.md` | 共用層對外契約（含 §8 刻意行為差異） |
| `03-shared-layer-patch.md` | 共用層三輪補強紀錄 |
| `04-review-fixes.md` | review 缺陷修復紀錄（11 項） |
| `tabs/*.md` | 11 份分頁規格（重寫的唯一依據） |
| `review/parity-*.md` | 11 份實作者自評對照表 |
| `review/code-review-A/B.md` | fresh-context 程式碼 parity 審查 |
| `review/visual-review-A/B.md` | fresh-context 截圖比對審查 |
| `review/verify-fixes.md`／`verify-blocker-final.md` | 修復複驗 |
| `review/shots-v3/` | 最終版新舊截圖（22 張，已 gitignore，僅存於本機） |
| `review/shot.ts` | 截圖工具：`bun run migration/review/shot.ts [old\|new]` |

## 七、日常使用

**日常只需開 http://127.0.0.1:8799/next/**；根路徑 `/` 會 302 導向過去，舊書籤不會壞。
已 grep 確認全 repo（telegram-dispatcher / aladdin_ai / tg-monitor）**沒有任何通知或腳本會產生指向舊版
UI 的連結**（唯一命中是 `server.ts:4` 的註解），所以不會發生「從別處跳轉又回到舊版」的情形。

舊版已於 2026-09-02 依使用者指示刪除；刪除前確認過工作區乾淨（無他人未提交改動會被毀），
刪除後全 11 條 route 實跑回歸、0 console error。

維護提醒：改動 `frontend/` 底下的程式碼後要 `cd frontend && bun run build`（server 每次請求直讀
`frontend/dist`，不必重啟服務）。純瀏覽不需要任何額外動作。
