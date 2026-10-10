/**
 * Host half of `dsh-web-api-balance`.
 *
 * The browser cannot call the DeepSeek Platform API directly: that surface sends
 * no CORS headers, and a credential must never be shipped into page code. So this
 * half owns the credential and the network call, and the browser reads a plain
 * JSON summary from a package-private route:
 *
 *   GET /plugins/dsh-web-api-balance/balance            → cached summary
 *   GET /plugins/dsh-web-api-balance/balance?refresh=1  → force one live query
 *
 * The summary also carries `topUpUrl` — the Platform recharge page the browser
 * half's top-up slice opens — which the account provider's own `links` supply
 * when it is mounted, and the public recharge page otherwise.
 *
 * Two credential routes, tried in this order, so an ordinary profile needs no
 * configuration at all:
 *
 *  1. **Account grant** (`ctx.deepseekAccount.getBalance`) — the OAuth grant
 *    written by signing in to DeepSeek from Settings → Account. No API key is
 *    involved anywhere; this route is unavailable only while signed out.
 *  2. **Stored API key** — `config.apiKey` when set, else the credentials-service
 *    entry named by `config.apiKeyEnv` (default `DEEPSEEK_API_KEY`, which is
 *    exactly what the Models page writes and what the launching environment may
 *    export instead).
 *
 * Deliberately dependency-free: shipped packages resolve from the dsh
 * installation, not from a bundle's own tree, so this half imports nothing and
 * validates the credential reference itself.
 *
 * @module dsh-web-api-balance
 */

/** The route prefix this package owns; also the base `client.js` fetches. */
export const BASE_PATH = '/plugins/dsh-web-api-balance'

/** The service this half registers its route on. */
export const inject = ['webServer']

/**
 * The grammar a credential-service reference follows (a POSIX shell identifier).
 * Mirrors `@deepseek-ai/dsh-credentials`' `credentialRef` so this bundle needs no
 * import from the dsh installation.
 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** DeepSeek's own endpoint for wallet balances (OpenAI-compatible auth header). */
const DEFAULT_BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'

/** Fallback recharge page when no account provider reports a better origin. */
const DEFAULT_TOP_UP_URL = 'https://platform.deepseek.com/top_up'

/** Upper and lower bounds for the cache window, in seconds. */
const MIN_REFRESH_SECONDS = 30
const MAX_REFRESH_SECONDS = 86_400

/** Per-request timeout for the upstream balance call. */
const REQUEST_TIMEOUT_MS = 10_000

/** JSON-schema-ish surface the plugin manager and `cordis_inspect_query` read. */
const Config = {
  type: 'object',
  dict: {
    apiKey: { type: 'string', meta: { default: '' } },
    apiKeyEnv: { type: 'string', meta: { default: 'DEEPSEEK_API_KEY' } },
    baseURL: { type: 'string', meta: { default: 'https://api.deepseek.com' } },
    refreshSeconds: { type: 'number', meta: { default: 300 } },
  },
  '~standard': {
    version: 1,
    vendor: 'schemastery',
    validate(value) {
      return { value: value && typeof value === 'object' ? value : {} }
    },
  },
}

export { Config }

/**
 * Normalize a configured base URL or full balance URL into the exact endpoint.
 * @param raw - `baseURL` from the plugin config, possibly empty or with slashes.
 * @returns the absolute `/user/balance` endpoint.
 */
function balanceEndpoint(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/u, '') : ''
  if (trimmed === '') return DEFAULT_BALANCE_ENDPOINT
  if (/\/user\/balance$/u.test(trimmed)) return trimmed
  return `${trimmed}/user/balance`
}

/**
 * Read the module's live config as a plain object. The loader hands `apply` the
 * schema-resolved config; this guards the shapes this plugin actually reads.
 * @param config - whatever the loader activated the row with.
 * @returns detached, type-checked settings.
 */
function readConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  const apiKeyEnv =
    typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() !== ''
      ? raw.apiKeyEnv.trim()
      : 'DEEPSEEK_API_KEY'
  const refresh = Number(raw.refreshSeconds)
  const refreshSeconds = Number.isFinite(refresh)
    ? Math.min(Math.max(Math.round(refresh), MIN_REFRESH_SECONDS), MAX_REFRESH_SECONDS)
    : 300
  return { apiKey, apiKeyEnv, endpoint: balanceEndpoint(raw.baseURL), refreshSeconds }
}

