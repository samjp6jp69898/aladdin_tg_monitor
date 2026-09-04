// lib/read/write-side-gaps.ts — switch-readiness.ts 的 D 組（寫入端已知缺口）純函式。
//
// **為什麼獨立成檔**：switch-readiness.ts 是一支腳本，模組頂層會直接連監控 DB、印結果、
// `process.exit()`——import 它會把整個擋門當成副作用跑一次。這條判準是純函式，本身該
// 可以被單元測試安全 import，所以拆出來，不碰 db.ts、不連任何 DB。做法同
// `lib/read/gate-exemptions.ts` 頭部註解的先例。

/** 回填列的 host 哨兵（backfill-sqlite.ts 寫死的值）。 */
export const BACKFILL_HOST = 'unknown_pre_migration'

/** D 組的樣本數。樣本不足判 FAIL，不判跳過——樣本不足不等於通過。 */
export const WRITE_SIDE_SAMPLE_N = 5

/** rounds 兩欄的取樣資格（2026-09-04，調查報告 `migration/review/rounds-write-side-investigation.md`）：
 * rounds 是條件欄位，只有 `kind='bug'` 且真的跑到 Step 6 才該有值——demand run 結構上
 * 不可能有（`persistReviewRounds` 對它恆早退），提早結案的 bug run（needs_qa/infra_failure/
 * cancelled/timeout/…）也不該有。原本不濾這兩者，讓 D 組永遠不可能轉綠：demand run 與
 * 提早結案的 run 持續混進「最近 N 筆」樣本，稀釋掉唯一合格的那幾筆。
 * 用**列舉法**（`outcome==='success'`）而非排除法（排除已知的提早結案 outcome）：
 * 未來新增一種提早結案分類，排除法會把它誤當合格樣本、拉低比率或誤放行；
 * 列舉法最壞情況只是樣本不足 ⇒ 紅燈，有人要解釋，不會靜默錯判。與 D 組自身
 * 「列舉 host='head' 而非排除 unknown_pre_migration」是同一條原則。 */
export function isRoundsEligible(r: any): boolean {
  return r?.kind === 'bug' && r?.outcome === 'success'
}

/**
 * D 組判準：「寫入端有沒有真的在填這個欄位」。
 *
 * **修的是什麼**（Reviewer B MAJOR-1）：原判準是「`mysqlReader.pipelineRuns(FULL)`
 * 裡有任一筆該欄非 null」。而 `backfill-sqlite.ts:258,266-268` 把 sqlite 的
 * `stderr_path` / `triggered_by` / `review_rounds` / `final_review_rounds`
 * **原樣複製**進 mysql `runs`（`host='unknown_pre_migration'`）。所以 Phase 6 回填
 * 一跑，D 組四格全綠——**與 spawn-create-mr 有沒有真的寫這些欄位完全無關**，
 * 而驗證寫入端正是 D 組存在的唯一理由。
 *
 * **為什麼用「列舉 host='head'」而不是「排除 host='unknown_pre_migration'」**
 * （這兩者不等價，失敗方向相反，選擇要有理由）：
 *   - **排除法**：未來若出現第三種非 live 來源（另一支回填、匯入工具、測試灌檔），
 *     它的 host 不叫 `unknown_pre_migration`，就會被當成 live ⇒ **靜默轉綠**。
 *   - **列舉法**：新來源不被計入，最壞情況是樣本不足 ⇒ **紅燈，有人要解釋**。
 *   本專案這一輪拆掉的四個缺陷全是「形狀完好、實則空轉」的綠燈，
 *   所以在兩種失敗方向之間，**選會叫的那一種**。
 *
 * **worker run 為什麼不列入樣本**：worker 的 run 也是 live 寫入端產物，但
 * worker 名單是動態的（擴容就多一個），列舉它們會讓判準跟著名冊漂移。
 * head 的樣本足以回答「寫入端有沒有接」這個問題，而且是確定性的。
 * worker 列只計數、印在 detail 供人看，不參與判定——**這使 worker 擴容不會誤報**。
 *
 * **為什麼不是 `filled > 0`**：D 組註解自稱驗的是「切過去畫面上真的會看不到的
 * 東西」，但一筆有值就過的話，1/300 也算「已接」。改成「最近 N 筆全部有值」。
 *
 * **`eligible`（2026-09-04 新增）**：條件欄位（如 rounds）只在符合資格的 run
 * 才該有值；不合格的 run 混進樣本會把「這種 run 結構上不可能有值」誤判成
 * 「寫入端沒接」（見 `isRoundsEligible` 註解與調查報告）。
 */
export function judgeWriteSideField(
  rows: any[],
  opts: { field: string; requireFinished: boolean; sampleN?: number; eligible?: (r: any) => boolean },
): { ok: boolean; detail: string } {
  const n = opts.sampleN ?? WRITE_SIDE_SAMPLE_N
  const backfill = rows.filter(r => r?.host === BACKFILL_HOST).length
  const otherHosts = rows.filter(r => r?.host !== 'head' && r?.host !== BACKFILL_HOST).length
  let live = rows.filter(r => r?.host === 'head')
  if (opts.requireFinished) live = live.filter(r => r?.finished_at !== null && r?.finished_at !== undefined)
  const ineligible = opts.eligible ? live.filter(r => !opts.eligible!(r)).length : 0
  if (opts.eligible) live = live.filter(opts.eligible)
  live = [...live].sort((a, b) => {
    const x = String(a?.started_at ?? '')
    const y = String(b?.started_at ?? '')
    return x === y ? 0 : x < y ? 1 : -1 // started_at 新→舊
  })
  const suffix =
    `｜樣本＝最近 ${n} 筆 host='head'${opts.requireFinished ? ' 且已結束' : ''}${opts.eligible ? ' 且符合資格' : ''} 的 run` +
    `（回填列 ${backfill} 筆、其他 host ${otherHosts} 筆${opts.eligible ? `、不合資格 ${ineligible} 筆` : ''}不計入）`
  if (live.length < n) {
    return { ok: false, detail: `樣本不足：只有 ${live.length} 筆可用，需要 ${n} 筆${suffix}` }
  }
  const sample = live.slice(0, n)
  const missing = sample.filter(r => r[opts.field] === null || r[opts.field] === undefined)
  return {
    ok: missing.length === 0,
    detail: `${n - missing.length}/${n} 筆有值${suffix}`,
  }
}
