/**
 * Offline end-to-end test for the host half: serves a fake DeepSeek
 * `/user/balance` from a loopback HTTP server, registers the plugin's route on a
 * stub context, and calls it over real HTTP. Not shipped.
 */
import { createServer } from 'node:http'
import { once } from 'node:events'

const { apply } = await import('./host.js')

/** How many times the fake upstream was asked. */
let upstreamCalls = 0
/** Upstream reply for the next call. */
let upstream = {
  status: 200,
  body: {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '42.00', granted_balance: '2.00', topped_up_balance: '40.00' },
    ],
  },
}

const upstreamServer = createServer((req, res) => {
  upstreamCalls += 1
  if (req.url !== '/user/balance') {
    res.statusCode = 404
    res.end('{}')
    return
  }
  if (req.headers.authorization !== 'Bearer sk-test') {
    res.statusCode = 401
    res.end('{"error":"unauthorized"}')
    return
  }
  res.statusCode = upstream.status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(upstream.body))
})
upstreamServer.listen(0, '127.0.0.1')
await once(upstreamServer, 'listening')
const upstreamPort = upstreamServer.address().port

/** Captured route registration. */
let route
const effects = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  get: (name) => (name === 'webServer' ? ctx.webServer : undefined),
  logger: { warn: () => {}, info: () => {} },
  webServer: {
    register(input) {
      route = input
      return () => {}
    },
  },
}

apply(ctx, {
  apiKey: 'sk-test',
  baseURL: `http://127.0.0.1:${String(upstreamPort)}`,
  refreshSeconds: 300,
})

if (route === undefined) throw new Error('apply never registered a route')

// Serve the plugin's handler from a second loopback server so requests travel
// over real HTTP, exactly as the browser's fetch will.
const pluginServer = createServer((req, res) => {
  if ((req.url ?? '').split('?')[0] !== route.path) {
    res.statusCode = 404
    res.end('{}')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.statusCode = 500
    res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }))
  })
})
pluginServer.listen(0, '127.0.0.1')
await once(pluginServer, 'listening')
const pluginPort = pluginServer.address().port
const endpoint = `http://127.0.0.1:${String(pluginPort)}${route.path}`

/** @param url - endpoint to call. @returns decoded JSON body. */
async function call(url) {
  const response = await fetch(url)
  return { status: response.status, body: await response.json() }
}

const problems = []
const ok = await call(endpoint)
if (route.kind !== 'exact') problems.push(`route kind is ${String(route.kind)}`)
if (ok.status !== 200) problems.push(`expected 200, got ${String(ok.status)}`)
if (ok.body.ok !== true) problems.push(`expected ok:true, got ${JSON.stringify(ok.body)}`)
if (ok.body.total !== 42) problems.push(`expected total 42, got ${String(ok.body.total)}`)
if (ok.body.granted !== 2) problems.push(`expected granted 2, got ${String(ok.body.granted)}`)
if (ok.body.toppedUp !== 40) problems.push(`expected toppedUp 40, got ${String(ok.body.toppedUp)}`)
if (ok.body.currency !== 'CNY') problems.push(`expected CNY, got ${String(ok.body.currency)}`)
if (ok.body.topUpUrl !== 'https://platform.deepseek.com/top_up') {
  problems.push(`expected the public top-up URL, got ${JSON.stringify(ok.body.topUpUrl)}`)
}

const cached = await call(endpoint)
if (cached.body.checkedAt !== ok.body.checkedAt) problems.push('second read was not served from cache')

const forced = await call(`${endpoint}?refresh=1`)
if (forced.body.checkedAt === ok.body.checkedAt) problems.push('forced read did not re-query upstream')
if (upstreamCalls !== 2) problems.push(`expected 2 upstream calls, got ${String(upstreamCalls)}`)

upstream = { status: 401, body: {} }
const rejected = await call(`${endpoint}?refresh=1`)
if (rejected.body.ok !== false) problems.push('unauthorized answer was not a failure')
if (rejected.body.reason !== 'unauthorized') problems.push(`expected reason unauthorized, got ${String(rejected.body.reason)}`)

