/**
 * 结算语义表的表驱动测试（spec：docs/specs/dynamic-workflow/settlement-semantics.md）。
 *
 * 语义表（SETTLEMENT_SEMANTICS，包内唯一真源）的每一行按 `injection` 列注入对应子进程
 * 行为（正常完成 / 抛错 / 挂起触发墙钟超时 / SIGKILL / 坏行 / abort 归因 / provider stop），
 * 断言实际结算的 status、stop reason、resumable 与表一致——**改结算行为必须同时改表与
 * 这里**。resumable 断言按表上的列 + 与 bootstrap resume 门同规的 isResumable 镜像双查。
 * 另含验收场景 3：对一个 stopped(interrupted) run **执行** resume（同 runId + 同 journal
 * 第二次 runWorkflowScript），行为与表标注相符。
 *
 * 运行器说明同 test/sandbox-boundary.test.ts（tsx --test；node 22/26 验证通过）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WorkflowError } from "@zcode/dynamic-workflow";
import type { RunSettlement } from "@zcode/dynamic-workflow";
import {
  isResumable,
  SETTLEMENT_SEMANTICS,
  type SettlementRow,
} from "../src/settlement-semantics.js";
import { runInSandbox, runWithFakeChild } from "./helpers/harness-fixture.js";

/** 表行 → 结算事实的一致性断言（所有行共用）。 */
function assertSettlementMatchesRow(row: SettlementRow, settlement: RunSettlement): void {
  assert.equal(
    settlement.status,
    row.status,
    `[${row.trigger}] status 应为 ${row.status}：${JSON.stringify(settlement)}`,
  );
  if (row.stopReason !== undefined) {
    assert.ok(
      settlement.status === "stopped" && settlement.reason === row.stopReason,
      `[${row.trigger}] stopReason 应为 ${row.stopReason}：${JSON.stringify(settlement)}`,
    );
  }
  const actualResumable = isResumable(settlement.status, resumableProbe(settlement));
  assert.equal(
    actualResumable,
    row.resumable,
    `[${row.trigger}] 可 resume 应为 ${row.resumable}（与 bootstrap resume 门同规的谓词）`,
  );
}

/** 从结算形状里安全取 stop reason（completed/errored 没有）。 */
function resumableProbe(settlement: RunSettlement): string | undefined {
  return settlement.status === "stopped" ? settlement.reason : undefined;
}

/**
 * 在 run **进行中**触发 abort：挂起的假子进程给了 5s 窗口，150ms 后 abort——放在
 * `await` 之前排定，否则 run 会先被墙钟超时结算，abort 永远打不进在飞的 run。
 */
function abortDuringRun(controller: AbortController, reason?: unknown): void {
  setTimeout(() => controller.abort(reason), 150);
}

test("语义表自身：resumable 列与 resume 门谓词（stopped ∧ ¬superseded）逐行一致", () => {
  assert.ok(SETTLEMENT_SEMANTICS.length >= 10, "语义表应覆盖全部触发条件");
  for (const row of SETTLEMENT_SEMANTICS) {
    assert.equal(
      row.resumable,
      isResumable(row.status, row.stopReason),
      `[${row.trigger}] 表上的 resumable 列与谓词不一致`,
    );
    // stop reason 只在 stopped 行上出现（表的结构不变式）。
    if (row.status !== "stopped") {
      assert.equal(row.stopReason, undefined, `[${row.trigger}] 非 stopped 行不应有 stopReason`);
    }
  }
});

test("文档校验：README 结算词表与语义表同词表，engine.cancel 表述不复存在", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  // 词表与语义表一致（真实三值）。
  assert.match(readme, /completed \| errored \| stopped/);
  // 旧词表与不存在的方法不再出现（"没有 failed / cancelled"这类否定句里的词是刻意的）。
  assert.doesNotMatch(readme, /status: "failed"/);
  assert.doesNotMatch(readme, /status: "cancelled"/);
  assert.doesNotMatch(readme, /engine\.cancel\(/);
  // README 指向语义表真源。
  assert.match(readme, /SETTLEMENT_SEMANTICS/);
});

test("语义表 script-return：正常 return → completed，不可 resume", async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "script-return")!;
  const { settlement } = await runInSandbox({ lowered: "return { ok: true };" });
  assertSettlementMatchesRow(row, settlement);
  assert.deepEqual(settlement.status === "completed" ? settlement.artifact : undefined, {
    ok: true,
  });
});

test("语义表 script-error：脚本抛错 → errored，不可 resume", async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "script-error")!;
  const { settlement } = await runInSandbox({ lowered: `throw new Error("boom-from-script");` });
  assertSettlementMatchesRow(row, settlement);
  assert.equal(settlement.status, "errored");
  assert.equal(settlement.status === "errored" ? settlement.error.code : undefined, "DriverError");
});

test("语义表 wall-clock-timeout：挂起触发墙钟超时 → stopped(interrupted)，可 resume", async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "wall-clock-timeout")!;
  const { settlement } = await runWithFakeChild([], {
    // 假子进程挂起（事件循环存活、零输出），父进程 400ms 墙钟到点 kill。
    scriptTail: "setTimeout(() => {}, 30000);",
    timeoutMs: 400,
  });
  assertSettlementMatchesRow(row, settlement);
  assert.match(
    settlement.status === "stopped" ? (settlement.error?.message ?? "") : "",
    /wall-clock timeout/,
    "超时行的失败信息应指名墙钟超时",
  );
});

