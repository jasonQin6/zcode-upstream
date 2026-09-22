# Spec：动态工作流结算语义表（文档向实现对齐）

> 元信息：来源 = repo-adoption 工作流实跑（run dwfrun-1efe6d6a）的分析师发现，2026-09-22 立项。
> 优先级 P2（规格债）。状态：待人工创建 issue（贴 `ready-for-agent` 标签）。

## Problem Statement

调用方（主代理、桌面宿主、未来任何集成方）依赖 run 的终结状态决定"能不能 resume、该告诉用户什么"。当前结算语义的权威描述**互相矛盾**：文档说超时/崩溃/协议损坏结算 `failed`、由 `engine.cancel()` 触发"真取消"；实现里这些场景实际全部结算为 `stopped`（原因 `interrupted`，可 resume），而 `engine.cancel()` 这个方法根本不存在。三处文档、两处代码注释、一处实现，四个说法。

后果：按文档写分支的调用方会把"可恢复的 stopped"当"终局 failed"处理，**resume 能力被静默丢弃**；`GetWorkflowRun` 的停止原因词表（user/model/interrupted/provider/superseded）在文档里无处可查。

现状取证（2026-09-22）：

- README 结算词表写作 `{completed|failed|cancelled}`（README.md:26），并称超时/崩溃/协议损坏"结算 failed"、abort 调 `engine.cancel()` 结算 `cancelled`（README.md:52-58）；
- 实现：超时/子进程退出/NDJSON 损坏全部走 `interruptRun → engine.stop("interrupted")`（harness.ts:379-386、:400-407、:415-423），真实词表是 `completed|errored|stopped`（engine 的 RunSettlement 定义）；
- 引擎中不存在任何 `cancel(` 方法（grep 零命中）；
- harness 自身 docstring（:23-28、:326-328）与同文件实现注释（:165-171）互相矛盾。

## Solution

产出**一份会被测试锁定的结算语义表**，作为唯一真源；所有文档与注释改为引用该表。表的维度：终态触发条件 → 结算状态 → stop reason → 是否可 resume → 通知文案要点。

触发条件全集合（现状盘点）：脚本正常 return；脚本抛错/引擎级失败；墙钟超时；子进程崩溃/被杀；NDJSON 行损坏；abort 信号（`"model"` / `"interrupted"` / `"user"` 归因）；provider 确定性错误；`superseded`（被修订取代）。

方向明确为**文档向实现对齐**：以现有实现为正确行为编写语义表；若编表过程中发现实现自身不一致，逐条单列、以实现现状为准记录，不做顺手的行为修改。

## User Stories

1. As a 集成方（桌面宿主）, I want 一份权威的终态语义表, so that 我对 `stopped` 正确提供"继续"按钮而不是报错。
2. As a 主代理, I want 完成通知的停止原因与文档一一对应, so that 我能机械地决定 resume / amend / 报告用户。
3. As a 新工程师, I want 读语义表而不是对读四处文档与实现, so that 十分钟建立正确心智模型。
4. As a 平台维护者, I want 语义表被表驱动测试锁定, so that 改结算行为必须同时改表与测试，文档不再腐烂。
5. As a 文档读者, I want README 的示例代码按真实词表可运行, so that 复制粘贴不产生错误分支。

## Implementation Decisions

- 语义表落为包内单一常量（或测试夹具常量），导出供测试与文档生成引用；表结构：`触发条件 | 结算 status | stop reason | 可 resume | 通知要点`。
- README 与两处 docstring 的结算段落全部改为指向语义表的一句引用 + 精简示例（按真实词表 `completed|errored|stopped` 重写示例代码）。
- 本 spec **不改任何结算行为**；发现的实现内不一致仅登记在 Further Notes，另行处理。
- `engine.cancel()` 的说法从文档中移除（对应机制实际是 abort 信号驱动的 `stop`）。

## 验收场景

1. 表驱动测试覆盖语义表每一行：注入对应触发条件（假子进程超时/被杀/输出坏行/正常完成/abort），断言结算 status、stop reason 与 resume 可用性与表一致。
2. README 的结算词表、示例代码与语义表逐字一致（文档校验测试或人工核对项）。
3. 对一个 `stopped(interrupted)` run 执行 resume：行为与语义表"可 resume"标注相符。

## Testing Decisions

- Seam：harness 公共入口 `runWorkflowScript`，通过注入子进程行为（挂起触发墙钟超时、kill、输出坏行）覆盖各行；表驱动，一行一测。若 sandbox-boundary spec 的集成夹具已落地（子进程行为注入：挂起/被杀/坏行），直接复用。
- 环境前提：mise node 24；运行器沿用仓库先例（`pnpm exec tsx --test` / `node --test`）。
- Prior art：与 sandbox-boundary、wire-protocol-mirror 两 spec 的测试同批引入（该包首个测试）；风格沿用 node:test。

## Out of Scope

- 任何结算行为的修改（含把超时改回 `failed` 的讨论——如需变更，先改本表再立项）。
- 通知文案的具体措辞改版（表中只登记要点）。

## 待确认问题（替用户做的默认决定）

1. "文档向实现齐"而非"实现向文档齐"——依据是 stop/resume 语义已被 GUI 与主代理实际消费，改动波及面大；如产品认为 `failed/cancelled` 词表更对，应反向立项。

## Further Notes

- 语义表初稿可直接由现状盘点生成（条件清单见 Solution），实现工作量主要在测试注入而非行为改动。
- issue 未创建（无 tracker 配置），创建后请贴 `ready-for-agent` 标签。

## 实施记录（2026-09-22）

- 语义表落地为 `dynamic-workflow-runtime/src/settlement-semantics.ts` 的单一导出常量
  `SETTLEMENT_SEMANTICS`（10 行，覆盖 Solution 列出的全部触发条件），经包 index 导出；
  `isResumable()` 与 bootstrap 的 resume 门谓词（dynamic-workflow-run-observation.ts 的
  `isResumableSettlement`）同规，测试用该规则镜像逐行断言表上的 resumable 列。
- 表驱动测试 `test/settlement-semantics.test.ts`：每行按 injection 列注入（正常完成 /
  lowered throw / 假子进程挂起触发超时 / SIGKILL / 坏行 / abort 归因 ×4 / fake driver
  stopRun），断言结算 status、stop reason、resumable 与表一致；另含文档校验测试（README
  词表同源、engine.cancel 不复存在）与验收场景 3 的**执行型 resume**（同 runId + 同 journal
  第二次 runWorkflowScript，stopped(interrupted) 续跑至 completed，run 1 的 report 节点
  在 journal 连续保留）。
- 编表过程**未发现实现内部不一致**需要登记 Further Notes：failRun（脚本之错/引擎级失败 →
  errored）与 interruptRun（宿主侧故障 → stopped(interrupted)）的分工与 settlement 形状
  （error 只在有失败事实的行在场）自洽；spec Problem Statement 所述四处矛盾全部消除。
- 夹具扩展（harness-fixture.ts）：`runWithFakeChild` 支持 scriptTail（挂起/SIGKILL 注入）、
  runId、signal、captured 复用（同 journal 第二次 run 即引擎语义下的 resume）与 driver
  stopRun 钩子。
