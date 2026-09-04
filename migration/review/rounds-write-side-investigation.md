# D 組 `review_rounds` / `final_review_rounds`「寫入端已接」擋門調查

日期：2026-09-04
建議落檔位置：`/Users/user/aladdin/tg-monitor/migration/review/rounds-write-side-investigation.md`
（本次無法直接寫入，原因見 §10）
調查範圍：`scripts/switch-readiness.ts` D 組兩格長期未過（最近一次 `--skip-slow` 實跑：`1/5 筆有值`）

**結論：NOT_A_BUG——寫入端已接且正在正確運作。未改任何 production code。**

---

## 1. 一句話結論

`1/5` 不是寫入端缺口，是 **D 組取樣與欄位語意不匹配**造成的假象：
`judgeWriteSideField` 用「最近 N 筆全部有值」這種**通用欄位**判準，去驗 rounds 這種**條件欄位**——
rounds 只有 `kind='bug'` 且**真的跑到 Step 6** 的 run 才該有值，而現行取樣既不濾 `kind`、也不排除提早結案的 run。

現行樣本 5 筆裡，**只有 1 筆具備產生 rounds 的資格，而那 1 筆有值**（1/1）。

---

## 2. 現況擋門逐字重現

以 `mysqlReader.pipelineRuns(FULL)` 餵進 `judgeWriteSideField` 的**同一份輸入**重跑 D 組四格：

```
[OK]   D stderr_path         寫入端已接 — 5/5 筆有值（回填 47、其他 host 12 不計入）
[OK]   D triggered_by        寫入端已接 — 5/5 筆有值
[FAIL] D review_rounds       寫入端已接 — 1/5 筆有值
[FAIL] D final_review_rounds 寫入端已接 — 1/5 筆有值
```

（stderr_path / triggered_by 兩格已自行轉綠，rounds 是 D 組僅存的兩格紅燈。）

rounds 那 5 筆樣本明細：

| # | kind | key | outcome | rr | frr | 該不該有值 |
|---|---|---|---|---|---|---|
| 1 | **demand** | `ALDREQ-782.2026-09-04T01-06-36-737Z.demand-pipeline` | success | null | null | **不可能有**（§3.1） |
| 2 | bug | `FAQ-4866.2026-09-03T11-16-50-858Z` | success | **1** | **1** | 該有 → **有** ✅ |
| 3 | bug | `FAQ-1818.2026-09-03T09-47-21-775Z` | needs_qa_clarification | null | null | **不該有**（§3.2） |
| 4 | **demand** | `ALDREQ-802.2026-09-03T09-13-04-589Z.demand-pipeline` | insufficient_spec | null | null | **不可能有** |
| 5 | **demand** | `ALDREQ-802.2026-09-03T09-11-45-467Z.demand-pipeline` | insufficient_spec | null | null | **不可能有** |

即：3/5 是 demand run，1/5 是提早結案的 bug run，唯一合格的第 2 筆有值。

---

## 3. 為什麼那 4 筆本來就不該有值（不是缺口）

### 3.1 demand run 結構上不可能有 rounds

`persistReviewRounds`（`lib/ingest.ts:511`）第一行就是 `getReviewRoundCounts(ticket, startedAt)`，
它靠 `findPipelineTranscript` 以 transcript 檔頭的 `/create-mr:create-mr <ticket>` 標記找 session。
demand pipeline 沒有這個標記 ⇒ `findPipelineTranscript` 對 demand 恆回 `null` ⇒
`if (!counts) return`（`lib/ingest.ts:512`）直接返回，**sqlite 與 mon_ui 兩側都不會被呼叫到**。

這一點在 `lib/mon-db.ts:380-385` 的註解裡已寫明。實測佐證：**全庫沒有任何 `kind='demand'` 的列有 rounds 值**。

### 3.2 FAQ-1818 從來沒跑到 Step 6

`outcome=needs_qa_clarification`，pipeline 在 grounding/tracer 之後就結案。
產物目錄 `obsidian/Debug/FAQ-1818/` 只有 `analytics.md` / `spec.md` / `grounding.md` / `analysis-notes.md`
（mtime 皆 2026-09-03 17:51–18:27 本地時間，即本輪產出），
**沒有 `reviewer-report.md` / `adversarial-review.md` / `tdd-fidelity-review.md` / `final-adversarial-review.md`**。

對照組 `obsidian/Debug/FAQ-4866/` 四份審查產物齊全，rounds = 1/1。

