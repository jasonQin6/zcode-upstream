# @zcode/dynamic-workflow-runtime

沙箱 harness（dynamic workflow 执行引擎）。把一份 workflow 脚本在受控子进程里跑起来，
用 NDJSON 把子进程的 `__host.*` 调用桥接到 `@zcode/dynamic-workflow` 的纯引擎核心。

## 依赖边界

**仅**依赖 `@zcode/dynamic-workflow`（workspace）与 node 内建。**绝不** import `@zcode/core` /
`@zcode/contracts` / `@zcode/bootstrap` / `@zcode/adapters`——本包是「整条 sandbox↔engine
管线 app-free 可跑」的证明。

## 用法

```ts
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";

const settlement = await runWorkflowScript({
  scriptText,                 // 或 lowered: <async 函数体>
  caps: { maxConcurrency: 16 },
  askSpecs,                   // site id ∈ 合成 schemas 记录即 typed
  validate,                   // @zcode/dynamic-workflow 的 validate（适配到 ValidateFn）
  makeDriver: (sink) => driver, // driver 自带 journal + emit；sink 是引擎的向上回报面
  signal,                     // 可选：AbortSignal
  timeoutMs,                  // 可选：墙钟超时
});
// settlement —— 真实词表只有三值：completed | errored | stopped（没有 failed / cancelled）
// 完整终态语义（触发条件 → status → stop reason → 可否 resume → 通知要点）
// 以 SETTLEMENT_SEMANTICS（src/settlement-semantics.ts，包内唯一真源，测试逐行锁定）为准
```

## 架构

```
┌─ parent (harness) ──────────────┐  NDJSON  ┌─ child (vm.createContext) ──────┐
│ runWorkflowScript               │  stdio   │ 只含 ES intrinsics + __host       │
│  - lower(scriptText)            │◀────────▶│  createActor 同步返回 local 句柄  │
│  - WorkflowEngine(driver,...)   │          │  ask/worldRead → 请求父进程       │
│  - 桥接 __host.* ↔ engine       │          │  args 冻结全局（spawn 时过界一次）  │
│  - spawn/kill/timeout/abort     │          │  Date.now/Math.random 运行期禁令  │
└─────────────────────────────────┘          └──────────────────────────────────┘
```

## NDJSON 线协议

见 `src/protocol.ts`（唯一真源）。child→parent：`create-actor`（即发即忘）/ `request`（ask、
world-read）/ `event`（log）/ `complete`；parent→child：`response`。

## 构建顺序

测试与 typecheck 通过 `@zcode/dynamic-workflow` 的**已构建 dist** 解析依赖，故 `pretest` /
`pretypecheck` 会先 `pnpm --filter @zcode/dynamic-workflow build`。全新检出直接 `pnpm test` 即可，
不会踩到 stale-dist。

## 结算语义

run 的终态语义以 **`SETTLEMENT_SEMANTICS`**（`src/settlement-semantics.ts`，包内唯一导出
常量）为唯一真源：每行登记 *触发条件 → 结算 status → stop reason → 可否 resume → 通知
要点*，被 `test/settlement-semantics.test.ts` 逐行注入锁定——改结算行为必须同时改表与
测试。速览（详见语义表）：

- 脚本正常 return → `completed`；
- 脚本抛错 / 引擎级失败（`failRun` 路径）→ `errored`，不可 resume，只能修订（amend-resume）；
- 其余全部 → `stopped`，可 resume：墙钟超时 / 子进程崩溃 / NDJSON 损坏 / spawn 失败 /
  宿主关闭（reason `interrupted`）、主代理停止（`model`）、用户停止（`user`）、provider
  确定性错误（`provider`）；唯一例外是 `superseded`（被修订取代，未完结工作归后继，不可 resume）。

abort 信号驱动的机制是 `engine.stop(initiator)`——引擎**没有** `cancel` 方法；宿主侧故障
（超时 / 崩溃 / 协议损坏）走的也是 `stop("interrupted")` 而不是 fail。harness 侧的
first-wins finalize 只管子进程清理（清 timer、关 stdin、kill child），不自造结算。
