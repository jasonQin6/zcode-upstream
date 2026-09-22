/**
 * 沙箱边界集成测试（spec：docs/specs/dynamic-workflow/sandbox-boundary.md）。
 *
 * 一条缝：全部用例经公共入口 runWorkflowScript 以真实子进程跑（共享夹具见 helpers/），
 * 不 mock harness 内部。逃逸探针以 lowered 形态喂入（绕过编译器——被测对象是 vm 契约本身）。
 *
 * 运行器：`pnpm test`（= tsx --test test/*.test.ts，node:test 风格同 packages/services/test
 * 先例）。spec 预设 mise 钉定的 node 24.14.0；本机无 mise 时以能加载 node:test 的解释器为准
 * （spec Testing Decisions 的回退规则），已在 node v26.7.0 与 v22.23.2 下验证。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AskSpec } from "@zcode/dynamic-workflow";
import { buildChildEnv } from "../src/child-env.js";
import { runInSandbox, findElectronBinary } from "./helpers/harness-fixture.js";
import {
  CONSTRUCTOR_SWEEP_PROBE,
  PROCESS_ENV_PROBE,
  type ConstructorSweepFindings,
  type ProcessProbeFindings,
} from "./helpers/escape-probes.js";

/** 预埋进测试进程 env 的假凭据（KEY|TOKEN|SECRET|CREDENTIAL 家族的替身）。 */
const ESCAPE_CANARY = "zcode-escape-canary-9c3f";
const ESCAPE_CANARY_ENV = "ZCODE_SECRET_ESCAPE_CANARY";

test("逃逸面 1+2+3：__send / constructor 两跳 / globalThis 枚举全部不可达宿主 realm", async () => {
  const { settlement } = await runInSandbox({ lowered: CONSTRUCTOR_SWEEP_PROBE });
  assert.equal(
    settlement.status,
    "completed",
    `探针 run 应正常结算：${JSON.stringify(settlement)}`,
  );
  const findings = settlement.artifact as ConstructorSweepFindings;

  // 场景 1：__send 不存在，constructor 逃逸取不到 process。
  assert.equal(findings.sendPresent, false, "修复后沙箱不应再有 __send 全局");
  assert.equal(findings.sendEscape, "absent");

  // 场景 2：globalThis（含一级成员）不存在任何来自宿主 realm 的函数值。
  assert.deepEqual(
    findings.crossRealmFunctions,
    [],
    `发现跨 realm 函数值：${JSON.stringify(findings.crossRealmFunctions)}`,
  );

  // 目标属性：任何全局（含发件箱、__host、Date/Math 等内建）经 constructor 两跳都拿不到 process。
  assert.deepEqual(
    findings.constructorEscapes,
    [],
    `constructor 两跳逃逸仍可达：${JSON.stringify(findings.constructorEscapes)}`,
  );
});

test("逃逸面 4：process 不可达，预埋凭据（SECRET canary）不出现在沙箱可达字符串中", async () => {
  const previous = process.env[ESCAPE_CANARY_ENV];
  process.env[ESCAPE_CANARY_ENV] = ESCAPE_CANARY;
  try {
    const { settlement } = await runInSandbox({ lowered: PROCESS_ENV_PROBE });
    assert.equal(
      settlement.status,
      "completed",
      `探针 run 应正常结算：${JSON.stringify(settlement)}`,
    );
    const findings = settlement.artifact as ProcessProbeFindings;

    assert.equal(findings.processType, "undefined");
    assert.equal(findings.globalProcessType, "undefined");
    assert.equal(findings.requireType, "undefined");
    assert.match(findings.importOutcome, /^refused:/, "动态 import 必须被 vm 拒绝");

    // 场景 5：白名单外的 env（此处预埋的 SECRET canary）既进不了子进程环境，也没有任何
    // 逃逸路径把它带回沙箱可达字符串。
    assert.equal(
      findings.reachableText.includes(ESCAPE_CANARY),
      false,
      "canary 出现在沙箱可达字符串中——存在未知的逃逸/继承路径",
    );
  } finally {
    // 还原测试进程环境（白名单靠结构保证，不靠残留状态）。
    if (previous === undefined) {
      delete process.env[ESCAPE_CANARY_ENV];
    } else {
      process.env[ESCAPE_CANARY_ENV] = previous;
    }
  }
});

