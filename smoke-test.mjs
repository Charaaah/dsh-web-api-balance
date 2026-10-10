/**
 * Offline smoke test for `client.js`: loads the bundle with a stub module loader
 * and a small stateful React shim, then drives the chip through its closed and
 * hover-open states, both before and after a successful Host answer. Not shipped
 * — it exists to validate the bundle before installation, since no React runtime
 * is installed beside this workspace.
 */

const FRAGMENT = Symbol('react.fragment')

/**
 * A React shim with just enough behavior to re-render on state changes: hook
 * slots persist per mounted component (as React's do) while the read cursor
 * resets each pass, so a handler that calls a setter is visible to the next
 * `__render`. The plugin destructures its hooks, so the current pass lives in a
 * module-scope variable rather than on `this`.
 */
function makeReact() {
  /** Hook slots per mounted component, keyed by the component function. */
  const mounted = new WeakMap()
  /** The hook scope of the pass currently rendering. */
  let scope = { slots: [], cursor: 0 }
  return {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = scope.cursor++
      if (!(index in scope.slots)) {
        scope.slots[index] = typeof initial === 'function' ? initial() : initial
      }
      return [
        scope.slots[index],
        (next) => {
          scope.slots[index] = typeof next === 'function' ? next(scope.slots[index]) : next
        },
      ]
    },
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    /** Render one pass, reusing this component's hook slots. @returns the tree. */
    __render(Component, props) {
      const slots = mounted.get(Component) ?? []
      mounted.set(Component, slots)
      scope = { slots, cursor: 0 }
      return Component(props)
    },
  }
}

const React = makeReact()

/** What the stubbed Host route answers next. */
let payload = { ok: false, reason: 'no-credential', message: 'stub: no credential', checkedAt: Date.now() }
let fetchCalls = 0

/**
 * Session projections the stubbed hook seat answers, keyed by projection key.
 * `undefined` per key reproduces a host whose unit is unmounted or has not
 * reported yet — the state a brand-new conversation starts in.
 */
let projections = { tokenUsage: undefined, modelSelection: undefined }

// The bundle captures `window` and `fetch` from its own scope at load time, so
// the stubs must exist before it is evaluated.
const store = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (input) => { registration = input } },
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value) },
  },
  setInterval: () => 0,
  clearInterval: () => {},
}
globalThis.fetch = async () => {
  fetchCalls += 1
  return { json: async () => payload }
}

const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8'))

/** The bundle's `__ModuleLoader__.load` registration, captured by the window stub. */
let registration

const require = (spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
}
// A real <script> has no `module`/`exports` in scope, so the bundle is evaluated
// with only the globals a page would give it.
const evaluate = new Function('window', 'require', 'fetch', 'console', source)
evaluate(globalThis.window, require, globalThis.fetch, console)

if (registration === undefined) throw new Error('bundle never called __ModuleLoader__.load')
if (registration.id !== 'dsh-web-api-balance') throw new Error(`unexpected id ${String(registration.id)}`)

const plugin = registration.factory(require)
if (typeof plugin.apply !== 'function') throw new Error('plugin has no apply')

const registered = []
const effects = []
const dictionaries = new Map()
const t = (key) => dictionaries.get('zh')?.[key] ?? key
const ctx = {
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  locale: {
    register(ns, locale, dict) {
      dictionaries.set(locale, { ...(dictionaries.get(locale) ?? {}), ...dict })
      return () => {}
    },
    bind: () => t,
  },
  slots: {
    inject(key, callback) {
      const produced = callback()
      if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
        let step = produced.next()
        while (!step.done) {
          registered.push(step.value)
          step = produced.next()
        }
      }
      return () => {}
    },
    register(options, Component) {
      return { options, Component }
    },
  },
}

plugin.apply(ctx)