/** A fresh stub context whose route registration lands in `route`. */
function stubContext(options = {}) {
  const stub = {
    effect: (fn) => {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    get: (name) => {
      if (name === 'webServer') return stub.webServer
      if (name === 'credentials') return options.credentials
      if (name === 'deepseekAccount') return options.account
      return undefined
    },
    logger: { warn: () => {}, info: () => {} },
    webServer: {
      register(input) {
        route = input
        return () => {}
      },
    },
  }
  return stub
}

// Serve whatever route the latest `apply` registered.
pluginServer.removeAllListeners('request')
pluginServer.on('request', (req, res) => {
  Promise.resolve(route.handler(req, res)).catch(() => {
    res.statusCode = 500
    res.end('{}')
  })
})

// Same key requirement, but with no apiKey in config: the launch environment
// fallback must find whatever `apiKeyEnv` names.
process.env.DSH_BALANCE_TEST_KEY = 'sk-test'
upstream = {
  status: 200,
  body: { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] },
}
apply(stubContext(), {
  apiKeyEnv: 'DSH_BALANCE_TEST_KEY',
  baseURL: `http://127.0.0.1:${String(upstreamPort)}`,
})
const fallback = await call(`${endpoint}?refresh=1`)
if (fallback.body.ok !== true) problems.push(`env fallback failed: ${JSON.stringify(fallback.body)}`)
if (fallback.body.currency !== 'USD') problems.push(`expected USD, got ${String(fallback.body.currency)}`)
if (fallback.body.available !== false) problems.push('is_available:false was not surfaced')

// With nothing configured anywhere, the route must explain itself, not throw.
apply(stubContext(), {
  apiKeyEnv: 'DSH_BALANCE_ABSENT_KEY',
  baseURL: `http://127.0.0.1:${String(upstreamPort)}`,
})
const missing = await call(`${endpoint}?refresh=1`)
if (missing.body.ok !== false || missing.body.reason !== 'no-credential') {
  problems.push(`missing-credential answer was ${JSON.stringify(missing.body)}`)
}

// The credential-free route: a signed-in account grant answers with no API key
// anywhere in the configuration, and upstream is never called.
const callsBeforeGrant = upstreamCalls
apply(
  stubContext({
    account: {
      async getBalance() {
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '13.50' }],
          bonusWallets: [{ currency: 'CNY', balance: '1.50' }],
        }
      },
    },
  }),
  { apiKeyEnv: 'DSH_BALANCE_ABSENT_KEY', baseURL: `http://127.0.0.1:${String(upstreamPort)}` },
)
const grant = await call(`${endpoint}?refresh=1`)
if (grant.body.ok !== true) problems.push(`account route failed: ${JSON.stringify(grant.body)}`)
if (grant.body.source !== 'account') problems.push(`expected source account, got ${String(grant.body.source)}`)
if (grant.body.total !== 15) problems.push(`expected total 15, got ${String(grant.body.total)}`)
if (grant.body.toppedUp !== 13.5) problems.push(`expected toppedUp 13.5, got ${String(grant.body.toppedUp)}`)
if (grant.body.granted !== 1.5) problems.push(`expected granted 1.5, got ${String(grant.body.granted)}`)
if (upstreamCalls !== callsBeforeGrant) problems.push('account route still called the API-key endpoint')

// Signed out (`null` grant) must fall back to the stored API key, not fail.
apply(
  stubContext({
    account: { async getBalance() { return null } },
    credentials: { async resolve() { return { value: 'sk-test' } } },
  }),
  { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: `http://127.0.0.1:${String(upstreamPort)}` },
)
upstream = {
  status: 200,
  body: {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '8.00', granted_balance: '0.00', topped_up_balance: '8.00' }],
  },
}
const signedOut = await call(`${endpoint}?refresh=1`)
if (signedOut.body.ok !== true) problems.push(`signed-out fallback failed: ${JSON.stringify(signedOut.body)}`)
if (signedOut.body.source !== 'api-key') problems.push(`expected source api-key, got ${String(signedOut.body.source)}`)
if (signedOut.body.total !== 8) problems.push(`expected total 8, got ${String(signedOut.body.total)}`)

for (const dispose of effects) if (typeof dispose === 'function') dispose()
pluginServer.close()
upstreamServer.close()

if (problems.length > 0) {
  console.error('host route test: FAILED')
  for (const problem of problems) console.error(` - ${problem}`)
  process.exitCode = 1
} else {
  console.log('host route test: OK')
  console.log(`route: ${String(route.kind)} ${route.path}`)
  console.log(`summary: ${JSON.stringify(ok.body)}`)
  console.log(`upstream calls: ${String(upstreamCalls)}`)
}