`reviewRounds = 0` ⇒ sqlite 側 `counts.x > 0 ? x : null`（`lib/ingest.ts:515`）寫 NULL，
mon_ui 側 `NULLIF(?, 0)`（`lib/mon-db.ts:412`）也寫 NULL。**兩側一致，且這正是 a7 2026-09-03 裁定的正確語意**
（「null=不知道，不得轉成 0」，`lib/mon-db.ts:404-410`）。

---

## 4. 寫入端確實已接的正面證據

### 4.1 全量覆蓋率

`host='head'` 且已結束的 bug run 共 22 筆。以 `852ee7b`（2026-09-03T01:52:33Z）為界，
**之後結束的 14 筆中 12 筆有 rounds**，兩筆例外都不是缺口：

```
FAQ-4866.2026-09-03T11-16-50-858Z  success                 rr=1 frr=1
FAQ-1818.2026-09-03T09-47-21-775Z  needs_qa_clarification  rr=null  ← §3.2，未跑到 Step 6
FAQ-4854.2026-09-03T06-53-00-358Z  success                 rr=1 frr=1
FAQ-4813.2026-09-03T06-36-38-320Z  success                 rr=1 frr=1
FAQ-4873.2026-09-03T06-28-26-825Z  success                 rr=1 frr=1
FAQ-4865.2026-09-03T06-14-53-508Z  success                 rr=1 frr=1
FAQ-4872.2026-09-03T05-34-20-472Z  success                 rr=1 frr=1
FAQ-4865.2026-09-03T03-46-26-337Z  recovered               rr=1 frr=1
FAQ-4865.2026-09-03T03-44-20-224Z  recovered               rr=1 frr=1
FAQ-4865.2026-09-03T03-24-45-008Z  recovered               rr=1 frr=1
FAQ-2949.2026-09-03T02-10-38-546Z  success                 rr=2 frr=1
FAQ-4861.2026-09-03T01-17-19-902Z  success                 rr=1 frr=1
FAQ-4867.2026-09-03T00-56-51-494Z  success                 rr=1 frr=1
(run_id 3fb5f684… legacy_key=NULL)  success                rr=null  ← §6.2，孤兒列，非 rounds 問題
```

rr 值有 1 / 2 / 3 的分布（FAQ-1984、FAQ-1828 為 3，FAQ-2949、FAQ-4771 為 2），
不是恆為 1 的常數——說明 transcript 掃描與 `fullReviewRounds`（三位取 min）真的在算，不是巧合。

### 4.2 sqlite ↔ mysql 一致性

22 筆逐筆比對，**只有 3 筆 rounds 不一致**，全部是 2026-09-02 的舊 run（見 §5）。
2026-09-03 01:49 以後的每一筆兩側完全相同。

### 4.3 即時驗證（調查當下正在跑的 run）

`FAQ-4820.2026-09-04T01-31-38-135Z` 執行中，產物只有 `analytics.md` / `spec.md`（Step 1）。
`getReviewRoundCounts` 實測回 `{reviewRounds:0, finalReviewRounds:0}`，mon_ui 對應列 rounds = NULL。
**執行中路徑（`finishedAt=null` 分支）的語意也正確。**

### 4.4 現行 collector 沒有持續失敗

`data/launchd.err.log` 最後四次程序重啟（`tg-monitor ready on …`）之後，
**沒有任何一行 `mon-db: rounds 寫入未成功`**。
較早的那些 WARN 屬「同一 key 連續失敗只印一次、成功後清除」的預期行為，
且對應的 run 事後都取得了值（自癒生效）。

---

## 5. 那 3 筆 2026-09-02 的殘差：出窗歷史，已有既存豁免

| key | finished_at (UTC) | sqlite | mysql |
|---|---|---|---|
| `FAQ-1984.2026-09-02T11-18-55-481Z` | 2026-09-02 12:10:24 | 3 | NULL |
| `FAQ-4855.2026-09-02T08-52-07-989Z` | 2026-09-02 09:44:34 | 1 | NULL |
| `FAQ-4771.2026-09-02T08-12-48-832Z` | 2026-09-02 09:42:19 | 2 | NULL |

成因（`data/launchd.err.log` 第 58-64 行有當時的 `rounds 寫入未成功` 紀錄佐證）：
這三筆在 mon_ui 寫入路徑幾次改版（`3942b28` 2026-09-02T09:37Z → `1e669b6` 10:01Z → `92434b9` 2026-09-03T01:43Z）
期間反覆失敗，等到路徑真正穩定時已經**超出 `ROUNDS_MON_DB_RECENT_WINDOW_MS`（6 小時）**，
`isRoundsMonDbEligible` 正確地不再重試。

