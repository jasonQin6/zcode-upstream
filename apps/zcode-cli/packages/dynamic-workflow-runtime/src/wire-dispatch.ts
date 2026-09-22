/**
 * 父进程侧的线消息分派层（从 harness.ts 拆出——该文件顶到仓库 400 行上限，拆分先例同
 * `@zcode/dynamic-workflow` 的 engine/engine-state.ts）。
 *
 * 职责只有一件：把一条已解析的 child→parent 消息（{@link ChildMessage}）分派进引擎或回
 * 应答——create-actor 同步建映射、event 同步落 journal（FIFO 顺序承重）、request 异步桥接、
 * complete 结算。生命周期（spawn、超时、abort、finalize）仍归 harness 的 bridge。
 *
 * 运行期未知消息（kind / event.type / request.type）的可观测兜底也在这里：warn 进 journal
 * 而不静默、不失败，与 NDJSON 损坏（传输错误 → 中断结算）分级——见
 * docs/specs/dynamic-workflow/wire-protocol-mirror.md 与 test/wire-protocol-mirror.test.ts。
 */

import type { ChildProcess } from "node:child_process";
import { WorkflowError, type ActorId, type WorkflowEngine } from "@zcode/dynamic-workflow";
import type { ChildMessage, ResponseMessage } from "./protocol.js";

interface RequestDeps {
  engine: WorkflowEngine;
  actorMap: Map<string, ActorId>;
  child: ChildProcess;
  failRun: (error: WorkflowError) => void;
  unknownMessageCounts: Map<string, number>;
}

interface MessageDeps {
  engine: WorkflowEngine;
  actorMap: Map<string, ActorId>;
  child: ChildProcess;
  failRun: (error: WorkflowError) => void;
  /** 未知消息的累计计数（每个 run 一份，warn 事件带它）；见 warnUnknownChildMessage。 */
  unknownMessageCounts: Map<string, number>;
}

/** 分发一条 child→parent 消息。ask/world-read 异步桥接到引擎并回 response（搭载最新预算）。 */
export function handleChildMessage(message: ChildMessage, deps: MessageDeps): void {
  const { engine, actorMap, child, failRun, unknownMessageCounts } = deps;

  switch (message.kind) {
    case "create-actor": {
      // 同步处理：在任何引用该句柄的 ask 之前把映射建好（stdio FIFO 前提）。createActor 是纯同步的，
      // 若 run 已结算会同步抛错——此时没有 response 通道，捕获后归为 run 失败（多为无害的收尾竞态）。
      try {
        const actorId = engine.createActor(
          message.siteId,
          message.name,
          message.persona as string | undefined,
        );
        actorMap.set(message.localId, actorId);
      } catch (cause) {
        failRun(
          cause instanceof WorkflowError
            ? cause
            : new WorkflowError("DriverError", `createActor failed at site ${message.siteId}`, {
                cause,
              }),
        );
      }
      return;
    }
    case "event":
      // 同步分派，与 log 一致：事件通道的 FIFO 顺序对 report 与 declare-artifact 都是承重的
      // （父进程 journal 的就是到达的东西，而一条打了标签的 report 必须晚于它的声明落库），
      // 异步化会让到达顺序与 journal 顺序脱钩。
      if (message.type === "report") {
        engine.report(message.siteId, message.item, message.artifactId);
      } else if (message.type === "declare-artifact") {
        engine.declareArtifact(message.siteId, message.op, message.args);
      } else if (message.type === "phase-entered") {
        engine.enterPhase(message.name);
      } else if (message.type === "log") {
        engine.log(message.message);
      } else {
        // 未知事件 type（版本错位：新旧 CLI 读对方的 run）：warn 进 journal 并继续，绝不
        // 静默——修复前这里会把任何未知 type 当 log 消息读（message 字段都不存在）。
        // wire-protocol-mirror spec 的运行期兜底层；分级上与 NDJSON 损坏（中断）不同。
        warnUnknownChildMessage(
          engine,
          unknownMessageCounts,
          "event.type",
          String((message as { type?: unknown }).type),
        );
      }
      return;
    case "complete":
      if (message.ok) {
        engine.complete(message.value);
      } else {
        // 脚本抛错：run 失败（错误明细来自沙箱）。
        const err = message.error;
        failRun(
          new WorkflowError("DriverError", err?.message ?? "The workflow script threw an error", {
            cause: err?.stack ?? err?.name,
          }),
        );
      }
      return;
    case "request":
      handleRequest(message, { engine, actorMap, child, failRun, unknownMessageCounts });
      return;
    default: {
      // 编译期 exhaustive 检查**保留**：协议新增 kind 而本 switch 没跟上 case 时，这一行
      // 直接编译报错——它管的是同仓库内的演进漏改。
      const _exhaustive: never = message;
      void _exhaustive;
      // 运行期兜底管的是编译期管不住的另一面：**跨版本**读写对方的 run（旧 CLI 二进制读
      // 新 run / 反之），运行期会真的落进这里。兜底是**可观测而非静默**：warn 进 journal
      // （kind 值 + 累计计数），run 继续不失败。与 NDJSON 损坏（传输错误 → 中断结算）
      // 刻意分级：未知 kind 是版本错位，可观测、可继续。TS 视角 message 是 never，运行期
      // 不是，故取值走断言。见 docs/specs/dynamic-workflow/wire-protocol-mirror.md；
      // 协议 ↔ 子进程镜像的一致性另有守卫测试（test/wire-protocol-mirror.test.ts）。
      warnUnknownChildMessage(
        engine,
        unknownMessageCounts,
        "kind",
        String((message as { kind?: unknown }).kind),
      );
    }
  }
}

