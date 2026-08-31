# tg-monitor

本機監控 UI：看 telegram-dispatcher 本體、它 proxy 的五支 hosted MCP server、ngrok tunnel
**目前狀態、現在被誰使用、請求序列、歷史紀錄、log**。只綁 `127.0.0.1:8799`，不經 ngrok、不對外。

```bash
bash /Users/user/aladdin/tg-monitor/monitor.sh start     # → http://127.0.0.1:8799
bash /Users/user/aladdin/tg-monitor/monitor.sh stop
```

常駐（選用）：`cp launchd/com.aladdin.tg-monitor.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aladdin.tg-monitor.plist`

## 監控對象（`lib/services.ts`）

| port | 服務 | 對外前綴 | 使用者歸屬來源 |
|---|---|---|---|
| 8787 | tg-dispatcher webhook | — | 無（不記 per-request） |
| 4040 | ngrok admin API | — | 無 |
| 8788 | aladdin-toolsmith | `/toolsmith` | `mcps/aladdin-toolsmith/logs/audit.jsonl`（2026-08-31 補上） |
| 8789 | aladdin-admin dev | `/mcp-admin-dev` | `mcps/aladdin-admin/logs/audit.jsonl` |
| 8790 | aladdin-platform dev-pk | `/mcp-platform` | `mcps/aladdin-platform/logs/audit.jsonl` |
| 8791 | aladdin-admin pre/cqa | `/mcp-admin-pre` | `…/logs/audit.pre.jsonl` |
| 8792 | aladdin-admin evi | `/mcp-admin-evi` | `…/logs/audit.evi.jsonl` |

port / 路徑對照 `telegram-dispatcher/lib/webhook-server/mcp-proxy.ts` 的 `PROXY_ROUTES` 與各 `launchd/run-server*.sh`；那邊改了這裡要同步。

## 資料來源與儲存

- **SQLite**（`data/monitor.sqlite`，`bun:sqlite`）：
  - `events`：各 hosted server 的 H32 稽核 JSONL 逐行匯入（誰 / 哪個 IP / 哪支 tool / 結果 / 耗時 / agrabah 帳號）。以 inode+offset 續讀、UNIQUE 去重，支援 `.1` 輪替。
  - `status_log`：每 5 秒探測 `/health` + `lsof` 拿 PID，只在 up/down 翻轉時寫一筆。
  - `pipeline_runs`：掃 `telegram-dispatcher/logs/` 逐票 log 檔名（bug / demand），用 `ps` 判斷是否仍在跑。
- **不落地**：bug-lock（`/tmp/bug-analysis-locks`）、token 名冊（只讀 id / display_name / issued_at，**絕不讀或回傳 token 值**）。

## 分頁

- **總覽**：每個 port 的 UP/DOWN、PID、延遲、uptime、1h/24h 請求數、最近 5 分鐘內的使用者；背景 pipeline 併發（Bug 5 / 需求 2）與 bug-lock。
- **即時序列**：稽核事件逐筆時間序（可依服務 / identity / 關鍵字 / 只看錯誤過濾，自動更新，可往前翻頁）。
- **使用 Session**：同一人連續請求間隔 < 10 分鐘合併成一段，顯示時長、請求數、登入帳號、IP、依序呼叫的 tool。
- **歷史統計**：每小時 / 每日 × 服務、使用者排行、tool 排行（錯誤數、平均耗時）、認證失敗來源、名冊。
- **Pipelines**：歷次 /create-mr 與需求 pipeline 的起訖、耗時、結果、log 連結；running 的可按「取消」。需求單的進度在共用的 `demand-pipeline.log`（逐票 stdout 固定為空），結果欄取該次執行在該 log 的最後一行。
  - **取消機制**（`POST /api/pipelines/cancel`）：對 wrapper bash 的全部子孫送 SIGTERM（最深的先），1.5 秒後 wrapper 還活著才 TERM 它，5 秒後殘留補 SIGKILL。這樣 wrapper 的 EXIT trap 會拿到子行程的 143：釋放 bug-lock、發 TG「異常終止 exit=143」給認領人；dispatcher 的 `onExit` 釋放併發名額。行程樹來自 collector 每 3 秒的 `ps` 快照（handler 內不 spawn）。
- **Logs**：tail 任一登錄 log 或逐票 pipeline log，可即時跟隨（輪詢）。路徑有白名單，只能看登錄表內與 dispatcher logs 目錄下的 `.log`。

## Agent trace（需求單詳情頁）

- 來源：`telegram-dispatcher/lib/pipeline-runner/claude-exec.ts` 的 `trace` 選項（2026-08-21 加入），每次 `claude -p` 呼叫落地
  `telegram-dispatcher/logs/agent-traces/<ticket>/<startedAt>-<stage>.json`（prompt + 完整事件陣列 + usage）。stage：
  `spec-gate` → `repo-scope` → `draft-A/B` → `review-convention/…` → `synthesize` → `classify`。Bug pipeline 的 `FAQ-*.stdout.log` 本身就是同格式，視為單一 stage `create-mr`。
- collector 每 3 秒掃一次，摘要進 `agent_runs`（model / tokens / cost / turns / tool calls / 是否錯誤）；完整對話由 `/api/agent-trace?path=` 現讀檔案。
- Pipelines 列表顯示每次執行的 agent 數、tokens in/out、費用；點票號進詳情頁：stage 表（點 stage 看 prompt、逐輪 assistant 文字 / tool_use / tool_result、最終產出）＋ 該次執行的進度 log。
- 只有 trace 功能上線後觸發的執行才有資料；更早的執行 dispatcher 沒有保存 agent 輸出。`NODE_ENV=test`（bun test）下不落地，避免測試污染。

## 已知限制

- Bun 1.2.9 在 request handler 內跑 `Bun.spawnSync` 或用 `ReadableStream` SSE 遇到客戶端中斷會 segfault，所以 `ps`/`lsof` 只在背景 collector 跑並快取、即時跟隨用輪詢。
- 「目前使用中」= 最近 5 分鐘有稽核紀錄；MCP 是無狀態 HTTP，沒有真正的連線存活概念。
- dispatcher 自身（8787）沒有 per-request 稽核，只能看存活與 log；toolsmith 已於 2026-08-31 補上稽核 log（見上表）。