/**
 * Read one optional Host service without letting a missing one throw.
 * @param ctx - plugin context.
 * @param name - service key.
 * @returns the service, or `undefined`.
 */
function service(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * The caller identity the account service derives Platform request headers from.
 * Only request provenance and server-side localization depend on it, never the
 * amounts.
 * @returns an `AccountClientMetadata` snapshot.
 */
function accountClient() {
  return {
    version: '1.0.0',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * The recharge page the chip's top-up half links to.
 * @param ctx - plugin context.
 * @returns the account service, or `undefined`.
 */
function accountService(ctx) {
  return service(ctx, 'deepseekAccount')
}

/**
 * Read the Platform recharge link from one resolved account view, tolerating a
 * provider that hands back either the view or a promise of it.
 * @param view - `AccountView`, or a promise of one.
 * @returns an absolute top-up URL, or `undefined`.
 */
async function linkFrom(view) {
  const resolved = typeof view?.then === 'function' ? await view : view
  const link = resolved?.links?.topUpUrl
  return typeof link === 'string' && /^https?:\/\//u.test(link) ? link : undefined
}

/**
 * Resolve the recharge URL, preferring the Platform origin the account provider
 * is configured against so an internal deployment recharges on its own site.
 * @param ctx - plugin context.
 * @returns an absolute top-up URL.
 */
async function resolveTopUpUrl(ctx) {
  const account = accountService(ctx)
  if (account === undefined) return DEFAULT_TOP_UP_URL
  try {
    if (typeof account.getState === 'function') {
      const fromState = await linkFrom(account.getState())
      if (fromState !== undefined) return fromState
    }
    if (typeof account.getProfile === 'function') {
      const fromProfile = await linkFrom(account.getProfile(accountClient()))
      if (fromProfile !== undefined) return fromProfile
    }
  } catch {
    /* fall through: the public recharge page always exists */
  }
  return DEFAULT_TOP_UP_URL
}

/**
 * Turn maybe-numeric upstream fields into a finite number.
 * @param value - candidate number or decimal string.
 * @returns the parsed number, or `undefined`.
 */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Sum a wallet list, keeping the first currency seen (the list is per-currency).
 * @param wallets - `AccountWallet[]` from the account service.
 * @returns total amount and currency.
 */
function sumWallets(wallets) {
  let total = 0
  let currency = 'CNY'
  for (const wallet of wallets) {
    const amount = toNumber(wallet?.balance)
    if (amount !== undefined) total += amount
    if (typeof wallet?.currency === 'string' && wallet.currency !== '') currency = wallet.currency
  }
  return { total, currency }
}

/**
 * Route 1: read the balance through the signed-in account grant. Needs no API key.
 * @param ctx - plugin context.
 * @param checkedAt - timestamp for this query.
 * @returns a summary, or `undefined` when this route cannot answer.
 */
async function queryAccountGrant(ctx, checkedAt) {
  const account = service(ctx, 'deepseekAccount')
  if (account === undefined || typeof account.getBalance !== 'function') return undefined
  let outcome
  try {
    outcome = await account.getBalance(accountClient())
  } catch (error) {
    return {
      ok: false,
      reason: 'account-error',
      message: error instanceof Error ? error.message : String(error),
      checkedAt,
    }
  }
  // `null` means signed out, or the grant changed mid-query: the API-key route
  // still gets its chance, so this reports nothing here.
  if (outcome === null || outcome === undefined) return undefined
  if (outcome.status !== 'ready') {
    return { ok: false, reason: 'account-failed', message: '账号服务查询余额失败。', checkedAt }
  }

  const topped = sumWallets(outcome.value)
  const bonus = sumWallets(outcome.bonusWallets ?? [])
  return {
    ok: true,
    source: 'account',
    topUpUrl: await resolveTopUpUrl(ctx),
    available: true,
    total: topped.total + bonus.total,
    toppedUp: topped.total,
    granted: bonus.total,
    currency: topped.currency,
    checkedAt,
  }
}

/**
 * Route 2: read the balance with an API key.
 * @param ctx - plugin context.
 * @param settings - resolved plugin settings.
 * @param checkedAt - timestamp for this query.
 * @returns a summary; failures come back as `{ ok: false }`.
 */
async function queryApiKey(ctx, settings, checkedAt) {
  let apiKey = settings.apiKey
  if (apiKey === '') {
    const credentials = service(ctx, 'credentials')
    if (credentials !== undefined && CREDENTIAL_REF_PATTERN.test(settings.apiKeyEnv)) {
      const hit = await credentials.resolve(settings.apiKeyEnv)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        apiKey = hit.value
      }
    }
  }
  if (apiKey === '') {
    const ambient = process.env[settings.apiKeyEnv]
    if (typeof ambient === 'string' && ambient.length > 0) apiKey = ambient
  }
  if (apiKey === '') {
    return {
      ok: false,
      reason: 'no-credential',
      message: `没有可用的凭证：既没有登录 DeepSeek 账号，也没有找到 ${settings.apiKeyEnv}（插件配置 apiKey / 凭证服务 / 环境变量）。`,
      checkedAt,
    }
  }

  const endpoint = settings.endpoint
  let response
  try {
    response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'dsh-web-api-balance',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      message: error instanceof Error ? error.message : String(error),
      checkedAt,
    }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized', message: 'API Key 无效或无权查询余额。', checkedAt }
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: 'http',
      message: `余额接口返回 HTTP ${String(response.status)}。`,
      checkedAt,
    }
  }

  let body
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'bad-response', message: '余额接口返回的不是 JSON。', checkedAt }
  }

  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
  const first = infos[0]
  if (first === undefined || typeof first !== 'object') {
    return { ok: false, reason: 'bad-response', message: '余额响应缺少 balance_infos。', checkedAt }
  }

  const granted = toNumber(first.granted_balance)
  const toppedUp = toNumber(first.topped_up_balance)
  const total = toNumber(first.total_balance) ?? (granted ?? 0) + (toppedUp ?? 0)

  return {
    ok: true,
    source: 'api-key',
    topUpUrl: await resolveTopUpUrl(ctx),
    available: body?.is_available !== false,
    total,
    granted,
    toppedUp,
    currency: typeof first.currency === 'string' && first.currency !== '' ? first.currency : 'CNY',
    checkedAt,
  }
}

