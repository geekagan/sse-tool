## 1. 人工问:

* 我已经创建了一个github仓库，最终要将其发布为 npm 包，供社区使用；
* npm 包介绍：
  + 名字: sse-tools
  + 作用：
    - 统一处理前端接SSE响应流时，要处理的一系列问题，包括：流解析，合理处理重连，自动处理断开连接，断点续传 等一系列问题；
  + 目的：
    - 作为一个生产级并且能够供社区使用的前端处理SSE响应的公共包
  + 实现：
    - 支持 EventSource  和 fetch+ReadableStream 两种模式

-----------------------------------------------------------------------------------------------------------------------------

## 设计 · 第一节：目录结构与 Subpath Exports

---
结构很清晰，思路是对的。几个具体的点值得确认或调整：

---

** `types.ts` 的导出路径缺失**

公共类型对外暴露，但 `exports` 里没有 `"."` 或 `"./types"` 入口。用户无法直接 `import type { SSEOptions } from 'sse-tools'` 。建议加上：

```json
"exports": {
  "./types": {
    "import": "./dist/types.mjs",
    "types": "./dist/types.d.ts"
  }
}
```

或者把类型随 `fetch` / `eventsource` 各自导出，不单独暴露 `types` 入口——取决于你的类型是否会被两个模块共同引用。

---

** `_internal/types.ts` 和 `src/types.ts` 的边界要想清楚**

现在有两个 types 文件，容易混淆。建议明确规则：

* `_internal/types.ts` — 实现细节类型，如 `ParsedSSEChunk`、`ReconnectState`，用户永远不需要知道
* `src/types.ts` — 用户侧类型，如 `SSEOptions`、`SSEConnection`、事件回调签名

这个边界如果不清晰，后面会出现内部类型泄漏到公共 API 的情况。

---

** `package.json` 缺少 `main` / `module` 兜底**

部分老工具链（Jest 默认配置、某些 bundler）不识别 `exports` 字段，会直接找 `main` 。加上兜底更安全：

```json
"main": "./dist/fetch/index.cjs",
"module": "./dist/fetch/index.mjs",
```

以 fetch 模式作为默认入口是合理的，因为它是主要功能。

---

**其余部分没有问题**

`_internal/` 不进 `exports` 的做法是正确的，tsup 生成双格式产物（mjs + cjs）也是当前最佳实践。整体结构可以直接进入下一节实现。

-----------------------------------------------------------------------------------------------------------------------------------------

## 设计 · 第二节：公共 API 签名

---
整体设计很扎实，两个模式的对称性做得好。有几个地方值得推敲：

---

** `onError` 签名建议调整**

现在是 `onError: (err, attempt) => void` ，但用户在错误处理时通常还需要知道**是否还会重连**、**下次重连的延迟是多少**，才能决定要不要上报或展示 UI。建议改成对象参数：

```ts
onError: (err, context: {
  attempt: number
  willRetry: boolean
  nextDelay?: number   // willRetry 为 false 时无意义
}) => void
```

这样用户不需要自己推算重连状态，信息足够做决策。

---

** `onClose` 缺少关闭原因**

`onClose` 现在没有任何参数，但"主动调用 `close()` "和"超过最大重连次数后放弃"是两种完全不同的关闭，用户通常需要区分处理：

```ts
onClose: (reason: 'manual' | 'exhausted' | 'error') => void
```

---

** `getState()` 建议改成属性**

`connection.getState()` 是方法调用，但状态是同步的瞬时值，没有副作用，没有理由是函数。 `connection.state` 作为 getter 更自然，也和 `es.readyState` 的设计语言一致，降低两个模式之间的认知差异。

---

** `eventsource` 模式缺少 `method` 和 `body` **

fetch 模式支持 POST + body，但 eventsource 模式只有 `url` 和 `headers` 。AI 流式输出（POST + JSON body）是现在最主流的 SSE 使用场景，eventsource 模式如果不支持 POST 会让用户困惑——毕竟你的卖点之一就是"内部 fetch 实现，可以做原生 EventSource 做不到的事"。

建议加上，哪怕文档里注明"偏离原生 EventSource 语义"。

---

**两个小的命名问题**

`initialLastEventId` 有点绕口，见过更多库用 `lastEventId` 作为初始值参数名，语义同样清晰但更短。

`backoffFactor` 在主流库里更常见的叫法是 `multiplier` ，不是强制，但如果你在意和社区习惯对齐可以考虑。

---

**其余没有问题**

事件对象结构 `{ data, event, id?, retry? }` 是对的，直接映射 SSE 协议字段。两个模式共享 `retry` / `initialLastEventId` / `onIdUpdate` 参数签名的决策很好，用户切换模式时几乎零成本。可以进入实现阶段了。

-----------------------------------------------------------------------------------------------------------------------------------------