sqlite 側則因為 `scanPipelineRuns` 的 finish 分支對**每一個歷史 stdout log** 每個 tick 都重算，
在 `852ee7b`（`bumpReviewRounds` 綁定補 `@` 前綴）修好後把全部歷史 run 一次補齊、沒有窗限制——
**落差方向是「sqlite 有、mysql NULL」，正是 `feac4f2` 引入的 §9.3 `isRoundsExempt` 方向敏感豁免所涵蓋的情形**
（`lib/read/gate-exemptions.ts:60`、`scripts/switch-readiness.ts:631`）。C5 已處理，不需額外動作。

這 3 筆也**不在 D 組樣本內**（D 只取最近 5 筆），對 D 的判定沒有影響。

---

## 6. 順帶查證與發現（不在本次修復範圍，請指揮官裁決去向）

### 6.1 D93 補記「目前資料裡一筆 reviewer stage 都沒有」——事實為真，但推論不成立

查證：`agent_runs` 表全庫確實**沒有任何一列** `agent_name` 屬於
`solution-reviewer` / `adversarial-solution-reviewer` / `tdd-fidelity-reviewer` / `final-adversarial-reviewer`。
每個 bug run 只有一列 `agent_name='create-mr'`（`agent_runs` 記錄的是頂層 `claude -p` session，不是 subagent）。

但由此推不出「所以 rounds 寫不進去」：**rounds 的資料來源根本不是 `agent_runs`**，
而是 `scanTranscriptState` 直接掃 session transcript JSONL 裡的 `tool_use` / `Task` 區塊
（`lib/ingest.ts:838-878`）。FAQ-4866 就是反例：0 筆 reviewer `agent_runs`，rounds 照樣 = 1/1。

**這條推導鏈可以從交接文件裡劃掉。**

### 6.2 孤兒 run 列（runs 列寫入端問題，非 rounds）

FAQ-1984 在 mon_ui 有一列 `run_id=3fb5f684-bca5-4530-930a-2cfa69fb51ce`，
`legacy_key` / `started_at` / `stdout_path` **全為 NULL**，`finished_at=2026-09-03 01:57:16.150`、`outcome=success`。
同一次 run 另有正常列 `9fd469ea-a277-50e0-b1f2-0273c967ed80`（`legacy_key=FAQ-1984.2026-09-03T00-46-00-861Z`，rr=3）。

rounds 已正確寫在正常列上；孤兒列沒有任何對位鍵，`resolveRunIdForRounds` 結構上不可能命中它。
**這是 runs 列寫入端的重複/殘缺列問題，不是 rounds 缺口**，但會讓任何「逐列全欄非 NULL」的擋門長期發紅。

### 6.3 `deriveLegacyKey` 產出的格式與 `legacy_key` 欄位慣例不符 → legacy_key 對位分支是死碼

實測（`resolveRunIdForRounds` 三種參數組合）：

```
FAQ-4866 | deriveLegacyKey = FAQ-4866.2026-09-03T11:16:50.858Z   ← 冒號式
         | legacyKeyOnly   = null          ← 永遠對不到
         | stdoutPathOnly  = 0d8963d2-…    ← 實際靠這條命中
FAQ-1818 | 同上（legacyKeyOnly = null，stdoutPathOnly 命中）
```

原因：`fileTsToIso`（`lib/mon-db.ts:265`）把檔名時間戳轉成**真 ISO（冒號）**，
但 `legacy_key` 欄位的慣例是**等於 sqlite 的 `pipeline_runs.key`（破折號式檔名）**——
`backfill-sqlite.ts:253` 是 `legacy_key: r.key`，telegram-dispatcher 寫入端也是破折號式
（實測全部正常列皆為 `FAQ-4866.2026-09-03T11-16-50-858Z`）。

影響：
- **rounds 路徑**：`ROUNDS_RESOLVE_SQL`（`lib/mon-db.ts:386-389`）的 `legacy_key = ?` 分支恆不命中，
  實際只靠 `stdout_path = ?` 對位。功能上今天沒事（live 列一定有 `stdout_path`），
  但註解與 `PersistRunRoundsInput` 文件宣稱的「雙鍵 fallback」其實只有一條腿。
- **cancel 路徑**：`lib/ingest.ts:214` 也用同一支函式，且 `writeCancelFlag` 會**把冒號式字串寫進 `legacy_key` 欄**。
  實測 mon_ui 裡那 4 筆 cancelled 列（`FAQ-4628.2026-09-03T01:34:41.038Z`、`FAQ-4844…`、`FAQ-4860…`、`FAQ-3098…`）
  正是冒號式，且 `started_at` / `stdout_path` 全 NULL——它們無法被任何以 key 對位的讀取面配對到。