/**
 * Query the balance once, preferring the credential-free account route.
 * @param ctx - plugin context.
 * @param settings - resolved plugin settings.
 * @returns the summary the browser reads; failures come back as `{ ok: false }`.
 */
async function queryBalance(ctx, settings) {
  const checkedAt = Date.now()
  let byGrant
  try {
    byGrant = await queryAccountGrant(ctx, checkedAt)
  } catch (error) {
    byGrant = {
      ok: false,
      reason: 'account-error',
      message: error instanceof Error ? error.message : String(error),
      checkedAt,
    }
  }
  if (byGrant !== undefined) return byGrant
  try {
    return await queryApiKey(ctx, settings, checkedAt)
  } catch (error) {
    return {
      ok: false,
      reason: 'credential-error',
      message: error instanceof Error ? error.message : String(error),
      checkedAt,
    }
  }
}

/**
 * Write one JSON response.
 * @param res - the HTTP response to own.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** @param ctx - the plugin's context. @param config - the activated row config. */
export function apply(ctx, config) {
  const settings = readConfig(config)

  /** Last summary, reused until it ages out. */
  let cache
  /** In-flight query, so concurrent readers share one upstream call. */
  let inflight

  /**
   * Read the cached summary, querying when it is missing, forced, or stale.
   * @param force - `true` when the caller asked for a live refresh.
   * @returns the summary the route answers with.
   */
  const read = async (force) => {
    const fresh = cache !== undefined && Date.now() - cache.checkedAt < settings.refreshSeconds * 1000
    if (!force && fresh) return cache
    if (inflight !== undefined) return inflight
    inflight = queryBalance(ctx, settings)
      .then((next) => {
        cache = next
        return next
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  ctx.effect(
    () => {
      // Declared through `inject`, so the Loader holds this row until the Web
      // carrier exists. The lookup stays a lookup rather than a property read so
      // a profile without the Web surface reports it instead of failing to
      // activate: the browser half then shows a readable chip state.
      const webServer = service(ctx, 'webServer')
      if (webServer === undefined || typeof webServer.register !== 'function') {
        ctx.logger.warn('dsh-web-api-balance: no webServer service; the balance route is not mounted')
        return () => {}
      }
      return webServer.register({
        kind: 'exact',
        path: `${BASE_PATH}/balance`,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            sendJson(res, 200, await read(url.searchParams.get('refresh') === '1'))
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              reason: 'internal',
              message: error instanceof Error ? error.message : String(error),
              checkedAt: Date.now(),
            })
          }
        },
      })
    },
    'dsh-web-api-balance: balance route',
  )
}