/** Flatten one element tree into its text content. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.type === FRAGMENT) return node.children.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  // Skip the element's own stylesheet: only rendered copy is under test here.
  if (node.type === 'style') return ''
  return (node.children ?? []).map(textOf).join('')
}

/** @returns the first element whose className contains `className`. */
function findByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child, className)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const own = node.props?.className
  if (typeof own === 'string' && own.split(' ').includes(className)) return node
  // The shim never invokes components, so an unrendered child is a function
  // element: expand it to search the tree it would produce.
  for (const child of node.children ?? []) {
    const hit = typeof child?.type === 'function' && child.type !== FRAGMENT ? findByClass(child.type(child.props), className) : findByClass(child, className)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Collect every element of one class name, expanding component elements as `findByClass` does. */
function findAllByClass(node, className) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    const own = current.props?.className
    if (typeof own === 'string' && own.split(' ').includes(className)) found.push(current)
    for (const child of current.children ?? []) {
      if (typeof child?.type === 'function' && child.type !== FRAGMENT) walk(child.type(child.props))
      else walk(child)
    }
  }
  walk(node)
  return found
}

const problems = []
if (registered.length !== 1) problems.push(`expected 1 registration, got ${registered.length}`)
if (registered[0]?.options.name !== 'conversation.input.right') {
  problems.push(`surface is ${String(registered[0]?.options.name)}`)
}
if (registered.some((r) => r.options.name === 'settings.section')) {
  problems.push('a settings.section registration is still present')
}

const Component = registered[0]?.Component

/**
 * The slot's keyed projection hook seat, as the renderer supplies it: read once
 * per render through whatever the stub currently answers.
 * @param key - projection key.
 * @returns that projection's current stub value.
 */
function useProjection(key) {
  return projections[key]
}

/**
 * Render the chip, hover it, and render again so the opened panel is included.
 * The chip's open state survives across passes (as React's would), so the
 * pointer is moved off and back on to reach the closed state deterministically.
 * @returns `{ closed, opened, tree }` — the two states' text, plus the tree the
 *   opened text came from so callers can inspect what is actually mounted.
 */
function renderHovered() {
  const props = { t, useProjection }
  const mounted = React.__render(Component, props)
  const anchorOf = (tree) => findByClass(tree, 'dshApiBal_anchor')
  anchorOf(mounted)?.props.onMouseLeave?.()
  const closed = React.__render(Component, props)
  const anchor = anchorOf(closed)
  if (anchor === undefined || typeof anchor.props.onMouseEnter !== 'function') {
    problems.push('anchor does not expose onMouseEnter')
    return { closed: textOf(closed), opened: '', tree: closed }
  }
  anchor.props.onMouseEnter()
  const opened = React.__render(Component, props)
  return { closed: textOf(closed), opened: textOf(opened), tree: opened }
}

/**
 * Drain pending microtasks and timers so the in-flight refresh settles, then
 * assert that the bundle actually reached the Host route.
 * @param label - which phase is settling, for the failure message.
 */
async function settle(label) {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  if (fetchCalls < 1) problems.push(`${label}: the bundle never fetched the Host route`)
}

/**
 * Render one pass of the registered chip with the framework-shaped props.
 * @returns the rendered tree, with whatever open state the chip currently holds.
 */
function renderChip() {
  return React.__render(Component, { t, useProjection })
}

/**
 * Render one pass with the pointer explicitly off the chip, so the assertion
 * does not depend on which state the previous pass left behind.
 * @returns the rendered tree.
 */
function renderClosed() {
  const mounted = renderChip()
  findByClass(mounted, 'dshApiBal_anchor')?.props.onMouseLeave?.()
  return renderChip()
}

// Before the Host answers: the panel explains the failure instead of showing money.
await settle('failure phase')
const before = renderHovered()
if (before.closed.trim() === '') problems.push('chip rendered no text')
const closedTree = renderClosed()
if (findByClass(closedTree, 'dshApiBal_panel') !== undefined) {
  problems.push('detail panel rendered while closed')
}
if (!before.opened.includes('没有可用凭证')) {
  problems.push(`failure panel did not localize (got ${JSON.stringify(before.opened)})`)
}
// A conversation with no reported usage has nothing to price, so the cost block stays out.
if (findByClass(closedTree, 'dshApiBal_block') !== undefined) {
  problems.push('cost block rendered before any provider usage was reported')
}
// While no balance has been read there is nothing to recharge, so the slice is absent.
if (findByClass(closedTree, 'dshApiBal_topUp') !== undefined) {
  problems.push('top-up half rendered before any balance was known')
}

// The billed buckets and the route that served them, as the Host folds report
// them. 1M cache hits, 2M misses, 0.5M output on the stronger model.
projections = {
  tokenUsage: {
    uncachedInputTokens: 2_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
  },
  modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-v4-pro' }, next: null },
}

