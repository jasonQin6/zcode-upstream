/**
 * 线协议双镜像一致性守卫 + 运行期未知消息可观测（spec：
 * docs/specs/dynamic-workflow/wire-protocol-mirror.md）。
 *
 * 两层各自独立：
 * - **守卫**（纯文本比对，不起进程）：从 protocol.ts 的类型定义机械提取 kind / type 字面量
 *   清单，与 child-source.ts（内嵌引导源码的宿主文件）里的 emit / 消费字面量比对，双向敏感
 *   ——协议有镜像无（红）、镜像有协议无（也红），错误信息点名缺失的 kind。
 * - **运行期兜底**：经共享夹具的假子进程注入（childSpawn.argsPrefix，与生产同一条 spawn
 *   缝）喂入真实子进程造不出来的线消息（未知 kind / 未知事件 type / 坏 NDJSON 行），验证
 *   warn 进 journal 且 run 继续、与 NDJSON 损坏（中断结算）分级清晰。
 *
 * 运行器说明同 test/sandbox-boundary.test.ts（tsx --test；node 22/26 验证通过）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runWithFakeChild } from "./helpers/harness-fixture.js";

const protocolSource = readFileSync(
  fileURLToPath(new URL("../src/protocol.ts", import.meta.url)),
  "utf8",
);
const childSource = readFileSync(
  fileURLToPath(new URL("../src/child-source.ts", import.meta.url)),
  "utf8",
);

/**
 * 从源码里机械提取某字段的字符串字面量清单。三类形态都接：
 * - 联合类型 `type: "ask" | "world-read" | "publish-artifact";`
 * - 单字面量字段 `kind: "event";`
 * - 对象字面量 emit/consume：`__emit({ kind: "request", id: id, type: "ask", ... })`
 *   （值总以字面量开头，取捕获里的第一个字面量）与消费侧 `msg.kind !== "response"`。
 * 逐行剥 `//` 注释防举例污染；协议模块与镜像里没有含这两类字面形的块注释文本。
 */
function extractFieldLiterals(source: string, field: "kind" | "type"): Set<string> {
  const stripped = source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const out = new Set<string>();
  const addFrom = (captured: string): void => {
    for (const piece of captured.split("|")) {
      const literal = piece.match(/"([^"]+)"/);
      if (literal !== null) out.add(literal[1]!);
    }
  };
  for (const match of stripped.matchAll(new RegExp(`\\b${field}\\s*:\\s*([^;\\n]+)`, "g"))) {
    addFrom(match[1]!);
  }
  for (const match of stripped.matchAll(new RegExp(`\\b${field}\\s*!==?\\s*"([^"]+)"`, "g"))) {
    out.add(match[1]!);
  }
  return out;
}

/** 双向比对一组字段清单，失败信息点名缺失方向与具体值。 */
function assertMirrorAgrees(field: "kind" | "type"): void {
  const inProtocol = extractFieldLiterals(protocolSource, field);
  const inChild = extractFieldLiterals(childSource, field);
  const missingInChild = [...inProtocol].filter((value) => !inChild.has(value)).sort();
  const unknownToProtocol = [...inChild].filter((value) => !inProtocol.has(value)).sort();
  assert.deepEqual(
    missingInChild,
    [],
    `协议模块声明了、child-source.ts 镜像缺失的 ${field}（协议演进漏改镜像）: ` +
      `${missingInChild.join(", ") || "(无)"}`,
  );
  assert.deepEqual(
    unknownToProtocol,
    [],
    `child-source.ts 镜像里出现、协议模块未声明的 ${field}（镜像漂移）: ` +
      `${unknownToProtocol.join(", ") || "(无)"}`,
  );
}

test("镜像守卫：协议 ↔ 子进程内嵌源码的 kind 清单双向一致", () => {
  assertMirrorAgrees("kind");
});

test("镜像守卫：协议 ↔ 子进程内嵌源码的 type 清单双向一致（request 三型 + event 四型）", () => {
  assertMirrorAgrees("type");
});

test("运行期未知 kind：warn 事件进 journal（kind 值 + 累计计数），run 正常结算", async () => {
  const { settlement, captured } = await runWithFakeChild([
    '{"kind":"mystery-kind","payload":1}',
    '{"kind":"mystery-kind","payload":2}',
    '{"kind":"complete","ok":true,"value":{"seen":true}}',
  ]);
  // 未知 kind 不失败：complete 照常结算，顶层返回值原样到达。
  assert.equal(settlement.status, "completed", `run 应完成：${JSON.stringify(settlement)}`);
  assert.deepEqual(settlement.artifact, { seen: true });

  const warns = captured.events.filter(
    (event) => event.type === "log" && event.message.includes("unknown-child-message"),
  );
  assert.equal(warns.length, 2, `应有两个 warn 事件：${JSON.stringify(captured.events)}`);
  const [first, second] = warns;
  assert.ok(first !== undefined && second !== undefined);
  assert.match(first.message, /"field":"kind"/);
  assert.match(first.message, /"value":"mystery-kind"/);
  assert.match(first.message, /"count":1/);
  assert.match(second.message, /"count":2/);
});

test("运行期未知事件 type：warn 进 journal，同通道后续合法消息不受影响", async () => {
  const { settlement, captured } = await runWithFakeChild([
    '{"kind":"event","type":"mystery-event","x":1}',
    '{"kind":"event","type":"log","message":"still-alive"}',
    '{"kind":"complete","ok":true,"value":7}',
  ]);
  assert.equal(settlement.status, "completed");
  assert.deepEqual(settlement.artifact, 7);
  const warns = captured.events.filter(
    (event) => event.type === "log" && event.message.includes('"field":"event.type"'),
  );
  assert.equal(warns.length, 1);
  assert.ok(
    warns[0] !== undefined && warns[0].message.includes('"value":"mystery-event"'),
    `warn 应点名 type 值：${warns[0]?.message}`,
  );
  // 同通道后续合法 log 照常分派（未知 type 不会吞掉通道）。
  assert.ok(
    captured.events.some((event) => event.type === "log" && event.message === "still-alive"),
  );
});

test("运行期未知 request type：warn 进 journal 并回结构化拒绝，run 正常结算", async () => {
  const { settlement, captured } = await runWithFakeChild([
    '{"kind":"request","id":"r1","type":"mystery-request","siteId":"s1"}',
    '{"kind":"complete","ok":true,"value":"done"}',
  ]);
  assert.equal(settlement.status, "completed");
  const warns = captured.events.filter(
    (event) => event.type === "log" && event.message.includes('"field":"request.type"'),
  );
  assert.equal(warns.length, 1);
  assert.ok(warns[0] !== undefined && warns[0].message.includes('"value":"mystery-request"'));
});

test("分级：NDJSON 损坏仍走中断结算，不产生 unknown-child-message warn", async () => {
  const { settlement, captured } = await runWithFakeChild(['{"kind":"complete" oops']);
  assert.equal(settlement.status, "stopped");
  assert.ok(
    settlement.status === "stopped" && settlement.reason === "interrupted",
    `损坏应结算为 stopped(interrupted)：${JSON.stringify(settlement)}`,
  );
  assert.ok(
    !captured.events.some(
      (event) => event.type === "log" && event.message.includes("unknown-child-message"),
    ),
    "坏 NDJSON 是传输错误（中断），不应混入未知消息 warn",
  );
});
