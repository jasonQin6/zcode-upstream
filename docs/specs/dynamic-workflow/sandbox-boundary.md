# Spec：动态工作流沙箱边界收窄（逃逸修复 + 环境白名单）

> 元信息：来源 = repo-adoption 工作流实跑（run dwfrun-1efe6d6a）的分析师发现，2026-09-22 立项。
> 优先级 P0（安全）。状态：待人工创建 issue（贴 `ready-for-agent` 标签）。
> 位置说明：仓库无 spec 目录惯例，按 AGENTS.md"目录不存在时按需创建"落在 `docs/specs/dynamic-workflow/`。

## Problem Statement

用户在 ZCode 中运行一个第三方或模型代写的动态工作流脚本时，合理预期是：脚本被限制在沙箱里，拿不到宿主进程的凭据。实际上脚本两行代码即可逃逸到完整 Node 进程，读取父进程全部环境变量——包括 CLI 从 `.env` 装载的模型 API key。

现状取证（2026-09-22，均可复现）：

- 沙箱全局注入了**外层 realm 的可调用物**：`sandbox.__send = (line) => {...}`（child-source.ts:271）与 `__execute: (runFn) => Promise<void>` 同为宿主 realm 函数，任一皆是逃逸起点；
- 逃逸探针 `__send.constructor("return process")()` 实测成功：`typeof process === "undefined"` 的同时取到 `process.version`、`process.cwd()`，并能枚举匹配 `KEY|TOKEN|SECRET|CREDENTIAL` 的环境变量（含预埋的 FAKE_TEST_TOKEN）；
- 子进程 spawn 以 `env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }` **全量继承**宿主环境（harness.ts:251），CLI 装载的密钥全在其中；
- 文件头（child-source.ts:20-22）声称"跨界收敛、仅两种跨界值"，与实现直接矛盾。

后果：workflow 脚本可静默读取并外传凭据；该产品的定位包含商店安装与模型代写脚本，这是信任根基层面的缺陷。

## Solution

把跨界收窄为**纯数据**：

1. **函数值永不进入沙箱**。宿主递入沙箱的只有数据对象（如宿主创建的发件箱/收件箱数组，或 SharedArrayBuffer）；`__send`、`__execute` 等一切可调用物改为在沙箱 realm 内部构造，对宿主数据对象只做属性读写（如 `outbox[outbox.length] = line`），绝不取用宿主对象的任何方法——`outbox.push` 这类宿主函数同样是逃逸起点（其 `.constructor` 即外层 Function）。
2. 子进程环境从全量继承改为**白名单**：保留运行必需项（`ELECTRON_RUN_AS_NODE`、`PATH`、`HOME`、`TMPDIR`、`LANG` 等）；业务变量（如外部服务 key）不在白名单内，由外部工具自带的安全装载机制解决（如 env 文件回退，见 lib/jev.mjs 的既有模式）。
3. 逃逸探针固化为常驻回归测试夹具。

## User Stories

1. As a ZCode 用户，I want 第三方 workflow 脚本读不到我的 API key 和凭据, so that 安装商店内容不需要先审查其源码。
2. As a workflow 作者, I want 沙箱边界规则简单可预言（只有数据能跨界）, so that 我不需要记住哪些宿主对象"其实能被利用"。
3. As a 平台维护者, I want 逃逸面有常驻探针测试, so that 任何重构引入的新逃逸路径在 CI 就被发现。
4. As a 安全审计者, I want 子进程环境是显式白名单, so that 我能逐项回答"这个进程能看到什么"。
5. As a 桌面端用户, I want 打包态下 workflow run 仍然正常启动, so that 修安全不牺牲功能（ELECTRON_RUN_AS_NODE 必须保留）。
6. As a workflow 作者, I want 外部服务的凭据通过我声明的方式装载而不是宿主全量下发, so that 我的脚本能跨环境运行。
7. As a 平台维护者, I want 沙箱的设计声明（跨界收敛）与实现可被同一个测试约束, so that 文档不再腐烂。

## Implementation Decisions

- 沙箱构造处：删除对外层 realm 函数的全局注入；跨界通道改为"宿主传输句柄 + 沙箱内 dispatcher"，dispatcher 的方法体在沙箱 realm 内定义，与宿主的通信只携带 JSON-able 数据。
- 子进程 spawn 处：环境改为白名单拼装。白名单作为常量集中定义并注释每一项的必要性（特别是 ELECTRON_RUN_AS_NODE：桌面打包态缺它子进程会按完整 Electron 应用启动并静默卡死）。
- 逃逸探针夹具：覆盖已知逃逸面（`__send.constructor`、`Function.constructor`、globalThis 属性枚举、process 全局探测）；探针以 lowered 脚本形态经公共入口喂入。
- 不改动 NDJSON 线协议与结算语义（分别由本目录另两份 spec 处理，互不依赖）。

## 实施修正（2026-09-22，编码时实测发现，回写本 spec 作为权威记录）

