import type { TokenService } from '../../api/types'

/**
 * Token 權限分頁專屬常數。對應舊版 index.html:145-153（新增表單 `.tkc-env`）、
 * index.html:165-173（詳情頁「依勾選重發」`.tkd-env`）、index.html:412（`TK_MANAGED`）。
 *
 * 依契約 `02-frontend-contract.md §5`：這類分頁專屬常數不放共用層，放在自己的
 * `src/pages/tokens/` 底下。
 */

/** 9 個環境的顯示文字，`.tkc-env` 與 `.tkd-env` 共用（migration/tabs/tokens.md §1 環境清單表）。 */
export const ENV_LABELS: Record<TokenService, string> = {
  'admin-dev': 'admin-dev',
  platform: 'platform（dev × PK）',
  'platform-6t': 'platform（dev × 6T）',
  'admin-pre': 'admin-pre',
  'admin-evi': 'admin-evi',
  'platform-pre-pk': 'platform（pre × PK）',
  'platform-pre-6t': 'platform（pre × 6T）',
  'platform-evi-6t': 'platform（evi × 6T）',
  toolsmith: 'toolsmith（工程師）',
}

/**
 * 新增表單 `.tkc-env` 的欄位順序，對應 index.html:145-153。
 * ⚠️ 與 `TKD_ENV_ORDER`（詳情頁）順序不同，照抄舊版兩處各自的順序，不要合併成一份。
 */
export const TKC_ENV_ORDER: TokenService[] = [
  'admin-dev',
  'platform',
  'platform-6t',
  'admin-pre',
  'admin-evi',
  'platform-pre-pk',
  'platform-pre-6t',
  'platform-evi-6t',
  'toolsmith',
]

/** 新增表單預設勾選的環境（index.html:147/148/149/153 的 `checked`）。 */
export const TKC_ENV_DEFAULT_CHECKED: TokenService[] = ['admin-dev', 'platform', 'platform-6t', 'toolsmith']

/**
 * 詳情頁「依勾選重發」`.tkd-env` 的欄位順序，對應 index.html:165-173。
 * ⚠️ 先列 admin-*、再列 platform-*，與新增表單的順序不同，這是舊版兩處各自寫死的原始順序。
 */
export const TKD_ENV_ORDER: TokenService[] = [
  'admin-dev',
  'admin-pre',
  'admin-evi',
  'platform',
  'platform-6t',
  'platform-pre-pk',
  'platform-pre-6t',
  'platform-evi-6t',
  'toolsmith',
]

/**
 * 此頁可管理的環境（server.ts `TK_MANAGED`，index.html:412）。
 * 「重發 token」「移除 token」「刪除此人全部 token」動到哪些環境由此清單與
 * 此人現有的 `grants` 交集決定。
 */
export const TK_MANAGED: TokenService[] = [
  'admin-dev',
  'admin-pre',
  'admin-evi',
  'platform',
  'platform-6t',
  'platform-pre-pk',
  'platform-pre-6t',
  'platform-evi-6t',
  'toolsmith',
]

/** 新增 token 的 id 格式驗證（index.html:459）。 */
export const TOKEN_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/
