# dsh-web-api-balance

[![License: MIT](https://img.shields.io/badge/license-MIT-2f855a?style=flat-square)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0969da?style=flat-square)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f46e5?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
![no build step](https://img.shields.io/badge/build-none%20%C2%B7%20source%20only-6b7280?style=flat-square)
![no dependencies](https://img.shields.io/badge/dependencies-0-6b7280?style=flat-square)

在 DeepSeek Harness 的 Web 界面里显示 DeepSeek API 账户余额**与本次对话花了多少钱**。

![示意图：输入框旁的余额胶囊，悬停展开余额与消耗两栏](assets/preview.svg)

界面只有一个：输入框工具栏（发送键左侧）的**常驻余额胶囊**，显示总额。
**鼠标移上去**（键盘聚焦同理）弹出明细浮层，左右两栏，中间一条竖线：

```
总余额      ¥15.00  │   本次对话消耗     梁文谷
充值余额    ¥13.50  │   缓存命中    1,000,000   ¥0.30
赠送余额     ¥1.50  │   缓存未命中  2,000,000   ¥18.00
更新时间    20:00:00│   输出          500,000   ¥13.50
来源        DeepSeek 账号│   ────────────────────────────
                    │   合计                    ¥31.80
```

左边是账户余额，右边是**当前会话的消耗**（有用量报告后才出现；没有用量时右栏连同竖线
一起消失，浮层退回单栏）。两栏顶部对齐：账户栏不重复胶囊上已有的名称，也不单独再打一遍
总额 —— 账户总额就是它自己的「总余额」那一行。

胶囊本身分成两半，**没有额外按钮、没有文字**：

| 区域 | 行为 |
|---|---|
| 左半（圆点 + 金额） | 点击立即刷新余额 |
| 右半（悬停时才展开的 22px 竖条 + 钱包加号图标） | 点击在新标签页打开充值页 |

右半平时宽度为 0、完全不可见，鼠标进入胶囊才滑出，所以静止状态下胶囊仍然只是一个
干净的数字。取不到余额时（没有金额可充）整个右半不渲染，胶囊变红，浮层里写明原因。

充值地址优先用账号服务给出的 `AccountView.links.topUpUrl`（这样指向内部 Platform 的
部署会跳自己的站点），拿不到就用公开充值页 `https://platform.deepseek.com/top_up`；
浏览器半侧也内置了同一个兜底地址，所以宿主没报告地址时右半照样可用。

数据来自 DeepSeek 官方 `GET https://api.deepseek.com/user/balance`，或者
（登录了账号时）DSH 自己的账号服务。

## 本次对话消耗

官方的 token 计数看不出花了多少钱，所以浮层右栏直接把**这一条会话累计的用量按人民币
拆开算给你看**，三个计费桶分开、最后一行是合计：

| 行 | 取数 | 说明 |
|---|---|---|
| 缓存命中 | `tokenUsage.cacheReadTokens` | 命中上下文缓存的输入，按低价档计 |
| 缓存未命中 | `tokenUsage.uncachedInputTokens` + `cacheWriteTokens` | 未命中的输入，按高价档计 |
| 输出 | `tokenUsage.outputTokens` | 模型输出（含思考 tokens，官方口径已包含） |
| 合计 | 上面三项之和 | 等于官方账单口径 |

官方请求 schema 里 `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`，
所以这三行正好覆盖全部计费 token，不多不少。另外，**缓存本身不单独收费**：
官方只按上面三档计价，缓存落盘、存储、过期都不额外计费（缓存"尽力而为"，不用后
几小时到几天自动清空，也不产生费用）。

取数走的是 DSH 自己的会话投影（`useProjection('tokenUsage')`），也就是宿主按整条会话
日志折出来的**官方回报用量**，不是估计值；模型单价按 `useProjection('modelSelection')`
里的当前路由查表。这两个投影都由宿主推送，所以用量一有回报浮层就更新，不需要额外请求，
也不会把任何数据发出去。

关于价格，有两点必须说清楚：

1. **单价是硬编码的官方表**（`client.js` 里的 `PRICING`），单位「元 / 百万 tokens」。
   官方随时可能调价，届时改这一个对象即可。表中未收录的模型**不会瞎猜**：照样显示
   精确的 token 数，金额位置写「未收录该模型价格」。旧模型名
   （`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`）按官方说明归到 `deepseek-flash` 计价。
2. **峰谷自动判断**：右栏标题右边那个名字就是当前生效的档位 —— 北京时间工作日
   9:00–12:00 与 14:00–18:00 显示「**梁文峰**」（高价档），其余时间显示「**梁文谷**」
   （半价档）。判断在每次渲染时按当前时钟做一次，并且是把瞬时时间换算成 UTC+8 之后读的，
   所以浏览器在哪个时区都不影响。**官方的中国法定节假日豁免没有建模**（插件不带节假日
   日历），节假日的工作日会显示「梁文峰」并把价格估高。
   另外，累计用量里没有每次请求的时间戳，跨了峰谷的会话无法诚实地归到某一档，
   所以这个名字表示的是「此刻发出的请求按哪一档计价」。

另外三点口径：

- **按模型计价，flash 和 pro 不是一个价。** 单价从 `modelSelection` 投影里读当前路由，
  表里 `deepseek-flash` 与 `deepseek-v4-pro` 是分开的两套价（命中 ¥0.04/¥0.30、
  未命中 ¥2/¥9、输出 ¥8/¥27，均为高峰价），路由带不带 provider 前缀
  （`deepseek-official/…`）都能对上；`next` 优先于 `lastUsed`，所以你刚在模型选择器里
  改过、下一次请求才用的那个模型，显示的也是它。
- 数字是**当前这条会话**的累计用量，不包含子代理（子代理各自是独立会话，有自己的
  用量），也不是整个账号的历史账单。要看账号侧消耗请用官方平台的用量页。
- 累计用量是**一条会话一个总数**，里面没有"哪一段用了哪个模型"。所以如果一条会话中途
  从 flash 换到 pro，显示的是**把整条会话按当前模型单价算**的结果 —— 混用过就是估值，
  没换过就是准的。会话切换时组件会重挂，用量是宿主按每条会话的日志分别折出来的，
  不会串。

## 为什么要有宿主半侧

那个接口不带 CORS 头，而且 API Key 绝不能进浏览器代码。所以：

- **宿主半侧（`host.js`）** 持有凭证、发请求、缓存结果，并在
  `/plugins/dsh-web-api-balance/balance` 上暴露一份 JSON 摘要
  （`?refresh=1` 强制实时查询）。
- **浏览器半侧（`client.js`）** 只 fetch 上面这个同源路由，渲染胶囊与浮层。

该路由要求 `dsh web` 的会话令牌，和页面自身的其它请求走同一套鉴权。

## 不用填 Key

**通常什么都不用填。** 宿主半侧按下面的顺序取凭证，两条路都不需要你手输：

1. **账号授权**（`deepseekAccount.getBalance`）—— 「设置 → 账号」登录 DeepSeek 后
   写入的 OAuth 授权。这条路上**根本不存在 API Key**，登录了就能读余额。
2. **已保存的 API Key** —— `config.apiKey` 优先；留空则读凭证服务里
   `config.apiKeyEnv` 指定的那个引用，默认 `DEEPSEEK_API_KEY`。这正是
   「设置 → 模型」填 DeepSeek key 时写入 `~/.dsh/.credentials.yaml` 的同一个条目，
   所以**早就配过 key 的话，插件直接读得到，不用再填一遍**；启动 dsh 的进程环境里
   有同名变量也行。

两条都没有时（既没登录、也没存过 key），胶囊显示「余额不可用」，浮层给出具体
原因，不会静默失败。

浮层底部会标注这次数字来自哪条路（`DeepSeek 账号` 或 `API Key`），方便你判断。

## 配置

配置写在 web profile 的 `cordis.patch.yml` 里，`id: dsh-web-api-balance` 那一行。
**不配也能用**；只有想覆盖默认值时才有必要动它：

```yaml
- id: dsh-web-api-balance
  disabled: false
  inject: [webServer]
  config:
    apiKey: ''                      # 单独指定 key 时填 sk-...（优先级最高）
    apiKeyEnv: DEEPSEEK_API_KEY      # 否则用这个凭证引用 / 环境变量名
    baseURL: https://api.deepseek.com
    refreshSeconds: 300              # 缓存窗口，30–86400 秒
```

宿主的解析顺序是：账号授权 → `config.apiKey` → 凭证服务里的 `apiKeyEnv` →
同名环境变量。先命中先用。

## 行为

- 宿主侧按 `refreshSeconds` 缓存；并发的读请求共用一次上游调用。
- 账号授权那条路走的是 DSH 自己的服务，不发外部 HTTP 请求；未登录（返回 `null`）
  时自动落到 API Key 那条路。
- 浏览器侧每 5 分钟自动刷新一次，点胶囊可立即刷新。
- 最近一次成功的摘要存在 `localStorage`，页面刷新后先显示旧值再更新。
- 上游返回 401/403 时归类为「key 无效」，不会反复重试。
- 浮层只在悬停 / 聚焦时渲染，平时不占位；`pointer-events: none`，不会挡住点击。
- 「本次对话消耗」那一栏只在宿主报告过用量之后出现；新会话或没发过消息时整栏连同竖线
  一起不渲染。
- 金额保留两位小数；不足一分钱的桶保留三位，免得显示成 `¥0.00`。
- 样式只用宿主主题令牌（`--dsw-alias-*`），浅色 / 深色主题都跟随。

## 摘要字段

路由返回的 JSON 形状（浏览器半侧就按它渲染）：

```jsonc
{
  "ok": true,
  "source": "account" | "api-key",  // 这次数字来自哪条凭证路
  "topUpUrl": "https://platform.deepseek.com/top_up",
  "available": true,                 // 上游 is_available；false 表示余额已耗尽
  "total": 15, "toppedUp": 13.5, "granted": 1.5,
  "currency": "CNY",
  "checkedAt": 1791587145212
}
// 失败时：{ "ok": false, "reason": "...", "message": "...", "checkedAt": ... }
```

## 开发用脚本（不随包发布）

- `smoke-test.mjs` —— 用桩模块加载器和带状态的 React 垫片加载 `client.js`，断言
  槽位注册、字典解析，并驱动胶囊走过「失败 → 悬停展开 → 点击刷新成功 → 明细齐全」；
  另外断言右半在无余额时不渲染、在有余额时点击会用正确的 URL 新开标签页，宿主
  没给地址时的兜底，以及「本次对话消耗」栏：没有用量报告时不渲染、三个桶的 token 数与金额
  逐项对上 `deepseek-v4-pro` 高峰价、合计正确、未知模型只报 token 不报金额、旧模型名
  走别名价。`node smoke-test.mjs`
- `host-test.mjs` —— 起一个假的 DeepSeek `/user/balance` 端点，把插件的路由挂到
  真实 HTTP 上跑通：缓存命中、强制刷新、401、环境变量回退、无凭证、账号授权优先、
  未登录回退到已存 key、以及充值地址。`node host-test.mjs`

两个脚本都只依赖 Node 标准库，不需要 profile 的 node_modules。

## 隐私与凭证

这个包**不含任何凭证**，也不在任何地方回传数据：

- 代码里没有任何 API Key 字面量；key 只在运行时从插件配置、凭证服务
  （`~/.dsh/.credentials.yaml`，由 DSH 自己维护）或启动进程的环境变量里读。
- key 的唯一去处是 `Authorization: Bearer` 头，目标就是余额接口本身
  （默认 `api.deepseek.com`）；没有遥测、没有日志打印、没有第三方请求。
- key 不下发到浏览器：浏览器半侧只读本地同源路由返回的几个数字。
- 浏览器侧唯一写入的本地数据是 `localStorage` 里的余额摘要（金额 + 时间戳），
  不含凭证。

`npm pack` 的产物是 13 个文件（`LICENSE`、`README.md`、`client.js`、`cordis.patch.yml`、
`host.js`、`icon.svg`、`index.js`、`locale/{en,zh}.json`、`package.json`、`release.json`、
`assets/preview{,.en}.svg`）—— 两个测试脚本、构建脚本、任何 profile 状态、任何凭证都不在其中。
GitHub Release 上那个 tarball 和发到 npm 的**是同一条 `npm pack` 命令打出来的**，所以两条安装
路径装到的是同一份字节，而不是"应该一致"。

## 开发与发布（仓库内，不随 npm 包发布）

- `smoke-test.mjs` 与 `host-test.mjs` 见上一节，都在仓库里，可以直接 `node` 跑。
- `publish/build-repo.mjs` —— 把插件目录里的文件复制成一份可以推到 GitHub 的仓库内容
  （`publish/repo/`），同时把 `package.json` 补上 `license` / `repository` / `keywords`
  等公开元数据、把仓库地址里的账号占位符换成真实账号、并生成 `release.json`。
  这一步是幂等的，随时删掉重建；构建结束会扫描产物，只要还有未替换的占位符就直接失败。
- `publish/push-github.mjs` —— 走 GitHub REST API 建仓库、写入一个提交、打上 topic。
  **这台机器没有 git，所以刻意不用 git**：blob → tree → commit → ref 四步走完，
  再用 API 读回仓库做校验。先 `--dry-run` 看计划，`--topics-only` 只补标签。

```powershell
node publish/build-repo.mjs --owner <你的 GitHub 账号>
$env:DSH_GH_TOKEN = '<token>'      # 只在当前会话里，不落盘
node publish/push-github.mjs --dry-run
node publish/push-github.mjs
```

## 安装

**用已发布的包，钉精确版本。** 不需要 git、不需要从源码构建：

```sh
dsh plugin --profile web add dsh-web-api-balance@1.0.2
```

想升级就换版本号重跑同一条命令 —— 更新 DSH 本身或更新本仓库都**不会**自动更新已装的插件，
必须显式再装一次。

**为什么推荐 npm 而不是 GitHub 地址**：npm 注册表在国内有官方镜像（`registry.npmmirror.com`），
而 `github.com` 的 Release 下载经常直连不通、必须挂代理。若你的网络访问不了注册表，见下面备选。

**备选：本仓库 Release 上挂着同一份 tarball** —— 内容与发到 npm 的完全一致（来自同一次
`npm pack --ignore-scripts`），但走 GitHub 域名，可能需要代理：

```sh
dsh plugin --profile web add https://github.com/Charaaah/dsh-web-api-balance/releases/download/v1.0.2/dsh-web-api-balance-1.0.2.tgz
```

无论走哪条路，产物都是 13 个文件、解包约 84 KB、打包约 30 KB，**无依赖、无构建脚本、
无 `install`/`postinstall` 脚本**，因此不会触发 pnpm ≥10 的构建授权。

校验和**不写在这里**：README 本身就在这个包里，把哈希写进来就会改变这个包，永远追不上自己。
哈希在承载它的地方 —— pnpm/npm 会校验注册表给出的 `integrity`，Release 页给出 GitHub 自己的
asset digest。

**从源码装**（`dsh plugin` 认裸仓库 URL 和 `github:owner/repo` 简写，两者都会先做一次
GitHub 连通性预检）：

```sh
dsh plugin --profile web add https://github.com/Charaaah/dsh-web-api-balance
```

**钉住某个提交**：`#` 后面的部分 pnpm 会当作 git ref 解析，所以可以精确到 commit：

```sh
dsh plugin --profile web add github:Charaaah/dsh-web-api-balance#<commit-sha>
```

⚠️ **从本地检出切到发布版时**：`link:` / `file:` 装的是**同一个版本号**的话，单跑 `add`
**不会替换它** —— pnpm 看到声明的版本已经满足就直接放过，你以为换了其实没换。要么钉一个
不同的版本号/commit 让 spec 本身不同，要么先移除再装：

```sh
dsh plugin --profile web remove dsh-web-api-balance
dsh plugin --profile web add dsh-web-api-balance@1.0.2
```

## 发布

`package.json` 里没有 `"private": true`，所以也能直接发 npm：

```sh
npm publish            # 先在 package.json 里把 version 改成要发的版本
dsh plugin --profile web add dsh-web-api-balance
```

## English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web plugin that puts
a persistent balance chip next to the composer and, on hover, expands it into a two-column panel:
your DeepSeek API account balance on the left and **what this conversation has cost, in CNY**, on
the right. (The Chinese text above is the authoritative documentation; this is a summary.)

**What it shows**

- **Left column** — total / topped-up / granted balance, the refresh time, and which credential
  path the numbers came from (DeepSeek account or API key).
- **Right column** — the current session's cost, split into the three buckets the official bill
  charges for: cache hits, cache misses (`uncachedInputTokens` plus any `cacheWriteTokens`), and
  output. The last row is the total. The badge in the corner reads **梁文峰** during DeepSeek's
  peak window (Beijing time, weekdays 09:00–12:00 and 14:00–18:00) and **梁文谷** off-peak, and
  prices are halved off-peak. Chinese public holidays are *not* modelled.
- **The chip is clickable in two halves** — the amount half refreshes immediately, the 22 px
  top-up slice (invisible until hover) opens the DeepSeek top-up page in a new tab.

**Install**

Use the published package, pinned to an exact version. No git, no building from source:

```sh
dsh plugin --profile web add dsh-web-api-balance@1.0.2
```

To upgrade, run it again with the new version. Updating DSH itself, or this repository, does **not**
update an installed plugin — it has to be installed again explicitly.

**Why npm over a GitHub URL:** the npm registry has official mirrors (CN: `registry.npmmirror.com`),
whereas GitHub release downloads are frequently unreachable without a proxy. If the registry is
unreachable for you, the fallback below carries the identical artifact.

**Fallback: the release carries the same tarball** — byte-for-byte the same file that was published
to npm, from the same `npm pack --ignore-scripts` run, but served from a GitHub domain:

```sh
dsh plugin --profile web add https://github.com/Charaaah/dsh-web-api-balance/releases/download/v1.0.2/dsh-web-api-balance-1.0.2.tgz
```

Either route delivers 13 files, ~84 KB unpacked, ~30 KB packed, no dependencies, no build script and
no `install`/`postinstall` script, so pnpm ≥10 asks for no build approval.

The checksum is deliberately **not** stated here: this README is inside the package, so writing a
hash into it would change the package and never converge. The hash lives where it belongs — the
registry publishes an `integrity` value that the package manager verifies, and the release page
carries GitHub's own asset digest.

From source, or pinned to an exact revision (pnpm reads everything after `#` as the ref):

```sh
dsh plugin --profile web add https://github.com/Charaaah/dsh-web-api-balance
dsh plugin --profile web add github:Charaaah/dsh-web-api-balance#<commit-sha>
```

⚠️ **Switching from a local checkout.** A `link:`/`file:` install of the same version is *not*
replaced by `add` alone — pnpm sees the declared version already satisfied and leaves it in place.
Either name a different version, or remove first:

```sh
dsh plugin --profile web remove dsh-web-api-balance
dsh plugin --profile web add dsh-web-api-balance@1.0.2
```

**No API key required for the browser, and usually none to configure.** A host-side half holds the
credential and calls `api.deepseek.com` (the endpoint sends no CORS headers, and the key must
never reach browser code); the browser half only reads a same-origin JSON summary that `dsh web`
authenticates like any other page request. Credentials are resolved as: DeepSeek account OAuth
(if you are signed in under Settings → Account) → the plugin's `config.apiKey` → the credential
reference `config.apiKeyEnv` (default `DEEPSEEK_API_KEY`, the same entry the DeepSeek key in
Settings → Models writes) → the process environment. **If you already configured a DeepSeek key,
it just works.**

**Honest limitations**

- Prices are a hardcoded official table (`PRICING` in `client.js`); a model that is not in the
  table shows exact token counts and no amount rather than a guess.
- Usage is one total per session with no per-model breakdown, so a session that switched models
  is priced entirely at the current model's rate.
- Subagents run as separate sessions and are not included; this is not your account-wide bill.
- Peak/off-peak is decided by the clock at render time, because cumulative usage carries no
  per-request timestamp. The badge means "the tariff a request sent now would pay".

**Tests** — `node smoke-test.mjs` (browser half, against a stubbed module loader and React shim)
and `node host-test.mjs` (host half, against a fake `/user/balance` endpoint over real HTTP).
Both use only the Node standard library. There is no build step and no runtime dependency.

**Privacy** — no credential is in the package or in any log; the only outbound request is to the
balance endpoint itself, the key travels only in its `Authorization: Bearer` header, and the only
local write is the balance summary in `localStorage`.

MIT licensed.