// After a successful answer: every money row plus the credential route.
payload = {
  ok: true,
  source: 'account',
  topUpUrl: 'https://platform.deepseek.com/top_up',
  available: true,
  total: 15,
  toppedUp: 13.5,
  granted: 1.5,
  currency: 'CNY',
  checkedAt: Date.UTC(2026, 9, 10, 12, 0, 0),
}
// Let the in-flight refresh settle before asserting on the ready state.
await settle('success phase')

// Re-run the poller's path once the payload is good: the amount half's click
// handler calls the same refresh.
const clickTarget = findByClass(renderChip(), 'dshApiBal_main')
if (clickTarget !== undefined && typeof clickTarget.props.onClick === 'function') {
  clickTarget.props.onClick()
  await settle('click refresh')
} else {
  problems.push('the amount half does not expose onClick')
}

const after = renderHovered()
for (const expected of ['总余额', '充值余额', '赠送余额', '更新时间', '来源', 'DeepSeek 账号']) {
  if (!after.opened.includes(expected)) {
    problems.push(`success panel missing "${expected}" (got ${JSON.stringify(after.opened)})`)
  }
}
// The account column carries the total once, as its own row — no headline and no
// repeated panel title, since the chip above the panel already owns the name.
// The chip itself also prints the total, so only the panel's own text counts.
const panelText = (() => {
  const panel = findByClass(after.tree, 'dshApiBal_panel')
  return panel === undefined ? '' : textOf(panel)
})()
if (!panelText.includes('15.00')) problems.push(`success panel missing the total (got ${JSON.stringify(panelText)})`)
if (panelText.split('15.00').length - 1 !== 1) {
  problems.push(`the total is rendered ${String(panelText.split('15.00').length - 1)} times in the panel, expected once`)
}
if (panelText.includes('DeepSeek API 余额')) problems.push('the panel still repeats the chip title')
if (findByClass(after.tree, 'dshApiBal_total') !== undefined) problems.push('a headline figure is still rendered')
if (after.opened === before.opened) problems.push('the panel did not change after a successful refresh')
// The observation time must be precise to the second.
if (!/\d{1,2}:\d{2}:\d{2}/u.test(after.opened)) {
  problems.push(`panel time is not precise to the second (got ${JSON.stringify(after.opened)})`)
}

// The conversation-cost column: the three billing buckets, each priced at
// deepseek-v4-pro peak list rates (¥0.30 / ¥9 / ¥27 per 1M tokens).
const priced = renderHovered()
if (!priced.opened.includes('本次对话消耗')) {
  problems.push(`cost column did not render once usage was reported (got ${JSON.stringify(priced.opened)})`)
}
if (priced.closed.includes('本次对话消耗')) problems.push('cost column leaked into the closed chip')
for (const expected of ['本次对话消耗', '缓存命中', '缓存未命中', '输出', '合计']) {
  if (!after.opened.includes(expected)) {
    problems.push(`cost column missing "${expected}" (got ${JSON.stringify(after.opened)})`)
  }
}
for (const expected of ['1,000,000', '2,000,000', '500,000', '¥0.30', '¥18.00', '¥13.50', '¥31.80']) {
  if (!after.opened.includes(expected)) {
    problems.push(`cost column missing "${expected}" (got ${JSON.stringify(after.opened)})`)
  }
}

