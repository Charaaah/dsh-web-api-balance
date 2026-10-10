# dsh-web-api-balance

[![License: MIT](https://img.shields.io/badge/license-MIT-2f855a?style=flat-square)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0969da?style=flat-square)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f46e5?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
![no build step](https://img.shields.io/badge/build-none%20%C2%B7%20source%20only-6b7280?style=flat-square)
![no dependencies](https://img.shields.io/badge/dependencies-0-6b7280?style=flat-square)

<!-- README-I18N:START -->

**中文** | [English](./README.en.md)

<!-- README-I18N:END -->

在 DeepSeek Harness 的 Web 界面里显示 DeepSeek API 账户余额，顺带把当前这条对话花了多少钱算给你看。

![示意图：输入框旁的余额胶囊，悬停展开余额与消耗两栏](assets/preview.svg)

## 安装

```sh
dsh plugin --profile web add dsh-web-api-balance@1.0.4
```

钉版本号是有意的。想升级就换号重跑一条，DSH 自己更新或这个仓库更新都不会顺手把你的插件也换掉。

npm 走不通的话，Release 上挂着同一份 tarball，字节完全一样，只是域名换成 GitHub：

```sh
dsh plugin --profile web add https://github.com/Charaaah/dsh-web-api-balance/releases/download/v1.0.4/dsh-web-api-balance-1.0.4.tgz
```

从源码装也行，`dsh plugin` 认裸仓库 URL 和 `github:owner/repo` 简写（两种都会先做一次 GitHub
连通性预检）；`#` 后面会被 pnpm 当成 git ref，所以能钉到 commit：

```sh
dsh plugin --profile web add https://github.com/Charaaah/dsh-web-api-balance
dsh plugin --profile web add github:Charaaah/dsh-web-api-balance#<commit-sha>
```

装完刷新页面就能看到。要是你之前用 `link:` 或 `file:` 装过**同一个版本号**，直接 `add` 不会替换它
（pnpm 看到版本已满足就跳过了），先 remove 再装。

## 卸载

```sh
dsh plugin --profile web remove dsh-web-api-balance
```

这条命令是转发给 profile 目录里的 pnpm 的，卸掉包和 `package.json` 里那行依赖。但
`dsh.profile.bundles` 不会跟着清，那是 DSH 的字段，pnpm 不认识。得手工编辑
`~/.dsh/profiles/web/package.json`，把包名从数组里删掉：

```jsonc
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dshmarket"
  // 删掉这行："dsh-web-api-balance"
] } }
```

留着它会指向一个已经不存在的包，是个启动隐患。市场页面的插件开关会帮你把这两步一起做掉，命令行
不会。

下面这些卸载都不会碰，想要清掉得自己来：

- `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`。这是 DSH 凭证服务的东西，「设置 → 模型」写进去的
  也是同一个条目，你在别处可能还在用，所以插件不创建也不删除它。
- profile 的 `cordis.patch.yml` 里手工写的 `- id: dsh-web-api-balance` 那段。包没了之后这行是无害的
  （找不到包就忽略），但里面可能写着 `apiKey`，介意就删。
- `localStorage` 里的缓存，键名 `dsh-web-api-balance:last`，存的是金额和时间戳，没有凭证。

已发布的版本收不回来（npm 版本号不可变），所以卸载只影响本机，`1.0.4` 一直在那儿，随时能装回来。

## 界面

就一个东西：输入框工具栏、发送键左边那个常驻胶囊，显示总余额。鼠标移上去（键盘聚焦也行）弹出
浮层，左右两栏中间一条竖线：

```
总余额      ¥15.00  │   本次对话消耗     梁文谷
充值余额    ¥13.50  │   缓存命中    1,000,000   ¥0.30
赠送余额     ¥1.50  │   缓存未命中  2,000,000   ¥18.00
更新时间    20:00:00│   输出          500,000   ¥13.50
来源        DeepSeek 账号│   ────────────────────────────
                    │   合计                    ¥31.80
```

左栏是账户余额，右栏是当前会话的消耗。没有用量报告的时候右栏和竖线一起消失，退回单栏。两栏顶部
对齐，所以账户栏不再重复胶囊上已经有的名称，也没单独再打一遍总额，总额就是「总余额」那一行。

胶囊本身分成两半，没有额外的按钮，也没有文字：

- 左半是圆点加金额，点一下立即刷新余额。
- 右半是一条 22px 的竖条加钱包加号图标，平时宽度为 0、完全看不见，鼠标进胶囊才滑出来，点击在新
  标签页打开充值页。

所以静止状态下它就是个干净的数字。取不到余额时（也就没金额可充）整个右半不渲染，胶囊变红，浮层里
写明原因。

充值地址优先用账号服务给的 `AccountView.links.topUpUrl`，这样指向内部 Platform 的部署会跳自己的
站点；拿不到就用公开的 `https://platform.deepseek.com/top_up`。浏览器半侧内置了同一个兜底地址，
所以宿主没报告地址时右半也能用。

余额来自 DeepSeek 官方的 `GET https://api.deepseek.com/user/balance`，登录了账号时则走 DSH 自己的
账号服务。

## 消耗是怎么算的

官方的 token 计数看不出花了多少钱，所以右栏把这条会话累计的用量按人民币拆开，三个计费桶各一行，
最后一行合计：

| 行 | 取数 |
|---|---|
| 缓存命中 | `tokenUsage.cacheReadTokens` |
| 缓存未命中 | `tokenUsage.uncachedInputTokens` + `cacheWriteTokens` |
| 输出 | `tokenUsage.outputTokens` |
| 合计 | 上面三项之和 |

官方 schema 里 `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`，所以这三行正好
覆盖全部计费 token。缓存本身不额外收费，落盘、存储、过期都不进账单，只有 token 按这三档计价。

取数用的是 DSH 的会话投影，宿主按整条会话日志折出来的官方回报用量，不是估的。模型单价则按
`useProjection('modelSelection')` 里的当前路由查表。两个投影都由宿主推送，有回报就更新，不需要额外
请求，也不往外发数据。

价格上有两件事得说清楚。

一是单价写死在 `client.js` 的 `PRICING` 里，单位是元每百万 tokens，官方调价了改这一个对象即可。
表里没有的模型不猜，照样显示精确的 token 数，金额位置写「未收录该模型价格」。旧模型名
`deepseek-v4-flash` 和 `deepseek-v4-flash-vision-exp` 按官方说明归到 `deepseek-flash` 计价。

二是峰谷。右栏标题右边那个名字就是当前档位，北京时间工作日 9:00–12:00 和 14:00–18:00 显示「梁文峰」，
其余时间「梁文谷」，后者半价。判断在每次渲染时按当前时钟做一次，先把瞬时时间换算成 UTC+8 再读，
所以浏览器在哪个时区都不影响。官方对中国法定节假日的豁免没有建模，插件不带节假日日历，节假日的
工作日会显示梁文峰、把价格算高。另外累计用量里没有每次请求的时间戳，跨了峰谷的会话没法诚实地归到
某一档，这个名字的意思是「此刻发出的请求按哪一档计价」。

还有三点口径：

flash 和 pro 不是一个价。单价从 modelSelection 投影读当前路由，表里两套价分开（命中 ¥0.04 / ¥0.30，
未命中 ¥2 / ¥9，输出 ¥8 / ¥27，都是高峰价）。路由带不带 `deepseek-official/` 前缀都能对上。`next` 优先
于 `lastUsed`，所以你刚在模型选择器里改过、下一次请求才用的那个模型，显示的就是它。

数字是当前这条会话的累计，不含子代理（子代理各自是独立会话，有自己的用量），也不是账号的历史
账单。要看账号侧消耗请去官方平台的用量页。

累计用量是一条会话一个总数，里面没记「哪一段用了哪个模型」。所以一条会话中途从 flash 换到 pro 的话，
显示的是把整条会话按当前模型单价算出来的结果，混用过就是估值，没换过就是准的。会话切换时组件会重挂，
用量是宿主按每条会话的日志分别折的，不会串。

## 凭证

通常什么都不用填。宿主按下面的顺序取，两条路都不用你手输：

1. 账号授权，`deepseekAccount.getBalance`。在「设置 → 账号」登录 DeepSeek 后写入的 OAuth 授权，
   这条路上根本不存在 API Key。
2. 已保存的 API Key。`config.apiKey` 优先，留空则读凭证服务里 `config.apiKeyEnv` 指定的引用，默认
   `DEEPSEEK_API_KEY`。这正是「设置 → 模型」填 DeepSeek key 时写进 `~/.dsh/.credentials.yaml` 的同一个
   条目，所以早就配过 key 的话插件直接读得到，不用再填一遍。启动 dsh 的进程环境里有同名变量也行。

两条都没有时，胶囊显示「余额不可用」，浮层给出具体原因，不静默失败。浮层底部会标这次数字来自哪条路
（`DeepSeek 账号` 或 `API Key`），方便你判断。

为什么非要有宿主半侧：那个接口不带 CORS 头，而且 API Key 不能进浏览器代码。所以 `host.js` 持有凭证、
发请求、缓存结果，在 `/plugins/dsh-web-api-balance/balance` 上暴露一份 JSON 摘要（`?refresh=1` 强制实时
查询）；`client.js` 只 fetch 这个同源路由。该路由要求 `dsh web` 的会话令牌，和页面自身的其它请求走同
一套鉴权。

## 配置

配置写在 web profile 的 `cordis.patch.yml` 里 `id: dsh-web-api-balance` 那一行，不配也能用：

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

解析顺序是账号授权 → `config.apiKey` → 凭证服务里的 `apiKeyEnv` → 同名环境变量，先命中先用。

## 行为和边界

宿主按 `refreshSeconds` 缓存，并发的读请求共用一次上游调用。账号授权那条路走 DSH 自己的服务、不发
外部 HTTP 请求，未登录（返回 `null`）时自动落到 API Key 那条路。浏览器侧每 5 分钟自动刷一次，点胶囊
可立即刷新。最近一次成功的摘要存在 `localStorage`，页面刷新后先显示旧值再更新。上游返回 401/403 归
为「key 无效」，不反复重试。

浮层只在悬停或聚焦时渲染，平时不占位，且设了 `pointer-events: none`，不会挡住点击。「本次对话消耗」
那一栏只在宿主报告过用量之后出现，新会话或没发过消息时整栏连同竖线都不渲染。金额保留两位小数，不足
一分钱的桶保留三位，免得显示成 `¥0.00`。样式只用宿主主题令牌（`--dsw-alias-*`），浅色深色都跟随。

路由返回的 JSON 形状，浏览器半侧就按它渲染：

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

## 隐私

这个包不含任何凭证，也不往任何地方回传数据。代码里没有 API Key 字面量，key 只在运行时从插件配置、
凭证服务（`~/.dsh/.credentials.yaml`，DSH 自己维护）或启动进程的环境变量里读。它唯一的去处是
`Authorization: Bearer` 头，目标就是余额接口本身（默认 `api.deepseek.com`），没有遥测、没有日志打印、
没有第三方请求。key 也不下发到浏览器，浏览器半侧只读本地同源路由返回的几个数字，唯一写入本地的
是 `localStorage` 里的余额摘要（金额加时间戳）。

包的产物是 14 个文件（`LICENSE`、`README.md`、`README.en.md`、`client.js`、`cordis.patch.yml`、
`host.js`、`icon.svg`、`index.js`、`locale/{en,zh}.json`、`package.json`、`release.json`、
`assets/preview{,.en}.svg`），两个测试脚本、构建脚本、任何 profile 状态和任何凭证都不在里面。Release 上那个 tarball 和发到 npm 的是
同一条 `npm pack` 命令打出来的，所以两条安装路径装到的是同一份字节，不是「应该一致」。

## 开发

仓库里有两个脚本，只依赖 Node 标准库，不需要 profile 的 node_modules：

```sh
node smoke-test.mjs   # 浏览器半侧
node host-test.mjs    # 宿主半侧
```

`smoke-test.mjs` 用桩模块加载器和带状态的 React 垫片加载 `client.js`，断言槽位注册和字典解析，驱动
胶囊走过「失败 → 悬停展开 → 点击刷新成功 → 明细齐全」，还断言右半在无余额时不渲染、有余额时点击会
用正确的 URL 新开标签页、宿主没给地址时的兜底，以及消耗栏：没有用量报告时不渲染、三个桶的 token 数
与金额逐项对上 `deepseek-v4-pro` 高峰价、合计正确、未知模型只报 token 不报金额、旧模型名走别名价。

`host-test.mjs` 起一个假的 DeepSeek `/user/balance` 端点，把插件的路由挂到真实 HTTP 上跑通缓存命中、
强制刷新、401、环境变量回退、无凭证、账号授权优先、未登录回退到已存 key，以及充值地址。

发布脚本在 `publish/` 下，同样不随包发布。这台机器没有 git，所以推送是走 GitHub REST API 的
blob → tree → commit → ref 四步，最后读回仓库校验：

```powershell
node publish/build-repo.mjs --owner Charaaah   # 生成 publish/repo/，补公开元数据和 release.json
node publish/pack-npm.mjs                      # npm pack --ignore-scripts，产物即发 npm 的那份
$env:DSH_GH_TOKEN = '<token>'                  # 只在当前会话里，不落盘
node publish/push-github.mjs --dry-run         # 先看计划
node publish/push-github.mjs
node publish/release-github.mjs                # 打 tag、建 Release、挂 tarball
$env:NPM_TOKEN = '<token>'
node publish/publish-npm.mjs                   # 发的是已打包好的那一份
```
