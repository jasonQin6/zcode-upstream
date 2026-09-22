/**
 * 结算语义表——run 终态语义的**唯一真源**（spec：docs/specs/dynamic-workflow/settlement-semantics.md）。
 *
 * 调用方（主代理、桌面宿主、未来任何集成方）依赖 run 的终结状态决定"能不能 resume、该告诉
 * 用户什么"。历史上这份语义在四处各说各话（README 的 failed/cancelled 词表、不存在的
 * `engine.cancel()`、两处互相矛盾的 docstring、实现本身）；本表以**实现现状**为准收敛成
 * 一行一处，被 test/settlement-semantics.test.ts 逐行锁定——改结算行为必须同时改表与测试。
 *
 * 词表（engine 的 RunSettlement）：`completed | errored | stopped`；stopped 携带 stop reason
 * （`user | model | provider | interrupted | superseded`）。**不存在** failed / cancelled。
 *
 * "可 resume" 列的判定规则与 bootstrap 的 resume 门同一个谓词
 * （dynamic-workflow-run-observation.ts 的 isResumableSettlement）：
 * `status === "stopped" && stopReason !== "superseded"`——stopped 一律可恢复（崩溃后重放
 * journal、跳过已结算节点），superseded 的未完结工作已归后继所有；errored 只能修订
 * （amend-resume 起新 run），completed 没有可续的工作。本包 app-free，谓词本体不在本包，
 * 测试用同一规则镜像断言（规则漂移时测试红）。
 *
 * resume 的执行形态：引擎以**同一 runId + 同一 journal** 再构造即是 resume——既有行命中
 * 即重放（跳过已结算节点），run 行从 stopped 续写为终态；脚本哈希两侧都有且不同则拒绝。
 */

import type { RunStopReason } from "@zcode/dynamic-workflow";

/** 结算状态词表（engine 的 RunSettlement.status）。真实词表只有这三个值。 */
export type SettlementStatus = "completed" | "errored" | "stopped";

/** 语义表的一行：一个终态触发条件 → 它的结算事实。 */
export interface SettlementRow {
  /** 触发条件的识别名（稳定 id；表驱动测试与文档引用按它索引）。 */
  readonly trigger: string;
  /** 人类描述：什么情况走到这一行。 */
  readonly condition: string;
  /** 测试如何注入该触发（runWorkflowScript 公共缝上的注入手段）。 */
  readonly injection: string;
  readonly status: SettlementStatus;
  /** 仅 `status === "stopped"` 时在场。 */
  readonly stopReason?: RunStopReason;
  /** superseded 专有：后继 run 的 id 落在 settlement.supersededBy。 */
  readonly reportsSupersededBy?: boolean;
  /** 可否 resume——与 bootstrap 的 resume 门谓词同规（见模块头注释）。 */
  readonly resumable: boolean;
  /** 通知文案要点（要点而非措辞；措辞归 UI / 完成通知渲染层）。 */
  readonly notify: string;
}

/**
 * 全部终态触发条件的结算语义。**行序刻意按"谁触发"分组**：脚本自身 → 宿主侧故障 →
 * abort 归因 → provider → 修订取代。测试逐行注入断言；README 与 docstring 只引用本表。
 */
export const SETTLEMENT_SEMANTICS: readonly SettlementRow[] = [
  {
    trigger: "script-return",
    condition: "脚本正常 return（顶层返回值即 settlement.artifact）",
    injection: "正常 lowered/scriptText 跑完",
    status: "completed",
    resumable: false,
    notify: "完成；交付物 = 顶层返回值与已发布产物",
  },
  {
    trigger: "script-error",
    condition:
      "脚本抛错，或引擎级契约违反（failRun 路径：create-actor 竞态失败、ReportCapExceeded、" +
      "UnknownActor、inputHash 不符、complete ok=false 等）",
    injection: "lowered 直接 throw",
    status: "errored",
    resumable: false,
    notify:
      "脚本报错（error 带稳定 code 与 message）；不可 resume，只能修订（amend-resume 起新 run）",
  },
  {
    trigger: "wall-clock-timeout",
    condition: "墙钟超时（timeoutMs 到点 kill 子进程）",
    injection: "假子进程挂起不输出 + timeoutMs",
    status: "stopped",
    stopReason: "interrupted",
    resumable: true,
    notify: "宿主侧故障（超时）；可 resume / 重跑，结果可信度不受影响",
  },
  {
    trigger: "child-crashed",
    condition:
      "子进程崩溃 / 被杀 / 未发 complete 即退出（含 spawn 失败、入口文件写不下这类宿主侧故障）",
    injection: "假子进程 SIGKILL 自己",
    status: "stopped",
    stopReason: "interrupted",
    resumable: true,
    notify: "宿主侧故障（沙箱进程异常退出，归因文本来自 stderr）；可 resume",
  },
  {
    trigger: "ndjson-corrupted",
    condition: "NDJSON 行损坏（子进程输出解析失败）",
    injection: "假子进程输出一行坏 JSON",
    status: "stopped",
    stopReason: "interrupted",
    resumable: true,
    notify:
      "宿主侧故障（协议损坏）；可 resume。注意与未知消息分级不同：未知 kind/type 是" +
      "版本错位 → warn 进 journal 继续运行（见 wire-dispatch），坏行是传输错误 → 中断",
  },
  {
    trigger: "abort-model",
    condition: 'abort 信号、reason 为 "model"（主代理 TaskStop 停掉自己发起的 run）',
    injection: 'AbortController.abort("model")',
    status: "stopped",
    stopReason: "model",
    resumable: true,
    notify: "主代理停止了这个 run；可 resume",
  },
  {
    trigger: "abort-interrupted",
    condition: 'abort 信号、reason 为 "interrupted"（宿主 App 关闭时停下自己拥有的 run）',
    injection: 'AbortController.abort("interrupted")',
    status: "stopped",
    stopReason: "interrupted",
    resumable: true,
    notify: "拥有会话已关闭，run 未结算完；可 resume（带 Interrupted 失败编码落库）",
  },
  {
    trigger: "abort-user",
    condition: "abort 信号、无 reason 或其他值（默认归因为用户操作）",
    injection: "AbortController.abort()",
    status: "stopped",
    stopReason: "user",
    resumable: true,
    notify: "用户按了停止；可 resume",
  },
  {
    trigger: "provider-stop",
    condition:
      "provider 确定性错误（driver 经 sink.stopRun 上报：认证失效、模型不在套餐、配额耗尽等）",
    injection: "fake driver 在 startAsk 时调 sink.stopRun(ProviderStop)",
    status: "stopped",
    stopReason: "provider",
    resumable: true,
    notify: "模型侧确定性错误（结构化明细在 settlement.error.providerStop）；可 resume",
  },
  {
    trigger: "superseded",
    condition:
      "abort 信号、reason 为 { superseded: <newRunId> }（AmendWorkflow 停下本 run 并以修订取代）",
    injection: 'AbortController.abort({ superseded: "successor-id" })',
    status: "stopped",
    stopReason: "superseded",
    reportsSupersededBy: true,
    resumable: false,
    notify: "本 run 被修订取代，未完结工作归后继；不可 resume 本 run（后继 id 在 supersededBy）",
  },
] as const;

/** resume 门的判定规则（与 bootstrap 的 isResumableSettlement 同规；见模块头注释）。 */
export function isResumable(status: SettlementStatus, stopReason?: RunStopReason): boolean {
  return status === "stopped" && stopReason !== "superseded";
}