// The account and cost columns are siblings separated by a rule, and the panel
// must collapse to the account column alone when there is nothing to price.
const openTree = priced.tree
const panel = findByClass(openTree, 'dshApiBal_panel')
if (panel === undefined) problems.push('the hovered panel is not in the tree')
else {
  if (panel.props['data-has-cost'] !== 'true') problems.push('the panel did not mark itself as having a cost column')
  const columns = findAllByClass(panel, 'dshApiBal_col').map((column) =>
    column.props['data-balance-cost'] === true ? 'cost' : 'account',
  )
  if (columns.join(',') !== 'account,cost') {
    problems.push(`panel columns are ${JSON.stringify(columns)}, expected account then cost`)
  }
  if (findByClass(panel, 'dshApiBal_sep') === undefined) problems.push('the rule between the two columns is missing')
}
// The tariff badge reports which of the two tariffs the current clock is in:
// peak is 09:00-12:00 and 14:00-18:00 Beijing time on workdays, half price else.
const beijingNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
const beijingDay = beijingNow.getUTCDay()
const expectPeak = beijingDay !== 0 && beijingDay !== 6 && [9, 10, 11, 14, 15, 16, 17].includes(beijingNow.getUTCHours())
const expectedTariff = expectPeak ? '梁文峰' : '梁文谷'
const tariffNode = findByClass(openTree, 'dshApiBal_tariff')
if (tariffNode === undefined) problems.push('the tariff badge is missing from a priced conversation')
else if (textOf(tariffNode) !== expectedTariff) {
  problems.push(`tariff badge reads ${JSON.stringify(textOf(tariffNode))}, expected ${JSON.stringify(expectedTariff)}`)
}
if (!after.opened.includes('缓存未命中')) problems.push('the priced panel lost its miss row')
// An unknown model keeps the exact counts but must not invent a price.
projections = {
  ...projections,
  modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-v5-unknown' }, next: null },
}
const unpriced = renderHovered()
if (!unpriced.opened.includes('未收录该模型价格')) {
  problems.push(`unknown route did not report missing pricing (got ${JSON.stringify(unpriced.opened)})`)
}
if (!unpriced.opened.includes('2,000,000')) problems.push('unknown route dropped the exact token counts')
// No tariff was applied, so the badge must not claim one.
if (findByClass(unpriced.tree, 'dshApiBal_tariff') !== undefined) {
  problems.push('unknown route still claimed a tariff')
}
// With nothing to price the panel collapses to the account column alone.
projections = { ...projections, tokenUsage: undefined }
const collapsed = renderHovered()
const collapsedPanel = findByClass(collapsed.tree, 'dshApiBal_panel')
if (collapsedPanel === undefined) problems.push('the panel disappeared with no usage reported')
else {
  if (collapsedPanel.props['data-has-cost'] !== 'false') problems.push('the costless panel did not mark itself')
  if (findByClass(collapsedPanel, 'dshApiBal_sep') !== undefined) problems.push('the column rule survived without a cost column')
  if (findByClass(collapsedPanel, 'dshApiBal_colCost') !== undefined) problems.push('the cost column survived with no usage')
}
projections = {
  ...projections,
  tokenUsage: { uncachedInputTokens: 2_000_000, outputTokens: 500_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
}
// A retired wire id the provider still bills under the current flash model:
// the hit bucket alone proves the flash tariff was applied rather than the pro
// one, and the amount is chosen so it cannot collide with the balance rows.
projections = {
  ...projections,
  modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-v4-flash' }, next: null },
}
const aliased = renderHovered()
if (!aliased.opened.includes('¥0.04')) {
  problems.push(`an aliased retired wire id was not priced at its current model tariff (got ${JSON.stringify(aliased.opened)})`)
}
// The two families must not be priced alike: flash's hit rate is ¥0.04 and
// pro's is ¥0.30, so the same counts must produce different money.
const flashTree = aliased.tree
const proTree = priced.tree
const flashCosts = findAllByClass(flashTree, 'dshApiBal_note').map(textOf)
const proCosts = findAllByClass(proTree, 'dshApiBal_note').map(textOf)
if (flashCosts.join(',') === proCosts.join(',')) {
  problems.push(`flash and pro were priced identically (${JSON.stringify(flashCosts)})`)
}
// The same model addressed with its provider prefix must resolve to the same
// tariff, since the durable logs record routes as `<provider>/<model>`.
projections = {
  ...projections,
  modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-official/deepseek-flash' }, next: null },
}
const prefixed = renderHovered()
if (findAllByClass(prefixed.tree, 'dshApiBal_note').map(textOf).join(',') !== flashCosts.join(',')) {
  problems.push('a provider-prefixed route was not priced like its bare model id')
}
// A cache write is not a separately priced bucket in the official schema, so it
// must be charged as the miss it avoids: 1.5M uncached + 0.5M written joints into
// one 2M miss row, which at flash peak rates is ¥4.00.
projections = {
  ...projections,
  tokenUsage: { uncachedInputTokens: 1_500_000, outputTokens: 500_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 500_000 },
}
const withWrite = renderHovered()
if (!withWrite.opened.includes('¥4.00')) {
  problems.push(`a recorded cache write was not charged at the miss rate (got ${JSON.stringify(withWrite.opened)})`)
}
if (!withWrite.opened.includes('2,000,000')) {
  problems.push(`a recorded cache write was not folded into the miss count (got ${JSON.stringify(withWrite.opened)})`)
}
if (findAllByClass(withWrite.tree, 'dshApiBal_note').length !== 3) {
  problems.push('a cache write produced its own priced row instead of joining the miss bucket')
}
projections = {
  ...projections,
  tokenUsage: { uncachedInputTokens: 2_000_000, outputTokens: 500_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
}
// The selection's `next` is the tariff the next request pays, so it wins over
// `lastUsed` — that is the switch a user has just made and not yet spent on.
projections = {
  ...projections,
  modelSelection: {
    lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' },
    next: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  },
}
if (!findAllByClass(renderHovered().tree, 'dshApiBal_note').map(textOf).join(',').includes('¥18.00')) {
  problems.push('a pending model switch was not priced at the newly selected model')
}

// The capsule's right slice: one extra affordance, opened in a new tab.
const readyTree = renderChip()
const topUpButton = findByClass(readyTree, 'dshApiBal_topUp')
if (topUpButton === undefined) problems.push('the top-up half did not render once a URL was reported')
else {
  if (topUpButton.type !== 'button') problems.push(`top-up half is <${String(topUpButton.type)}>, not a button`)
  if (topUpButton.props.title !== '充值') problems.push(`top-up title is ${JSON.stringify(topUpButton.props.title)}`)
  const opened = []
  const originalOpen = globalThis.window.open
  globalThis.window.open = (...args) => {
    opened.push(args)
  }
  topUpButton.props.onClick()
  globalThis.window.open = originalOpen
  if (opened.length !== 1) problems.push(`top-up click opened ${String(opened.length)} targets`)
  else {
    if (opened[0][0] !== 'https://platform.deepseek.com/top_up') {
      problems.push(`top-up opened ${JSON.stringify(opened[0][0])}`)
    }
    if (opened[0][1] !== '_blank') problems.push(`top-up target is ${JSON.stringify(opened[0][1])}`)
  }
}

// A Host summary without `topUpUrl` must still offer the public recharge page.
payload = { ok: true, source: 'api-key', available: true, total: 3, currency: 'CNY', checkedAt: Date.now() }
const noUrlTree = renderChip()
const fallbackButton = findByClass(noUrlTree, 'dshApiBal_topUp')
if (fallbackButton === undefined) {
  problems.push('top-up half disappeared when the Host reported no URL')
} else {
  const opened = []
  const originalOpen = globalThis.window.open
  globalThis.window.open = (...args) => {
    opened.push(args)
  }
  fallbackButton.props.onClick()
  globalThis.window.open = originalOpen
  if (opened[0]?.[0] !== 'https://platform.deepseek.com/top_up') {
    problems.push(`fallback top-up opened ${JSON.stringify(opened[0]?.[0])}`)
  }
}

for (const key of [
  'chip.title',
  'chip.error',
  'chip.hint',
  'detail.total',
  'detail.updated',
  'detail.source',
  'error.no-credential',
  'cost.title',
  'cost.cacheHit',
  'cost.cacheMiss',
  'cost.output',
  'cost.total',
  'cost.unknown',
  'cost.peak',
  'cost.offPeak',
]) {
  if (!dictionaries.get('zh')?.[key]) problems.push(`zh dictionary missing ${key}`)
  if (!dictionaries.get('en')?.[key]) problems.push(`en dictionary missing ${key}`)
}

for (const dispose of effects) if (typeof dispose === 'function') dispose()

if (problems.length > 0) {
  console.error('client bundle smoke test: FAILED')
  for (const problem of problems) console.error(` - ${problem}`)
  process.exitCode = 1
} else {
  console.log('client bundle smoke test: OK')
  console.log(registered.map((r) => `${r.options.name} <- ${String(r.options.id)}`).join('\n'))
  console.log(`closed: ${JSON.stringify(before.closed)}`)
  console.log(`opened: ${JSON.stringify(after.opened)}`)
}