以下三处与本 spec 初稿或其预设的代码现实有出入，按"不修就达不到本 spec 自身的验收场景"处理，实现与测试均以修正后为准：

1. **发件箱必须 context 内构造，不能用宿主创建的数组**（初稿 Solution §1 的"宿主创建的发件箱/收件箱数组，或 SharedArrayBuffer"写法作废）。实测（node vm，2026-09-22）：宿主 realm 的数组或 SharedArrayBuffer 一旦递入沙箱，脚本 `x.constructor` 即宿主 Array/SharedArrayBuffer、再 `.constructor` 即宿主 Function，`Function("return process")()` 拿到带 env 的宿主进程——与 `__send.constructor` 同一条链，只是多走一跳，初稿"避开 `outbox.push`"挡不住它。实现为：发件箱 `__outbox` 在 BOOTSTRAP 内以 `var` 声明（context 原生数组），沙箱侧属性写（`__outbox[__outbox.length] = line`），宿主侧只做属性读（length 与下标元素），配 `setImmediate` 冲刷泵保持 stdio FIFO。
2. **sandbox 对象必须 null 原型**。删掉 `__send` 后探针仍抓到一条残留链：`createContext` 的全局代理在自有属性未命中时沿 sandbox 对象的原型链解析，普通对象字面量的 `globalThis.constructor.constructor` 同样直达宿主 process（实测复现）。实现为 `Object.create(null)`；context 内建不受影响，bootstrap 写下的全局照常反射。spec 验收场景 2 的"枚举沙箱全局"探针因此同时覆盖 globalThis 一级成员与 constructor 两跳尝试。
3. **`childSpawn` 需新增 `execPath` 注入**。初稿 Testing Decisions 称"现有 spawn 参数已可注入 execPath/argsPrefix"，实际只有 `argsPrefix`。已在 `RunWorkflowOptions.childSpawn` 增加 `execPath?: string`（缺省 `process.execPath`），供桌面打包态模拟测试注入 Electron 二进制；两个旋钮相互独立。

另记录一条**实测不可利用、但属于 node:vm 底座的已知残留**：脚本可用 `Error.prepareStackTrace` 拿到 CallSite，但跨 realm 帧的 `getFunction()` 在当前 Node（v22/v26 实测）返回 undefined，取不到宿主函数对象。这属于 Out of Scope 的"替换 node:vm"立项跟踪面，不在本 spec 验收范围内。

## 验收场景

1. 探针脚本执行 `__send.constructor("return process")()`：取到的值为 undefined，无法到达 process。
2. 探针枚举沙箱全局：不存在任何来自宿主 realm 的函数值（以函数身份/源码特征断言）。
3. 全链路正常 run（ask / world.run / artifact / report）在白名单环境下行为与现状一致。
4. 桌面打包态（execPath 指向 Electron Helper）下 run 正常启动、不卡在 run-started。
5. CLI `.env` 中预埋的假密钥不出现在子进程可枚举环境中。

## Testing Decisions

- Seam：只用一条缝——harness 公共入口 `runWorkflowScript` 的集成测试。探针以脚本形态喂入，断言其 stdout/返回值与结算结果；不测内部实现。
- **夹具按可复用设计**：本目录另两份 spec（协议镜像守卫、结算语义表）将在同一集成缝上追加用例，注入手段（子进程行为替换：挂起/被杀/输出坏行）应做成共享夹具而非用例内联。
- 运行环境前提：mise 钉定 node 24.14.0（本机 PATH 可能是 v22.23.2，曾在其他包出现测试加载失败）；运行器沿用仓库先例（`pnpm exec tsx --test` 或 `node --test`，以能加载为准并写进测试说明）。
- 测试注入：现有 spawn 参数已可注入 execPath/argsPrefix；白名单用注入 env 的方式驱动，不 mock 内部。
- Prior art：apps/zcode-cli 树当前零测试文件（本次实跑确认）；仓库可参照的先例是 packages/services/test 的 node:test 风格。本测试将是 dynamic-workflow-runtime 包的第一个测试。

## Out of Scope

- 用 isolate / 独立进程级沙箱替换 node:vm（更大的架构手术，另行立项）。
- 脚本权限模型与确认窗审批面的改造。
- 商店脚本的静态扫描/签名机制。

## 待确认问题（替用户做的默认决定）

1. env 白名单的具体清单默认取"当前 spawn 实际依赖项"，新增业务变量的显式审批机制未定（确认窗展示 or 配置文件）——默认不做审批，仅白名单。
2. 是否在确认窗向用户展示"此脚本运行于 env 白名单"以增强透明度——默认不做，仅文档说明。

## Further Notes

- P0 依据：商店生态 + 模型代写脚本是产品定位的一部分，逃逸使二者不可信。
- 本 spec 由 to-spec 流程从实跑发现整理；issue 未创建（无 tracker 配置），创建后请贴 `ready-for-agent` 标签。