## 设计 · 第三节：重连与 SSE 解析

---
逻辑整体正确，有几个细节值得补充或确认：

---

**HTTP 非 2xx 的处理需要再细分**

现在统一"不重连，直接 `onClose('error')` "，但 `429 Too Many Requests` 和 `503 Service Unavailable` 是服务端明确告知"稍后再试"的信号，无脑放弃反而违反用户预期。建议：

* `401` / `403` / `404` / `422` — 不重连，参数或权限问题，重试无意义
* `429` / `503` — 重连，尊重 `Retry-After` header（如果有），否则走正常 backoff
* 其余 5xx — 重连，服务端临时故障

---

**jitter 范围建议收窄**

`random(0.75, 1.25)` 意味着最多可以缩短 25% 的延迟，在高并发场景下仍然可能造成请求扎堆（thundering herd）。业界更常见的做法是 `random(0, 1) × delay` （full jitter）或 `delay/2 + random(0, delay/2)` （equal jitter），后者在避免扎堆和保证最低延迟之间取得更好平衡。

你目前的 `±25%` 也不是错的，但如果在意这个细节可以考虑。

---

**解析器的输入类型需要明确**

"输入字节流 chunk"在浏览器里实际拿到的是 `Uint8Array` ，需要先 `TextDecoder` 解码成字符串，再做字段解析。建议在类型签名上明确这一步在哪里发生：

```ts
// 方案一：解析器只处理字符串，解码在 fetch 适配器里做
function parseSSEChunk(chunk: string): SSEEvent[]

// 方案二：解析器自己处理 Uint8Array
function parseSSEChunk(chunk: Uint8Array, decoder: TextDecoder): SSEEvent[]
```

方案一更纯粹，测试更简单，推荐。

---

**跨 chunk 的边界情况要处理**

网络传输不保证每个 chunk 都是完整的 SSE 事件， `data: hel` 和 `lo\n\n` 可能分两次到达。解析器需要维护一个跨 chunk 的 buffer，每次调用把上次未处理的尾部带进来：

```ts
// 解析器需要是有状态的，或者返回剩余未处理的字符串
function parseSSEChunk(buffer: string, newChunk: string): {
  events: SSEEvent[]
  remaining: string  // 下次调用时拼在新 chunk 前面
}
```

如果设计成纯无状态函数，这个 buffer 管理就得放到调用方（fetch 适配器）里，也可以，但要明确谁负责。

---

** `id` 为空字符串的处理确认一下**

你写的"id 为空字符串时清空当前 lastEventId"是正确的 WHATWG 规范行为。但要注意区分两种情况：

* `id: \n`（字段存在，值为空）→ 清空 lastEventId ✓
* 事件里没有 `id` 字段 → lastEventId **保持不变** ✓

这个区分在实现里容易混淆，值得在代码注释里显式标注。

---

**其余没有问题**

`retry:` 字段覆盖 `initialDelay` 的行为、注释行静默忽略、多行 data 拼接，都是正确的规范实现。空行触发 dispatch 的时机也对。

**我的声明：**
上面是我的一些想法和建议，你可以根据实际情况进行调整。我只是一些个人的思考，不能代表社区的共识。
如果你有异议的话，你可以提出异议（带上理由和建议），我们继续讨论。
直到我们最终敲定，你再进行下一步。

--------------------------------------------------------------------------------------------------------------------

## 设计 · 第四节：测试策略

---
测试策略分层清晰，工具链选择也是当前社区主流。几个补充：

---

**单元测试要加一个 fuzzing 层**

SSE 解析器是整个库最核心的部分，正常 case 之外建议加几个"奇怪但合法"的输入：

* 字段名后没有空格：`data:hello`（规范允许）
* 只有字段名没有冒号：`data`（规范定义为 `data: ""`）
* 超长 data 行
* 连续多个空行

这些边界不测，上线后会被用户踩到。

---

**集成测试的 mock 粒度要够细**

`mock fetch 模拟断线` 说起来简单，但 fetch SSE 的 mock 有几个层次需要分开测：

* fetch 直接 reject（网络断开）
* fetch resolve 但 HTTP 状态非 2xx（429 / 503 / 401）
* fetch resolve、状态 200、但 ReadableStream 中途关闭（服务端主动断流）
* ReadableStream 正常结束（服务端发完数据自然关闭）

第三和第四种行为不同（前者触发重连，后者不应该重连），是最容易写漏的 case。

---

** `changesets` 优于 `np` **

`np` 只是发布流程的自动化，changelog 还是手写。 `changesets` 更适合你的场景：

* 每次 PR 附带 changeset 文件，changelog 自动生成
* 支持多包（如果以后拆 monorepo 无缝切换）
* GitHub Actions 里有官方 action，CI 自动开 release PR