/** 桥接一次需应答的 host 调用（ask / world-read）到引擎，settle 后回 response。 */
function handleRequest(
  message: Extract<ChildMessage, { kind: "request" }>,
  deps: RequestDeps,
): void {
  const { engine, actorMap, child, unknownMessageCounts } = deps;

  const respond = (ok: boolean, value: unknown, error?: WorkflowError): void => {
    const response: ResponseMessage = {
      kind: "response",
      id: message.id,
      ok,
      ...(ok ? { value } : { error: toWireError(error) }),
    };
    // 子进程可能已退出（取消/失败收尾）：仅在可写时写，EPIPE 等 I/O 竞态吞在此边界（run 已在结算）。
    const stdin = child.stdin;
    if (stdin === null || !stdin.writable) return;
    stdin.write(`${JSON.stringify(response)}\n`, () => undefined);
  };

  let promise: Promise<unknown>;
  if (message.type === "ask") {
    const actorId = actorMap.get(message.actor ?? "");
    if (actorId === undefined) {
      // 映射缺失（理应不会发生：FIFO 保证）——归一成 UnknownActor 结构化拒绝，不静默。
      respond(
        false,
        undefined,
        new WorkflowError("UnknownActor", `Unknown subagent handle: ${message.actor}`),
      );
      return;
    }
    promise = engine.ask(message.siteId, actorId, message.instructions ?? "");
  } else if (message.type === "publish-artifact") {
    const op = message.artifactOp;
    if (op === undefined) {
      // 缺 op 是接线错误（lowering 恒填它）。**不编一个默认值**：一个被当成 file 处理的
      // markdown 发布，错误会出现在离故障点很远的地方。归一成结构化拒绝，脚本看得见。
      respond(
        false,
        undefined,
        new WorkflowError(
          "DriverError",
          `publish-artifact request is missing artifactOp (site ${message.siteId})`,
        ),
      );
      return;
    }
    promise = engine.publishArtifact(message.siteId, op, message.args ?? []);
  } else if (message.type === "world-read") {
    // op/args 原样转交引擎：本层不看 op、不校验元数（那是 driver 的职责）。缺失 args 归一为空数组，
    // 让 driver 的实参校验大声拒绝，而不是在这里悄悄编一个默认值。
    promise = engine.worldRead(message.siteId, message.op ?? "read", message.args ?? []);
  } else {
    // 未知 request type（版本错位）：与未知 kind 同族的可观测兜底，但这里**必须应答**——
    // 子进程侧有 promise 在 await，不应答会挂到超时。warn 进 journal 计数后回一条结构化
    // 拒绝，脚本能 catch 到"对端不认识这种请求"，run 不失败、不静默、不挂死。
    // （修复前任何未知 type 都会被静默当成 world-read 执行，op 字段还多半是 undefined。）
    const unknownType = String((message as { type?: unknown }).type);
    warnUnknownChildMessage(engine, unknownMessageCounts, "request.type", unknownType);
    respond(
      false,
      undefined,
      new WorkflowError(
        "DriverError",
        `the workflow host does not know request type "${unknownType}" (version skew between the sandbox and the host)`,
      ),
    );
    return;
  }

  promise.then(
    (value) => respond(true, value),
    (cause: unknown) => {
      const error =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError(
              "DriverError",
              cause instanceof Error ? cause.message : String(cause),
              { cause },
            );
      respond(false, undefined, error);
    },
  );
}

/**
 * 未知子进程消息的可观测兜底（wire-protocol-mirror spec 的运行期层）：产生一条结构化 warn
 * 进 journal（经引擎的 log 事件轨，run 结算后到达的调用被引擎忽略），带字段、值与**累计
 * 计数**；不抛错、不结算失败——与 NDJSON 损坏（传输错误 → 中断结算）分级：未知消息是
 * 版本错位，可观测、可继续。消息形如
 * `[workflow-warn] {"warn":"unknown-child-message","field":"kind","value":"mystery","count":2}`，
 * 前缀供人读/日志检索，JSON 体供 journal 消费方机械解析。
 */
function warnUnknownChildMessage(
  engine: WorkflowEngine,
  counts: Map<string, number>,
  field: string,
  value: string,
): void {
  const key = `${field}=${value}`;
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  engine.log(
    `[workflow-warn] ${JSON.stringify({ warn: "unknown-child-message", field, value, count })}`,
  );
}

/** WorkflowError → 线形态（保留 code/violations/finalText，供沙箱脚本 try/catch 结构化处理）。 */
function toWireError(error: WorkflowError | undefined): ResponseMessage["error"] {
  if (error === undefined) return { name: "Error", message: "unknown error" };
  const wire: NonNullable<ResponseMessage["error"]> = {
    name: error.name,
    message: error.message,
    code: error.code,
  };
  if (error.violations !== undefined) wire.violations = error.violations;
  if (error.finalText !== undefined) wire.finalText = error.finalText;
  return wire;
}
