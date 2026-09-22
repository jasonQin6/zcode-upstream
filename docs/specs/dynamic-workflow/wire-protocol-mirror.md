# Spec：动态工作流线协议镜像一致性守卫 + 未知消息可观测

> 元信息：来源 = repo-adoption 工作流实跑（run dwfrun-1efe6d6a）的分析师发现，2026-09-22 立项。
> 优先级 P1（正确性）。状态：待人工创建 issue（贴 `ready-for-agent` 标签）。

## Problem Statement

动态工作流的沙箱子进程与父进程之间靠 NDJSON 线协议通信。协议定义与子进程侧实现是**两份手写镜像**：协议模块自称"唯一真源、两处必须一起改"，但子进程源码以内嵌字符串方式运行、只能 import 类型，编译期对两份镜像是否一致**没有任何检查**。同时，父进程对运行期收到的未知消息种类**静默丢弃、零日志**——这与其自身对 NDJSON 损坏"暴露而非吞掉"的原则相反。

后果链：协议每次演进（现有三种请求型 + 四种事件型，每加一种要人肉同步三处）→ 漏改镜像 → 该消息在运行期落入静默分支 → **journal 数据悄悄丢失而非报错**。对这个以"journal 可重放"为核心卖点的产品，丢消息就是丢产品承诺。

现状取证（2026-09-22）：

- 协议模块头注释："本模块是唯一真源……两处必须一起改"（protocol.ts:4-7）；
- 子进程侧自认："本文件是 protocol.ts 线协议的手写镜像……只允许 import 类型"（child-source.ts:29-30）；
- 父进程分派器的 default 分支 `const _exhaustive: never = message; void _exhaustive` 只是编译期技巧，运行期静默落入且零日志（harness.ts:490-494）。

## Solution

双保险，两层各自独立生效：

1. **镜像一致性守卫（编译期/CI 层）**：从协议模块的类型定义机械提取 message kind 清单，与子进程内嵌引导代码中的分派清单比对；清单不一致即测试红（或构建失败）。漏改镜像从"运行期静默丢数据"变成"提交时红屏"。
2. **运行期可观测（兜底层）**：父进程收到未知 kind 时，产生一条 warn 级 journal 事件（含 kind 值与计数），run 不因此失败——与"NDJSON 损坏即中断"区分开：损坏是传输错误（中断），未知 kind 是版本错位（可观测、可继续）。

## User Stories

1. As a 平台维护者, I want 漏改协议镜像在提交时就被发现, so that 我不必在排查"journal 少了一条事件"时才发现是协议演进漏了同步。
2. As a 平台维护者, I want 运行期未知消息有 warn 事件与计数, so that 版本错位（旧 CLI 读新 run / 新 CLI 读旧 run）可诊断。
3. As a workflow 作者, I want 长时间 run 的 journal 完整, so that 修订重跑（AmendWorkflow）的缓存判定不因丢消息而失真。
4. As a 用户, I want run 出现协议错位时被明确告知, so that 我能区分"工具坏了"和"结果可信"。
5. As a 新加入的工程师, I want 增改一种消息只需要改协议模块 + 跟着测试红名单走, so that 三处人肉同步的记忆负担消失。

## Implementation Decisions

- 一致性守卫实现为**测试**而非构建步骤（与仓库 node:test 先例一致）：从协议模块导出/反射 kind 清单，与内嵌引导源码做机械比对；比对逻辑对新增 kind 单向敏感（协议有、镜像无 → 红；镜像多、协议无 → 亦红）。
- 运行期兜底：分派器 default 分支改为产生一条结构化 warn 事件（kind、计数、run 上下文）进 journal；不抛错、不结算失败。
- 二者解耦上线：守卫防演进事故，可观测防存量/跨版本事故。
- 不改协议本身的形状与编号（镜像内容维持手写，只加守卫；代码生成是后续选项，见 Out of Scope）。

## 验收场景

1. 临时向协议模块新增一种 message kind 而不改镜像：一致性测试失败，错误信息指出缺失的 kind。
2. 反向（镜像有、协议无）：同样失败。
3. 运行期注入一条未知 kind 消息：journal 中出现 warn 事件（含 kind 与计数），run 继续正常结算。
4. 全部既有消息类型回归通过，现有 run 行为不变。

## Testing Decisions

- Seam：两条既有缝，不新增——(a) 镜像守卫测试直接 import 协议模块 + 读内嵌引导源码字符串（纯文本比对，无需起进程）；(b) 运行期兜底经 harness 公共入口注入伪造子进程输出验证 journal 事件。
- 环境前提与夹具：与 sandbox-boundary spec 相同（mise node 24；`pnpm exec tsx --test` / `node --test`）；若该 spec 的集成夹具已落地，直接复用，不另起炉灶。
- Prior art：仓库 node:test 先例（packages/services/test）；dynamic-workflow-runtime 包当前零测试，本测试与 sandbox-boundary spec 的测试同批引入。

## Out of Scope

- 用代码生成替代手写镜像（根治方案，涉及构建链改造，另行立项）。
- 协议版本号/协商机制的引入。

## 待确认问题（替用户做的默认决定）

1. 未知 kind 选择"warn + 继续运行"而非"fail run"——依据是与 NDJSON 损坏（中断）分级；若产品倾向 fail-closed，改一行分支即可。

## Further Notes

- 三处人肉同步点是既有债务：本 spec 只保证"漏改必被看见"，不消除同步本身。
- issue 未创建（无 tracker 配置），创建后请贴 `ready-for-agent` 标签。

## 实施记录（2026-09-22，落地形态与两处细化）

- **守卫实现**：`test/wire-protocol-mirror.test.ts` 从 protocol.ts 类型定义**文本提取** `kind` / `type` 字面量清单（正则接联合类型、对象字面量 emit、`kind !== "x"` 消费侧三类形态，逐行剥 `//` 注释防举例污染），与 child-source.ts 同法提取的清单双向比对；不引入第三份手工清单——协议模块仍是唯一真源。变异验证双向可红且错误信息点名缺失值。
- **分派器 exhaustive-never 保留**：spec 初稿写"改为产生 warn"——实际**两层都留**。编译期 `never` 断言管同仓库演进漏改（新增 kind 不加 case 直接编译红）；运行期 warn 管它管不住的跨版本二进制错位。二者阈值不同，删编译期等于倒退。
- **warn 载体**：`RunEvent` 词汇不动，经引擎现有 `log` 事件轨落 journal，消息形如 `[workflow-warn] {"warn":"unknown-child-message","field":"kind","value":"…","count":N}`——前缀可读/可检索，JSON 体可机械解析；按 `field=value` 累计计数，run 结算后到达的 warn 被引擎忽略。
- **未知消息的覆盖面细化为三层**（初稿只点名 kind）：未知 `kind` → warn+继续；未知 `event.type` → warn+继续（修复前会被当 log 消息读、字段全错）；未知 `request.type` → warn + 回**结构化拒绝** response（修复前会被静默当成 world-read 执行）——request 有 promise 在 await，不应答会挂到超时，拒绝让脚本可 catch，run 仍不失败。三层共用同一计数器与消息格式。
- 分派层随本次从 harness.ts 拆到 `wire-dispatch.ts`（仓库 400 行上限，先例同 engine/engine-state.ts），守卫测试读的镜像文件不变。