test("语义表 child-crashed：SIGKILL 无 complete 即退出 → stopped(interrupted)，可 resume", async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "child-crashed")!;
  const { settlement } = await runWithFakeChild([], {
    scriptTail: `process.kill(process.pid, "SIGKILL");`,
  });
  assertSettlementMatchesRow(row, settlement);
});

test("语义表 ndjson-corrupted：坏行 → stopped(interrupted)，可 resume", async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "ndjson-corrupted")!;
  const { settlement } = await runWithFakeChild(['{"kind":"complete" oops']);
  assertSettlementMatchesRow(row, settlement);
});

test('语义表 abort-model：abort("model") → stopped(model)，可 resume', async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "abort-model")!;
  const controller = new AbortController();
  abortDuringRun(controller, "model");
  const { settlement } = await runWithFakeChild([], {
    scriptTail: "setTimeout(() => {}, 30000);",
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  assertSettlementMatchesRow(row, settlement);
});

test('语义表 abort-interrupted：abort("interrupted") → stopped(interrupted)，可 resume', async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "abort-interrupted")!;
  const controller = new AbortController();
  abortDuringRun(controller, "interrupted");
  const { settlement } = await runWithFakeChild([], {
    scriptTail: "setTimeout(() => {}, 30000);",
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  assertSettlementMatchesRow(row, settlement);
  assert.match(
    settlement.status === "stopped" ? (settlement.error?.message ?? "") : "",
    /owning session closed/,
    "宿主关闭行的失败信息应说明会话已关闭",
  );
});

test("语义表 abort-user：abort() 无归因 → stopped(user)，可 resume", async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "abort-user")!;
  const controller = new AbortController();
  abortDuringRun(controller);
  const { settlement } = await runWithFakeChild([], {
    scriptTail: "setTimeout(() => {}, 30000);",
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  assertSettlementMatchesRow(row, settlement);
});

test("语义表 provider-stop：driver 上报 ProviderStop → stopped(provider)，可 resume", async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "provider-stop")!;
  const { settlement } = await runInSandbox({
    lowered: [
      `var kicker = __host.createActor("ask#1", "kicker");`,
      `await __host.ask("ask#1", kicker, "kick the driver");`,
    ].join("\n"),
    askSpecs: new Map([["ask#1", { typed: false }]]),
    driverStopRun: new WorkflowError("ProviderStop", "fake deterministic provider failure", {
      providerStop: {
        kind: "quota",
        reason: "quota_exhausted",
        providerId: "fake",
        modelId: "jev-latest",
      },
    }),
  });
  assertSettlementMatchesRow(row, settlement);
});

test("语义表 superseded：abort({superseded}) → stopped(superseded)，不可 resume，带后继 id", async () => {
  const row = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "superseded")!;
  const controller = new AbortController();
  abortDuringRun(controller, { superseded: "successor-run-id" });
  const { settlement } = await runWithFakeChild([], {
    scriptTail: "setTimeout(() => {}, 30000);",
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  assertSettlementMatchesRow(row, settlement);
  assert.equal(
    settlement.status === "stopped" ? settlement.supersededBy : undefined,
    "successor-run-id",
  );
});

test("验收场景 3：对 stopped(interrupted) run 执行 resume——同 runId + 同 journal 续跑至 completed", async () => {
  // 第一次 run：假子进程只发一条 report 然后挂起，超时打断 → stopped(interrupted)，
  // journal 里留下 run 行（running→stopped）与 report 节点。
  const first = await runWithFakeChild(
    ['{"kind":"event","type":"report","siteId":"probe","item":{"n":42}}'],
    {
      scriptTail: "setTimeout(() => {}, 30000);",
      timeoutMs: 400,
      runId: "resume-target",
    },
  );
  assert.equal(first.settlement.status, "stopped");
  assert.ok(first.settlement.status === "stopped" && first.settlement.reason === "interrupted");
  const interruptedRow = SETTLEMENT_SEMANTICS.find((r) => r.trigger === "wall-clock-timeout")!;
  assertSettlementMatchesRow(interruptedRow, first.settlement);
  const runRowAfterStop = first.captured.journal.getRun("resume-target");
  assert.equal(runRowAfterStop?.status, "stopped");
  assert.equal(runRowAfterStop?.stopReason, "interrupted");

  // resume：同 runId + 同 captured（同 journal）第二次 run，假子进程直接 complete。
  // 引擎按既有行续跑（run 行已存在则不再 createRun），终态把 stopped 续写为 completed。
  const second = await runWithFakeChild(['{"kind":"complete","ok":true,"value":9}'], {
    captured: first.captured,
    runId: "resume-target",
  });
  assert.equal(
    second.settlement.status,
    "completed",
    `resume 应跑完：${JSON.stringify(second.settlement)}`,
  );
  assert.deepEqual(
    second.settlement.status === "completed" ? second.settlement.artifact : undefined,
    9,
  );
  // run 行从 stopped 续写为 completed；run 1 留下的 report 节点仍在（journal 连续）。
  const runRowAfterResume = second.captured.journal.getRun("resume-target");
  assert.equal(runRowAfterResume?.status, "completed");
  assert.ok(
    second.captured.journal
      .listNodes("resume-target")
      .some((node) => node.kind === "report" && JSON.stringify(node.result) === '{"n":42}'),
    "resume 后 run 1 的 report 节点应仍在 journal",
  );
});