如果你打算认真维护这个库， `changesets` 从一开始就用值得。

---

**E2E 测试建议加一个本地脚本入口**

"开发时手动跑"容易变成"从来不跑"。建议在 `package.json` 里加：

```json
"scripts": {
  "test:e2e": "node scripts/e2e-server.js & sleep 1 && vitest run e2e"
}
```

不进 CI，但有明确的命令，新贡献者也知道怎么跑。

---

**工具链没有问题**

tsup + vitest + eslint-typescript 是目前最省心的组合，不需要调整。

**我的声明：**
上面是我的一些想法和建议，你可以根据实际情况进行调整。我只是一些个人的思考，不能代表社区的共识。
如果你有异议的话，你可以提出异议（带上理由和建议），我们继续讨论。
直到我们最终敲定，你再进行下一步。

---------------------------------------------------------------------------------------------------------------------------

## 审阅 spec 文件

> 文件： docs/superpowers/specs/2026-05-20-sse-tools-design.md

---
整体来看，这份 spec 质量很高，四节讨论的决策都准确落地了。几个值得在编码前确认的点：

---

**一个逻辑 bug**

第 6.2 节集成测试的注释写错了：

> `ReadableStream` ends normally → `onClose('manual')`

应该是 `onClose('complete')` 。 `'manual'` 是用户主动调用 `close()` 的场景。这是注释笔误，但如果测试按这个写，断言会过不了。

---

** `onClose('complete')` 的重连逻辑要明确**

Spec 第 4.2 节写了"ReadableStream ends normally → No retry → `onClose('complete')` "，但有一个边界没有覆盖：**服务端正常结束后，用户是否能手动调用 `close()` 而不触发警告？**

建议在内部用一个状态位区分"已自然结束"和"用户关闭"，避免 `close()` 在连接已经结束后还试图做清理操作。

---

** `removeEventListener` 的类型签名需要对齐**

`eventsource` 模式的 `addEventListener` 接收 `(event: SSEEvent) => void` ，但原生 `EventSource` 的 listener 签名是 `(event: MessageEvent) => void` 。如果用户之前用过原生 `EventSource` ，迁移时类型会报错。

要么在文档里显式说明这是有意偏离，要么考虑兼容 `MessageEvent` 的子集。

---

** `"."` 入口只导出类型，没有 runtime**

```json
".": { "types": "./dist/types.d.ts" }
```

这个设计是对的，但要确认 `tsup` 会单独构建 `src/types.ts` 为 `dist/types.d.ts` 。默认情况下 tsup 的入口是代码文件，纯类型文件需要在 `tsup.config.ts` 里显式列为 entry，否则这个文件不会生成。

---

** `scripts/e2e-server.js` 建议加 graceful shutdown**

```json
"test:e2e": "node scripts/e2e-server.js & sleep 1 && vitest run e2e"
```

后台启动的 server 在测试结束后不会自动退出，多次运行会产生端口冲突。建议改成：

```json
"test:e2e": "node scripts/e2e-server.js & sleep 1 && vitest run e2e; kill %1"
```

或者在 `e2e-server.js` 里监听 `SIGTERM` ，vitest global teardown 里发信号关掉它。

---

**其余没有问题**

equal jitter 公式、HTTP 状态码分层、parser 接口设计、 `id` 字段的 sentinel 区分方案，都是正确且完整的。

---
**我的声明：**
上面是我的一些想法和建议，你可以根据实际情况进行调整。我只是一些个人的思考，不能代表社区的共识。
如果你有异议的话，你可以提出异议（带上理由和建议），我们继续讨论。
直到我们最终敲定，你再进行下一步。

---------------------------------------------------------------------------------------------------------------------------

## 调用 writting plans

```shell
/writing-plans
```

---------------------------------------------------------------------------------------------------------------------------
## 选择执行方式

---
  两种执行方式：

  1. Subagent-Driven（推荐） — 每个 task 分发一个 fresh subagent，task 之间有 review checkpoint，快速迭代

  2. Inline Execution — 在当前 session 里用 executing-plans 执行，分批推进并设置 checkpoint
---

选 **Inline Execution**。

原因很简单：我们这个 session 里已经积累了四节设计讨论，所有决策的上下文都在这里——parser 的 sentinel 方案、equal jitter 公式、HTTP 状态码分层、`onClose` 的四种 reason。Subagent 拿不到这些上下文，要么重新喂 spec，要么靠 spec 文档覆盖所有细节（而我们刚才还发现了 spec 里有一个 bug）。

Inline 执行可以在每个 task 完成后直接 review，发现问题当场修，不需要跨 agent 传递状态。10 个 task 里最重的是 3-7，其余都很轻，在一个 session 里完全可以推进完。

---------------------------------------------------------------------------------------------------------------------------