- **既有單測把錯的行為釘住了**：`lib/mon-db.test.ts:165-178` 明確斷言輸出為冒號式。

**建議另開一張單處理，不併入本次**：它跨到經過對抗審查的 cancel 路徑，
且要同步改單測斷言與既有殘留資料，風險與本次「查 rounds 缺口」不同量級。

---

## 7. 對 D 組判準的建議（**未實施，交由指揮官裁決**）

D 組現行寫法對 rounds 而言**永遠不可能轉綠**：demand run 會持續混進最近 5 筆，
提早結案的 bug run（`needs_qa_clarification` / `infra_failure` / `cancelled` / `timeout` / `already_fixed`…）也會。
這不是「還沒接好」，是判準問法錯了。

實測三種取樣的結果：

| 取樣 | review_rounds | final_review_rounds |
|---|---|---|
| 現行（不濾 kind） | FAIL 1/5 | FAIL 1/5 |
| 加 `kind='bug'` | FAIL 4/5 | FAIL 4/5 |
| 加 `kind='bug'` 且 `outcome='success'` | **OK 5/5** | **OK 5/5** |

建議把 `WRITE_SIDE_GAPS` 的兩筆 rounds 加上取樣前置條件
（`judgeWriteSideField` 增一個可選 `eligible?: (r) => boolean`），條件用 `kind === 'bug' && outcome === 'success'`。

**失敗方向分析**（沿用 D 組原本「在兩種失敗方向之間選會叫的那一種」的原則）：
`outcome='success'` 是**列舉法**——未來新增一種也會跑完 Step 6 的成功終態（例如把 `recovered` 也算進來）
不會被計入，最壞情況是**樣本不足 ⇒ 紅燈，有人要解釋**，不會靜默轉綠。
相對地，若改成「排除已知的提早結案 outcome」（排除法），未來新增一種提早結案分類就會被當成合格樣本，
永遠拉低比率或反過來被誤放行。因此**建議列舉、不建議排除**。

**未代為實施的理由**：放寬擋門是改變驗收標準，且本專案這一輪拆掉的四個缺陷全是「形狀完好、實則空轉」的綠燈，
把紅燈改綠應由指揮官親自裁定，不該由查案的人順手做掉。

---

## 8. 查證方法（可重跑）

全部唯讀。mysql 連線一律 `import { getMonitorPool } from './lib/mon-db.ts'`，
以 `bun run` 於 `tg-monitor` 目錄執行（環境變數由 Bun 自動載入 `.env`，未讀取 `.env` 內容）。

1. `runs` 表取 `host='head'` 且 `finished_at IS NOT NULL` 全量，按 `started_at` 新→舊排序，逐筆比對 kind / outcome / rounds。
2. 對每筆 bug run，以 `obsidian/Debug/<ticket>/` 三份 reviewer 產物的 mtime ≥ run `started_at`
   判定「本輪是否真的跑到 Step 6」。
3. 以 `bun:sqlite` 唯讀開 `data/monitor.sqlite`，用 `legacy_key` 對位 `pipeline_runs`，逐筆比對兩軌 rounds。
4. 直接呼叫 `resolveRunIdForRounds` 三種參數組合，區分 legacy_key 與 stdout_path 兩條對位腿各自的命中率。
5. 直接呼叫 `getReviewRoundCounts` 驗證執行中 run 的即時計數。
6. 以 `mysqlReader.pipelineRuns(FULL)` 餵 `judgeWriteSideField` 的邏輯複本，逐字重現 D 組四格輸出。
7. `data/launchd.err.log` 比對 WARN 出現時點與程序重啟邊界；`.git/logs/HEAD` 取各 commit 的 epoch 還原時序。

## 9. 測試

未改任何 production code，因此無新增測試。基準線（`MON_DB_ENABLED=0 bun test`）：

```
前：256 pass, 0 fail, 549 expect() calls, 14 files
後：256 pass, 0 fail（未改動，同一結果）
```

## 10. 交付狀態

**未 commit，且無法寫入 repo。**
本次派工分配到的隔離 worktree 是 `telegram-dispatcher` 的
（`telegram-dispatcher/.claude/worktrees/agent-af50f2d54fc28ec1c`），不是 `tg-monitor`；
harness 拒絕任何指向 `tg-monitor` 共用 checkout 的 git 操作與檔案寫入。

因為結論是 NOT_A_BUG、零程式碼改動，唯一產出就是本報告。
建議指揮官將本檔複製到 `/Users/user/aladdin/tg-monitor/migration/review/rounds-write-side-investigation.md` 後納管。