test("环境白名单：只放行清单内变量，ELECTRON_RUN_AS_NODE 恒置 1（可注入 env 驱动）", () => {
  const env = buildChildEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/home/tester",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
    // 白名单外的两个典型样本：业务凭据与旗标注入向量。
    [ESCAPE_CANARY_ENV]: ESCAPE_CANARY,
    NODE_OPTIONS: "--require=pwn.js",
  });
  assert.equal(
    env.ELECTRON_RUN_AS_NODE,
    "1",
    "白名单必须显式带 ELECTRON_RUN_AS_NODE=1（桌面打包态保命项）",
  );
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/tester");
  assert.equal(env.TMPDIR, "/tmp");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env[ESCAPE_CANARY_ENV], undefined, "白名单外变量不得进入子进程环境");
  assert.equal(env.NODE_OPTIONS, undefined, "NODE_OPTIONS（旗标注入向量）不得进入子进程环境");

  // CLI 启动时会把 ELECTRON_RUN_AS_NODE 从自身 env sanitize 掉：父进程没有它也要恒置 1。
  assert.equal(buildChildEnv({}).ELECTRON_RUN_AS_NODE, "1");
});

test("全链路回归：ask / world.run / artifact / report 在白名单环境下行为不变", async () => {
  // 单 ask 站点的脚本：站点 id 是源码序的 ask#1（analysis/sites.ts 的 per-kind 计数器）。
  const scriptText = `
phase("全链路验证");
log("starting happy path");
const reviewer = agent("reviewer");
const verdict = await reviewer.ask("please review the tiny thing");
const probe = await world.run("node", ["-v"]);
await artifact.markdown("summary", "# happy path");
report({ verdict: verdict, exitCode: probe.exitCode });
return { verdict: verdict, exitCode: probe.exitCode };
`;
  const askSpecs = new Map<string, AskSpec>([["ask#1", { typed: false }]]);
  const { settlement, captured } = await runInSandbox({ scriptText, askSpecs });

  assert.equal(settlement.status, "completed", `run 应完成：${JSON.stringify(settlement)}`);

  // ask：fake driver 收到指令并以 untyped 最短路结算；脚本拿到该结果。
  assert.equal(captured.asks.length, 1);
  assert.equal(captured.asks[0]?.instructions, "please review the tiny thing");
  assert.equal(captured.asks[0]?.siteId, "ask#1");
  assert.deepEqual(settlement.artifact, {
    verdict: "answer:ask#1@1",
    exitCode: 0,
  });

  // world.run（world-read 通道的 op "run"）：位置实参原样到达 driver。
  assert.ok(
    captured.worldReads.some(
      (row) => row.op === "run" && JSON.stringify(row.args) === '["node",["-v"]]',
    ),
    `world.run 应到达 driver：${JSON.stringify(captured.worldReads)}`,
  );

  // 内容产物：经 driver 发布并落了引用记录。
  assert.equal(captured.artifacts.length, 1);
  assert.equal(captured.artifacts[0]?.id, "summary");
  assert.equal(captured.artifacts[0]?.content, "# happy path");

  // report：事件轨上有到达序承重的 report 事件（journal 同形）。
  const reportEvents = captured.events.filter((event) => event.type === "report");
  assert.equal(reportEvents.length, 1);
  assert.deepEqual(
    reportEvents[0] !== undefined && reportEvents[0].type === "report"
      ? reportEvents[0].item
      : undefined,
    { verdict: "answer:ask#1@1", exitCode: 0 },
  );

  // 生命周期事件齐全：run-started 在前、run-settled completed 收尾。
  assert.equal(captured.events[0]?.type, "run-started");
  const settled = captured.events[captured.events.length - 1];
  assert.ok(
    settled !== undefined && settled.type === "run-settled" && settled.status === "completed",
  );
});

test(
  "桌面打包态模拟：Electron execPath + 白名单 env 下 run 正常启动并结算",
  {
    skip:
      findElectronBinary() === undefined
        ? "electron 二进制未安装（node_modules/electron/dist 缺失）"
        : false,
  },
  async () => {
    const electronBinary = findElectronBinary();
    assert.ok(electronBinary !== undefined);
    // ELECTRON_RUN_AS_NODE=1 让 Electron 按纯 Node 启动；若白名单回归丢了这一项，这里会按完整
    // Electron 应用启动并静默卡死，由 30s 墙钟超时打成 stopped(interrupted)——正是验收场景 4
    // 要挡住的死法。
    const { settlement, captured } = await runInSandbox({
      lowered: `
__host.log("booted");
return { ok: true, where: "electron" };
`,
      execPath: electronBinary,
      timeoutMs: 30_000,
    });
    assert.equal(
      settlement.status,
      "completed",
      `Electron 下 run 应完成：${JSON.stringify(settlement)}`,
    );
    assert.deepEqual(settlement.artifact, { ok: true, where: "electron" });
    // 双向 NDJSON 都活着：子进程的事件行（log）也到达了父进程。
    assert.ok(
      captured.events.some((event) => event.type === "log" && event.message === "booted"),
      "子进程 log 事件未到达父进程",
    );
  },
);
