/**
 * runWorkflowScript 集成测试的共享夹具。
 *
 * 本目录三份 spec（沙箱边界、协议镜像守卫、结算语义表）约定复用**同一条公共入口缝**——
 * harness 的 runWorkflowScript——所以子进程行为替换与结果捕获的手段只在这里做一次，
 * 用例不得内联自己的注入逻辑（spec Testing Decisions）。
 *
 * 设计：
 * - 一律经公共入口喂入，不 mock harness 内部；cwd 用一次性临时目录，入口文件落在那里，
 *   不碰仓库工作区。
 * - driver 是最小内存 fake：untyped ask 在 startAsk 后由 queueMicrotask 直接以
 *   `answer:<site>@<ordinal>` 结算（走 scheduler-submit 的 handleTurnEnded 对 typed:false 的
 *   最短分支）；world-read/world-run 返回确定性罐头；产物发布记入内存。所有 Boundary B/C
 *   的往来都可在 {@link CapturedDriver} 里断言。
 * - 逃逸探针以 lowered 形态喂入（RunWorkflowOptions.lowered 绕过编译器——vm 契约本身才是
 *   被测对象），探针文本见 escape-probes.ts。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryJournalStore,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type AskSpec,
  type Caps,
  type RunEvent,
  type RunSettlement,
  type WorkflowDriver,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript, type DriverFactory, type RunWorkflowOptions } from "../../src/index.js";

/** driver 与引擎之间全部往来的捕获（断言读这里，不读内部实现）。 */
export interface CapturedDriver {
  /** startAsk 收到的每一次 ask：站点、序号、作者指令原文。 */
  asks: Array<{ siteId: string; ordinal: number; instructions: string }>;
  /** executeWorldRead 收到的每一次世界读取 / world.run（op 原样、args 为位置实参）。 */
  worldReads: Array<{ op: string; args: unknown[] }>;
  /** executeArtifactPublish 收到的每一次内容产物发布。 */
  artifacts: ArtifactPublishRequest[];
  /** Boundary C 事件流（run-started / report / run-settled …，到达序）。 */
  events: RunEvent[];
  journal: InMemoryJournalStore;
  /**
   * 本 captured 的 driver 工厂：同一 captured（同 journal）经它再次 runWorkflowScript 即是
   * 引擎语义下的 resume（resume 测试用）。工厂按次接收新 sink，可安全复用。
   */
  factory: DriverFactory;
}

/** 测试用 caps：两条并发上界，足够 fan-out 语义以后复用。 */
export const TEST_CAPS: Caps = { maxConcurrency: 2 };

export function makeCapturedDriver(options: { stopRun?: WorkflowError } = {}): CapturedDriver {
  const journal = new InMemoryJournalStore();
  const captured: CapturedDriver = {
    asks: [],
    worldReads: [],
    artifacts: [],
    events: [],
    journal,
    factory: () => undefined,
  } as CapturedDriver;
  const factory: DriverFactory = (sink: WorkflowReportSink): WorkflowDriver => ({
    createActorSession: async (actor) => ({ id: `fake:${actor.siteId}#${actor.ordinal}` }),
    startAsk: (_session, instance, message) => {
      captured.asks.push({
        siteId: instance.siteId,
        ordinal: instance.ordinal,
        instructions: message.instructions,
      });
      // provider 确定性错误注入：driver 在首个 ask 上报 stopRun，让整个 run 结算为
      // stopped(provider)——真实语义里这是模型侧错误（认证/配额/套餐）的路径。
      if (options.stopRun !== undefined) {
        sink.stopRun(options.stopRun);
        return;
      }
      // untyped ask 的最短结算路：turn 一结束即以 finalText 落定。queueMicrotask 让 startAsk
      // 的调用栈先 unwind，模拟"子代理跑了一会儿才回来"的最小异步形态。
      queueMicrotask(() => {
        sink.askTurnEnded(instance, `answer:${instance.siteId}@${instance.ordinal}`);
      });
    },
    respondToSubmit: () => undefined,
    cancelAsk: () => undefined,
    executeWorldRead: async (op, args) => {
      captured.worldReads.push({ op, args });
      // world.run 的罐头：非零退出码本来也是正常结果（WorldRunResult 语义），这里给确定的零，
      // 让脚本能对 stdout 做纯逻辑分支。
      if (op === "run") {
        return { exitCode: 0, stdout: "world-run-ok", stderr: "" };
      }
      return null;
    },
    executeArtifactPublish: async (request) => {
      captured.artifacts.push(request);
      const record: ArtifactVersionRecord = {
        id: request.id,
        kind: request.op,
        version: request.version,
        contentType: "text/markdown",
        bytes: 0,
        uri: `zcode-artifact://test/${request.runId}/${request.id}/v${request.version}`,
      };
      return record;
    },
    journal,
    emit: (event) => {
      captured.events.push(event);
    },
  });
  captured.factory = factory;
  return captured;
}

