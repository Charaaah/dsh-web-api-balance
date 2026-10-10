/**
 * Browser half of `dsh-web-api-balance`.
 *
 * One surface: a compact balance chip in the composer's trailing status cluster
 * (`conversation.input.right`). Pointing at it — or focusing it with the keyboard —
 * opens a panel with the wallet breakdown, so the chip itself stays small.
 *
 * All network work happens in the Host half; this module only fetches
 * `<basePath>/balance` from its own package-private route, so the API key never
 * reaches page code and the Platform API's missing CORS headers never matter.
 * Written as plain JavaScript against the module-loader factory contract: no JSX,
 * no imports, React comes from the shared table.
 */
;(() => {
  /** Mirrors `BASE_PATH` in `host.js`; changing one means changing both. */
  const BASE_PATH = '/plugins/dsh-web-api-balance'
  /** Locale namespace; every visible string goes through it. */
  const NS = 'dsh-web-api-balance'
  /** Cache key for the last summary, so a reload shows a value before the fetch lands. */
  const STORAGE_KEY = 'dsh-web-api-balance:last'
  /** Seconds between automatic refreshes. */
  const POLL_SECONDS = 300
  /**
   * Public recharge page, used when the Host reports no account-configured
   * origin. A deployment pointed at an internal Platform gets its own link from
   * the Host summary's `topUpUrl`.
   */
  const DEFAULT_TOP_UP_URL = 'https://platform.deepseek.com/top_up'

  /**
   * Official list prices, CNY per 1M tokens, by wire model id. Mirrors
   * <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>; the provider may
   * change them, so an unknown model is reported as unknown rather than guessed.
   *
   * `off` and `peak` are the two time-of-day tariffs (peak is 09:00-12:00 and
   * 14:00-18:00 Beijing time, workdays). Token counts carry no per-request
   * timestamp, so a cumulative fold cannot be split across the two tariffs;
   * every figure here is priced at `peak`, which is the conservative choice and
   * today's real rate during working hours.
   */
  const PRICING = {
    'deepseek-flash': {
      off: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    },
    'deepseek-v4-pro': {
      off: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    },
  }

  /** Retired wire ids the provider still serves and bills under a current model. */
  const PRICING_ALIASES = {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  }

  const ZH = {
    'chip.title': 'DeepSeek API 余额',
    'chip.loading': '余额 …',
    'chip.error': '余额不可用',
    'chip.refresh': '点击刷新',
    'chip.hint': '悬停看明细',
    'chip.topUp': '充值',
    'detail.total': '总余额',
    'detail.toppedUp': '充值余额',
    'detail.granted': '赠送余额',
    'detail.updated': '更新时间',
    'detail.source': '来源',
    'detail.never': '尚未获取',
    'detail.unavailable': '账户余额当前不可用（余额可能已耗尽）。',
    'cost.title': '本次对话消耗',
    'cost.cacheHit': '缓存命中',
    'cost.cacheMiss': '缓存未命中',
    'cost.output': '输出',
    'cost.total': '合计',
    'cost.unknown': '未收录该模型价格',
    'cost.peak': '梁文峰',
    'cost.offPeak': '梁文谷',
    'source.account': 'DeepSeek 账号',
    'source.api-key': 'API Key',
    'error.no-key': '未配置 API Key：请在插件配置里填 apiKey，或设置 DEEPSEEK_API_KEY。',
    'error.no-credential': '没有可用凭证：未登录 DeepSeek 账号，也没找到可用的 API Key。',
    'error.account-failed': '账号服务查询余额失败，请重试或重新登录。',
    'error.account-error': '账号服务异常。',
    'error.unauthorized': 'API Key 无效，或没有查询余额的权限。',
    'error.network': '无法连接 DeepSeek 接口，请检查网络或代理。',
    'error.http': '余额接口返回了错误状态。',
    'error.bad-response': '余额接口返回了无法解析的内容。',
    'error.credential-error': '读取凭证失败。',
    'error.internal': '插件内部错误。',
    'error.unknown': '余额查询失败。',
  }

  const EN = {
    'chip.title': 'DeepSeek API balance',
    'chip.loading': 'Balance …',
    'chip.error': 'Balance unavailable',
    'chip.refresh': 'Click to refresh',
    'chip.hint': 'Hover for details',
    'chip.topUp': 'Top up',
    'detail.total': 'Total balance',
    'detail.toppedUp': 'Topped up',
    'detail.granted': 'Granted',
    'detail.updated': 'Updated',
    'detail.source': 'Source',
    'detail.never': 'Not fetched yet',
    'detail.unavailable': 'The account balance is currently unavailable (it may be exhausted).',
    'cost.title': 'This conversation',
    'cost.cacheHit': 'Cache hit',
    'cost.cacheMiss': 'Cache miss',
    'cost.output': 'Output',
    'cost.total': 'Total',
    'cost.unknown': 'No listed price for this model',
    'cost.peak': 'Liang Wenfeng',
    'cost.offPeak': 'Liang Wengu',
    'source.account': 'DeepSeek account',
    'source.api-key': 'API key',
    'error.no-key': 'No API key: set apiKey in the plugin config, or DEEPSEEK_API_KEY.',
    'error.no-credential': 'No usable credential: not signed in, and no API key was found.',
    'error.account-failed': 'The account service could not read the balance; retry or sign in again.',
    'error.account-error': 'The account service failed.',
    'error.unauthorized': 'The API key is invalid or may not read the balance.',
    'error.network': 'Cannot reach the DeepSeek endpoint; check the network or proxy.',
    'error.http': 'The balance endpoint returned an error status.',
    'error.bad-response': 'The balance endpoint returned something unreadable.',
    'error.credential-error': 'Reading the credential failed.',
    'error.internal': 'Internal plugin error.',
    'error.unknown': 'The balance query failed.',
  }

  /**
   * Build the browser bundle's factory.
   * @param require - the module table's require, resolving the platform baseline.
   * @returns the factory the module loader registers.
   */
  function makeFactory() {
    return (require) => {
      const module = { exports: {} }
      const React = require('react')
      const { createElement: h, useState, useSyncExternalStore } = React

      /**
       * Chip geometry, the hover panel, and one color per chip state. Every color
       * is a host theme token, so light and dark themes follow without overrides.
       */
      const CSS = `
.dshApiBal_anchor { position: relative; display: inline-flex; align-items: center; }
.dshApiBal_chip {
  box-sizing: border-box;
  display: inline-flex;
  align-items: stretch;
  height: 28px;
  max-width: 220px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
}
.dshApiBal_chip:hover { background: var(--dsw-alias-bg-layer-2); }
.dshApiBal_chip:focus-within { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshApiBal_chip[data-state="ready"] { color: var(--dsw-alias-label-primary); }
.dshApiBal_chip[data-state="error"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dshApiBal_chip[data-state="loading"] { color: var(--dsw-alias-label-secondary); }
.dshApiBal_dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: none; }
.dshApiBal_chip[data-state="error"] .dshApiBal_dot { background: var(--dsw-alias-state-error-primary); }
.dshApiBal_chip[data-state="loading"] .dshApiBal_dot { background: var(--dsw-alias-state-idle-primary); }
.dshApiBal_amount { font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
/* The amount half: everything left of the divider refreshes on click. */
.dshApiBal_main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dshApiBal_main:disabled { cursor: default; }
.dshApiBal_main:focus-visible, .dshApiBal_topUp:focus-visible { outline: none; }
/* The top-up half: a slice of the same capsule, hidden until hover or focus. */
.dshApiBal_topUp {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0;
  padding: 0;
  border: 0;
  border-left: .5px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  overflow: hidden;
  opacity: 0;
  transition: width .12s ease, opacity .12s ease;
}
.dshApiBal_chip:hover .dshApiBal_topUp,
.dshApiBal_chip:focus-within .dshApiBal_topUp { width: 22px; opacity: 1; }
.dshApiBal_topUp:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); }
.dshApiBal_topUp svg { display: block; flex: none; }
.dshApiBal_panel {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 1400;
  box-sizing: border-box;
  padding: 10px 12px;
  /* Keeps the collapsed (account-only) panel from shrinking to the longest row. */
  min-width: 176px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  pointer-events: none;
}
/* Two columns once the conversation has a cost: account on the left, spend on the right. */
.dshApiBal_panel[data-has-cost="true"] {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  width: max-content;
  max-width: 460px;
}
.dshApiBal_col { min-width: 0; }
.dshApiBal_colCost { min-width: 180px; }
.dshApiBal_sep { align-self: stretch; margin: 2px 0; border-left: .5px solid var(--dsw-alias-border-l1); }
.dshApiBal_blockTitle {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 2px;
  color: var(--dsw-alias-label-secondary);
}
.dshApiBal_tariff { color: var(--dsw-alias-label-secondary); }
.dshApiBal_note { margin-left: 8px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dshApiBal_lineTotal { margin-top: 2px; padding-top: 4px; border-top: .5px solid var(--dsw-alias-border-l1); font-weight: 500; }
.dshApiBal_line { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.dshApiBal_lineLabel { color: var(--dsw-alias-label-secondary); }
.dshApiBal_lineValue { font-variant-numeric: tabular-nums; }
.dshApiBal_divider { margin: 8px 0 6px; border-top: .5px solid var(--dsw-alias-border-l1); }
.dshApiBal_foot { color: var(--dsw-alias-label-secondary); }
.dshApiBal_alert { color: var(--dsw-alias-state-error-primary); }
`.trim()

      /** @returns the remembered summary, or `undefined` when nothing was stored. */
      function readStored() {
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY)
          if (raw === null) return undefined
          const parsed = JSON.parse(raw)
          return parsed !== null && typeof parsed === 'object' ? parsed : undefined
        } catch {
          return undefined
        }
      }

      /** @param snapshot - the summary to remember across reloads. */
      function writeStored(snapshot) {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
        } catch {
          /* private mode or a full quota: the in-memory snapshot still works */
        }
      }

      const stored = readStored()
      /** The one snapshot this surface renders from. */
      const state = {
        snapshot: stored === undefined ? { status: 'loading' } : { status: 'ready', data: stored },
      }
      const listeners = new Set()
      let inflight = null

      /** @param next - replacement snapshot. */
      function publish(next) {
        state.snapshot = next
        for (const listener of listeners) listener()
      }

      /** @param listener - change callback. @returns unsubscribe. */
      function subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }

      /** @returns the current snapshot (stable reference between changes). */
      function getSnapshot() {
        return state.snapshot
      }

      /**
       * Fetch the Host summary, sharing one in-flight request across callers.
       * @param force - `true` to bypass the Host cache.
       * @returns a promise settling when the snapshot is published.
       */
      function refresh(force) {
        if (inflight !== null) return inflight
        const previous = state.snapshot.status === 'ready' ? state.snapshot.data : undefined
        const pending = (async () => {
          publish(previous === undefined ? { status: 'loading' } : { status: 'loading', previous })
          try {
            const response = await fetch(`${BASE_PATH}/balance${force ? '?refresh=1' : ''}`, {
              headers: { accept: 'application/json' },
            })
            const body = await response.json()
            if (body !== null && typeof body === 'object' && body.ok === true) {
              writeStored(body)
              publish({ status: 'ready', data: body })
            } else {
              publish({
                status: 'error',
                reason: typeof body?.reason === 'string' ? body.reason : 'unknown',
                message: typeof body?.message === 'string' ? body.message : undefined,
              })
            }
          } catch (error) {
            publish({
              status: 'error',
              reason: 'network',
              message: error instanceof Error ? error.message : String(error),
            })
          } finally {
            inflight = null
          }
        })()
        inflight = pending
        // Observations of a failed refresh must never surface as an unhandled
        // rejection: the snapshot already carries the reason.
        pending.catch(() => {})
        return pending
      }

      /** Subscribe to the shared store. @returns the current snapshot. */
      function useBalance() {
        return useSyncExternalStore(subscribe, getSnapshot)
      }

      /**
       * The bundle's stylesheet as one React element, so the surface that is on
       * screen owns it and unmounting removes it.
       * @returns the style element.
       */
      function StyleTag() {
        return h('style', { 'data-plugin-css': name }, CSS)
      }

      /**
       * Format one amount with its own currency.
       * @param amount - numeric amount. @param currency - ISO code from the API.
       * @returns display text, e.g. `¥42.00`.
       */
      function formatMoney(amount, currency) {
        const code = typeof currency === 'string' && currency !== '' ? currency : 'CNY'
        try {
          return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(amount)
        } catch {
          return `${code} ${amount.toFixed(2)}`
        }
      }

      /**
       * Format an observation time down to the second, so a stale reading is
       * recognizable at a glance.
       * @param timestamp - epoch milliseconds.
       * @returns localized `HH:MM:SS` for today, otherwise date plus time.
       */
      function formatTime(timestamp) {
        const date = new Date(timestamp)
        try {
          const time = {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }
          const now = new Date()
          const sameDay =
            date.getFullYear() === now.getFullYear() &&
            date.getMonth() === now.getMonth() &&
            date.getDate() === now.getDate()
          return date.toLocaleString(
            undefined,
            sameDay ? time : { ...time, year: 'numeric', month: '2-digit', day: '2-digit' },
          )
        } catch {
          return date.toISOString().replace('T', ' ').slice(0, 19)
        }
      }

      /**
       * Read one non-negative integer out of a projection value that crossed the
       * wire, so a malformed or absent bucket cannot become a fake cost.
       * @param value - candidate from the projection.
       * @returns the count, or `0` when the value is not a usable number.
       */
      function countOf(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
      }

      /**
       * Resolve the list price of the route serving this conversation.
       *
       * The selection carries the bare wire model id (`deepseek-flash`), but a
       * route may be addressed with its provider prefix (`deepseek-official/…`,
       * which is what the durable logs record). Both spellings resolve here, and
       * a model the table does not list resolves to nothing so the caller reports
       * an unknown price instead of inventing one.
       * @param selection - `modelSelection` projection, or `undefined` when the
       *   host unit is unmounted or no request has been recorded yet.
       * @returns that model's peak tariff, or `undefined` for an unknown model.
       */
      function pricingOf(selection) {
        const raw = selection?.next?.model ?? selection?.lastUsed?.model
        if (typeof raw !== 'string' || raw === '') return undefined
        const slash = raw.lastIndexOf('/')
        const bare = slash === -1 ? raw : raw.slice(slash + 1)
        const id = PRICING[bare] === undefined ? raw : bare
        const alias = PRICING_ALIASES[id]
        return PRICING[id]?.peak ?? (alias === undefined ? undefined : PRICING[alias]?.peak)
      }

      /**
       * Price this conversation's cumulative provider usage in RMB.
       *
       * The rows answer to the official request schema's own split:
       * `prompt_cache_hit_tokens` is the cached input, `prompt_cache_miss_tokens`
       * is the input the cache did not cover, and `completion_tokens` is the
       * output — the API's `prompt_tokens` is exactly the sum of those two input
       * fields, so the three rows cover the whole bill.
       *
       * `cacheWriteTokens` is not a field the official API reports, but the
       * harness folds one, so it is charged as the miss it avoids rather than
       * dropped: cache *storage* itself carries no price, only the tokens do.
       * With no known tariff the counts are still worth showing, so they come
       * back with `priced: false`.
       * @param usage - `tokenUsage` projection, or `undefined` when absent.
       * @param selection - `modelSelection` projection, or `undefined`.
       * @returns per-bucket counts and costs, the total, and whether a tariff was found.
       */
      function sessionCost(usage, selection) {
        if (usage === null || typeof usage !== 'object') return undefined
        const hit = countOf(usage.cacheReadTokens)
        const miss = countOf(usage.uncachedInputTokens) + countOf(usage.cacheWriteTokens)
        const output = countOf(usage.outputTokens)
        if (hit === 0 && miss === 0 && output === 0) return undefined
        const price = pricingOf(selection)
        /** Price one bucket, or `undefined` without a tariff. @returns CNY, or undefined. */
        const cost = (tokens, rate) => (price === undefined ? undefined : (tokens / 1e6) * rate)
        const parts = [
          { key: 'hit', label: 'cost.cacheHit', tokens: hit, cny: cost(hit, price?.cacheHit) },
          { key: 'miss', label: 'cost.cacheMiss', tokens: miss, cny: cost(miss, price?.cacheMiss) },
          { key: 'output', label: 'cost.output', tokens: output, cny: cost(output, price?.output) },
        ]
        const totalCny = price === undefined ? undefined : parts.reduce((sum, part) => sum + (part.cny ?? 0), 0)
        return { parts, totalCny, priced: price !== undefined }
      }

      /**
       * Format a token count with thousands separators.
       * @param tokens - non-negative count.
       * @returns display text, e.g. `1,204,318`.
       */
      function formatTokens(tokens) {
        try {
          return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(tokens)
        } catch {
          return String(Math.round(tokens))
        }
      }

      /**
       * Format a small RMB cost: a sub-cent amount would otherwise read as
       * `¥0.00`, so tiny values keep a third decimal.
       * @param cny - amount in CNY.
       * @returns display text, e.g. `¥0.042`.
       */
      function formatCost(cny) {
        const fractionDigits = cny > 0 && cny < 0.01 ? 3 : 2
        try {
          return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: 'CNY',
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
          }).format(cny)
        } catch {
          return `¥${cny.toFixed(fractionDigits)}`
        }
      }

      /**
       * Which of the provider's two tariffs is in force right now.
       *
       * Peak is 09:00-12:00 and 14:00-18:00 Beijing time on workdays, and the
       * off-peak tariff is exactly half of it. The badge names the two tariffs
       * after the house: 梁文峰 for peak, 梁文谷 for off-peak. The provider's
       * exemption for Chinese public holidays is NOT modelled: no holiday
       * calendar ships with this plugin, so a holiday weekday reads as peak and
       * overstates the price.
       *
       * The reading follows the clock, not the recorded requests. Cumulative
       * usage carries no per-request timestamp, so a session that spans both
       * tariffs cannot honestly claim one of them; this labels the tariff a
       * request sent *now* would pay, which is what a live conversation wants.
       * @param now - the instant to classify; defaults to the current time.
       * @returns `true` for the peak tariff, `false` for off-peak.
       */
      function isPeakTariff(now = new Date()) {
        try {
          // Shift the instant into UTC+8 and read the shifted value as if it were
          // UTC: every getter below then answers in Beijing time, whatever the
          // browser's own zone is.
          const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000)
          const day = beijing.getUTCDay()
          if (day === 0 || day === 6) return false
          const hour = beijing.getUTCHours()
          return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
        } catch {
          return true
        }
      }

      /**
       * Localize one failure snapshot.
       * @param snapshot - an error snapshot. @param t - namespace translate.
       * @returns user-facing text, falling back to the Host's own message.
       */
      function describeFailure(snapshot, t) {
        const key = `error.${snapshot.reason ?? 'unknown'}`
        const text = t(key)
        return text === key ? snapshot.message || t('error.unknown') : text
      }

      /**
       * Localize the credential route a summary came from.
       * @param source - `account` or `api-key`. @param t - namespace translate.
       * @returns display text, or `undefined` when the Host reported none.
       */
      function describeSource(source, t) {
        if (source === undefined) return undefined
        const key = `source.${source}`
        const text = t(key)
        return text === key ? source : text
      }

      /**
       * One label/value row of the detail panel.
       * @param props - `label`, an already-formatted `value`, and an optional extra `className`.
       * @returns the row.
       */
      function Line({ label, value, className }) {
        return h(
          'div',
          { className: className === undefined ? 'dshApiBal_line' : `dshApiBal_line ${className}` },
          h('span', { className: 'dshApiBal_lineLabel' }, label),
          h('span', { className: 'dshApiBal_lineValue' }, value),
        )
      }

      /**
       * One row of the conversation-cost block: a billing bucket whose value is
       * the exact token count, with its estimated price in the value's own note.
       * @param props - `label`, a formatted `tokens`, and an optional formatted `cost`.
       * @returns the row.
       */
      function CostLine({ label, tokens, cost }) {
        return h(
          'div',
          { className: 'dshApiBal_line' },
          h('span', { className: 'dshApiBal_lineLabel' }, label),
          h(
            'span',
            { className: 'dshApiBal_lineValue' },
            tokens,
            cost === undefined ? null : h('span', { className: 'dshApiBal_note' }, cost),
          ),
        )
      }

      /**
       * The conversation-cost column: the three disjoint billing buckets of the
       * session's cumulative provider usage, each with its own price, then the
       * sum. Rendered only once a request has reported usage.
       * @param props - `cost` from `sessionCost`, and the injected `t`.
       * @returns the column.
       */
      function CostColumn({ cost, t }) {
        const rows = cost.parts.map((part) =>
          h(CostLine, {
            key: part.key,
            label: t(part.label),
            tokens: formatTokens(part.tokens),
            cost: part.cny === undefined ? undefined : formatCost(part.cny),
          }),
        )
        return h(
          'div',
          { className: 'dshApiBal_col dshApiBal_colCost', 'data-balance-cost': true },
          h(
            'div',
            { className: 'dshApiBal_blockTitle', key: 'costTitle' },
            h('span', null, t('cost.title')),
            // A tariff only means something when a tariff was actually applied.
            cost.priced ? h('span', { className: 'dshApiBal_tariff' }, t(isPeakTariff() ? 'cost.peak' : 'cost.offPeak')) : null,
          ),
          ...rows,
          h(Line, {
            key: 'costTotal',
            className: 'dshApiBal_lineTotal',
            label: t('cost.total'),
            value: cost.totalCny === undefined ? t('cost.unknown') : formatCost(cost.totalCny),
          }),
        )
      }

      /**
       * The hover/focus panel: this conversation's priced token usage on the
       * right, the wallet total and split on the left, separated by a rule. With
       * no recorded usage yet there is nothing to price, so the panel collapses
       * to the account column alone.
       *
       * The account column has no title and no headline figure: its own total row
       * is that number, and the chip above already carries the title, so repeating
       * either here would only push the two columns out of alignment.
       * @param props - the current `snapshot`, the session `cost`, and the injected `t`.
       * @returns the panel.
       */
      function DetailPanel({ snapshot, cost, t }) {
        const data = snapshot.status === 'ready' ? snapshot.data : undefined
        const source = data === undefined ? undefined : describeSource(data.source, t)
        const rows = []
        if (data !== undefined) {
          rows.push(h(Line, { key: 'total', label: t('detail.total'), value: formatMoney(data.total, data.currency) }))
          if (data.toppedUp !== undefined) {
            rows.push(h(Line, { key: 'topped', label: t('detail.toppedUp'), value: formatMoney(data.toppedUp, data.currency) }))
          }
          if (data.granted !== undefined) {
            rows.push(h(Line, { key: 'granted', label: t('detail.granted'), value: formatMoney(data.granted, data.currency) }))
          }
        }
        const account = h(
          'div',
          { className: 'dshApiBal_col', key: 'account' },
          // A failure replaces the figures, so it must still be told here.
          snapshot.status === 'error' ? h('div', { className: 'dshApiBal_alert', key: 'error' }, describeFailure(snapshot, t)) : null,
          data !== undefined && data.available === false
            ? h('div', { className: 'dshApiBal_alert', key: 'unavailable' }, t('detail.unavailable'))
            : null,
          rows.length === 0 ? null : h('div', { key: 'rows' }, ...rows),
          h('div', { className: 'dshApiBal_divider', key: 'divider' }),
          h(
            'div',
            { className: 'dshApiBal_foot', key: 'updated' },
            `${t('detail.updated')} ${data === undefined ? t('detail.never') : formatTime(data.checkedAt)}`,
          ),
          source === undefined ? null : h('div', { className: 'dshApiBal_foot', key: 'source' }, `${t('detail.source')} ${source}`),
        )
        return h(
          'div',
          {
            className: 'dshApiBal_panel',
            role: 'tooltip',
            id: 'dsh-api-balance-detail',
            'data-has-cost': cost === undefined ? 'false' : 'true',
          },
          account,
          cost === undefined ? null : h('div', { className: 'dshApiBal_sep', key: 'sep', 'aria-hidden': true }),
          cost === undefined ? null : h(CostColumn, { key: 'cost', cost, t }),
        )
      }

      /**
       * The top-up glyph: a wallet outline with a plus, drawn inline so the
       * plugin needs no icon package and inherits the chip's color.
       * @returns the svg element.
       */
      function TopUpIcon() {
        return h(
          'svg',
          {
            width: 13,
            height: 13,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('path', { d: 'M4 8.5A2.5 2.5 0 0 1 6.5 6H17a2 2 0 0 1 2 2v1' }),
          h('path', { d: 'M4 8.5V17a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2' }),
          h('path', { d: 'M20 9v4h-3a2 2 0 0 1 0-4h3Z' }),
          h('path', { d: 'M6 11.5h3.5' }),
          h('path', { d: 'M7.75 9.75v3.5' }),
        )
      }

      /**
       * Compact balance chip in the composer's trailing cluster. One capsule
       * carries two affordances: the amount half refreshes on click, and the
       * right slice — revealed on hover — opens the recharge page in a new tab.
       * Hovering or focusing the capsule reveals `DetailPanel`, whose first block
       * prices this conversation's token usage.
       * @param props - the session projection seat plus the injected `t`.
       * @returns the chip and, while open, its panel.
       */
      function BalanceChip({ useProjection, t }) {
        const snapshot = useBalance()
        const [open, setOpen] = useState(false)
        // Both reads are whole durable folds computed by the Host: the billed
        // buckets accumulated over the log, and the route that served it.
        const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined
        const selection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined
        const cost = sessionCost(usage, selection)
        const busy = snapshot.status === 'loading'
        const data = snapshot.status === 'ready' ? snapshot.data : undefined
        const label =
          data !== undefined ? formatMoney(data.total, data.currency) : busy ? t('chip.loading') : t('chip.error')
        const summary =
          snapshot.status === 'ready'
            ? `${t('chip.title')} · ${t('chip.hint')} · ${t('chip.refresh')}`
            : snapshot.status === 'error'
              ? describeFailure(snapshot, t)
              : t('chip.loading')
        // No balance means nothing to recharge yet, so the slice stays hidden.
        const topUp =
          data === undefined
            ? undefined
            : typeof data.topUpUrl === 'string' && data.topUpUrl !== ''
              ? data.topUpUrl
              : DEFAULT_TOP_UP_URL
        return h(
          'span',
          {
            className: 'dshApiBal_anchor',
            onMouseEnter: () => {
              setOpen(true)
            },
            onMouseLeave: () => {
              setOpen(false)
            },
            onFocus: () => {
              setOpen(true)
            },
            onBlur: () => {
              setOpen(false)
            },
            onKeyDown: (event) => {
              if (event.key === 'Escape') setOpen(false)
            },
          },
          h(StyleTag, { key: 'style' }),
          h(
            'span',
            {
              className: 'dshApiBal_chip',
              'data-state': busy ? 'loading' : snapshot.status === 'ready' ? 'ready' : 'error',
            },
            h(
              'button',
              {
                key: 'amount',
                type: 'button',
                className: 'dshApiBal_main',
                title: summary,
                'aria-label': summary,
                'aria-describedby': open ? 'dsh-api-balance-detail' : undefined,
                disabled: busy,
                onClick: () => {
                  void refresh(true)
                },
              },
              h('span', { className: 'dshApiBal_dot', 'aria-hidden': true }),
              h('span', { className: 'dshApiBal_amount' }, label),
            ),
            topUp === undefined
              ? null
              : h(
                  'button',
                  {
                    key: 'topup',
                    type: 'button',
                    className: 'dshApiBal_topUp',
                    title: t('chip.topUp'),
                    'aria-label': t('chip.topUp'),
                    onClick: () => {
                      window.open(topUp, '_blank', 'noopener,noreferrer')
                    },
                  },
                  h(TopUpIcon, null),
                ),
          ),
          open ? h(DetailPanel, { snapshot, cost, t, key: 'panel' }) : null,
        )
      }

      /** Package name doubles as the plugin name. */
      const name = 'dsh-web-api-balance'
      const inject = ['slots', 'locale']

      /**
       * @param ctx - the page plugin's context (slots, locale, effects).
       */
      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'dsh-web-api-balance: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'dsh-web-api-balance: en dictionary')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('conversation.input.right', function* () {
          yield ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'api-balance',
              order: 20,
              inject: () => ({ t }),
            },
            BalanceChip,
          )
        })

        ctx.effect(() => {
          void refresh(false)
          const timer = window.setInterval(() => {
            void refresh(false)
          }, POLL_SECONDS * 1000)
          return () => {
            window.clearInterval(timer)
          }
        }, 'dsh-web-api-balance: balance polling')
      }

      module.exports = { apply, inject, name }
      return module.exports
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-web-api-balance',
    factory: makeFactory(),
  })
})()