export interface SandboxRunInput {
  /** 作者脚本源码（走编译 + lowering 的全链路）。 */
  scriptText?: string;
  /** 已 lowered 的函数体（绕过编译器，安全探针的喂入形态）。优先于 scriptText。 */
  lowered?: string;
  /** 每个 ask 站点的静态规格；缺席即空表（探针没有 ask 站点）。 */
  askSpecs?: ReadonlyMap<string, AskSpec>;
  /** 桌面打包态模拟：spawn 的可执行文件替代（缺省 process.execPath）。 */
  execPath?: string;
  /** SEA re-exec 模拟：execPath 与入口之间的前缀（带它即走"无 Node 旗标"路径）。 */
  argsPrefix?: readonly string[];
  /** 墙钟超时；缺省 15s——探针若意外拿到宿主能力也不会把测试挂死。 */
  timeoutMs?: number;
  /** runId（缺省 "test-run"；resume 测试用同 runId + 同 journal 两次调用）。 */
  runId?: string;
  /** abort 信号注入（结算语义表的 abort 归因各行）。 */
  signal?: AbortSignal;
  /** driver 在首个 ask 上报 provider 确定性错误（结算 stopped(provider)）。 */
  driverStopRun?: WorkflowError;
  /**
   * 复用既有 captured（其 journal 一并复用）——resume 测试用：同一 runId + 同一 journal
   * 第二次 runWorkflowScript 即是引擎语义下的 resume（既有行命中重放）。
   */
  captured?: CapturedDriver;
}

export interface SandboxRunResult {
  settlement: RunSettlement;
  captured: CapturedDriver;
}

/** 一次完整 run：临时 cwd + 捕获 driver + 公共入口。测试断言返回值，不触内部。 */
export async function runInSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  // captured 复用（resume 测试）：同 journal + 同 captured 再跑一次即引擎语义下的 resume。
  const captured =
    input.captured ??
    makeCapturedDriver(
      ...(input.driverStopRun !== undefined ? [{ stopRun: input.driverStopRun }] : []),
    );
  const factory = captured.factory;
  const cwd = await mkdtemp(join(tmpdir(), "dwf-runtime-test-"));
  try {
    const options: RunWorkflowOptions = {
      ...(input.lowered !== undefined ? { lowered: input.lowered } : {}),
      ...(input.scriptText !== undefined ? { scriptText: input.scriptText } : {}),
      runId: input.runId ?? "test-run",
      makeDriver: factory,
      caps: TEST_CAPS,
      askSpecs: input.askSpecs ?? new Map<string, AskSpec>(),
      validate: () => [],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      timeoutMs: input.timeoutMs ?? 15_000,
      cwd,
      ...(input.execPath !== undefined || input.argsPrefix !== undefined
        ? {
            childSpawn: {
              ...(input.execPath !== undefined ? { execPath: input.execPath } : {}),
              ...(input.argsPrefix !== undefined ? { argsPrefix: input.argsPrefix } : {}),
            },
          }
        : {}),
    };
    const settlement = await runWorkflowScript(options);
    return { settlement, captured };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** {@link runWithFakeChild} 的附加选项：额外注入项透传 {@link runInSandbox}。 */
export interface FakeChildOptions extends Partial<SandboxRunInput> {
  /**
   * 追加在写行循环之后的**原始脚本体**（测试自担语法）：
   * - 挂起：`setTimeout(() => {}, 30000);`（事件循环存活，父进程超时/abort 可触达）
   * - 自杀：`process.kill(process.pid, "SIGKILL");`（崩溃/被杀行）
   */
  scriptTail?: string;
}

/**
 * **子进程行为注入**（结算语义、线协议镜像等 spec 复用的注入手段）：写一个临时"假子进程"
 * 脚本，它忽略 harness 附加的真实入口文件参数，只向 stdout 逐行写出 `lines` 里的原始行后
 * 退出（或按 `scriptTail` 挂起/自杀）。经 `childSpawn.argsPrefix` 注入——spawn 缝与生产
 * 完全同形（`node <假脚本> <入口>`），不 mock harness 内部。
 *
 * 用途：覆盖真实 lowered 脚本造不出来的线行为——未知 kind、坏 NDJSON 行、挂起触发墙钟
 * 超时、进程被杀——以驱动结算语义表的各行与运行期兜底。
 */
export async function runWithFakeChild(
  lines: string[],
  extra: FakeChildOptions = {},
): Promise<SandboxRunResult> {
  const dir = await mkdtemp(join(tmpdir(), "dwf-fake-child-"));
  const scriptPath = join(dir, "fake-child.mjs");
  const { scriptTail, ...sandboxInput } = extra;
  // 行内容由测试逐字给定（合法 JSON 或故意损坏的行都行），这里只负责逐行 + 换行写出。
  await writeFile(
    scriptPath,
    `const lines = ${JSON.stringify(lines)};\n` +
      `for (const line of lines) process.stdout.write(line + "\\n");\n` +
      `${scriptTail ?? ""}\n`,
    "utf8",
  );
  try {
    // lowered 随便给一个合法体即可：假子进程不会 import 入口文件，真实脚本不执行。
    return await runInSandbox({
      lowered: "return null;",
      argsPrefix: [scriptPath],
      ...sandboxInput,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 定位 Electron 可执行文件（桌面打包态模拟用）。electron 包的 index.js 在二进制已下载时
 * 返回可执行文件路径，未下载时抛错——两种情况都如实返回，调用方据此 skip，不假装测过。
 */
export function findElectronBinary(): string | undefined {
  try {
    const requireFromRepoRoot = createRequire(join(repoRoot(), "package.json"));
    const resolved: unknown = requireFromRepoRoot("electron");
    if (typeof resolved === "string" && resolved.length > 0 && existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // electron 未安装或二进制未下载。
  }
  return undefined;
}

/** 仓库根（夹具位于 <root>/apps/zcode-cli/packages/dynamic-workflow-runtime/test/helpers/）。 */
function repoRoot(): string {
  return fileURLToPath(new URL("../../../../..", import.meta.url));
}
