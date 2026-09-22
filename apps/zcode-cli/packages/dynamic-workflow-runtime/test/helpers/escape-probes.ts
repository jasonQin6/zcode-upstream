/**
 * 逃逸探针（spec docs/specs/dynamic-workflow/sandbox-boundary.md：逃逸面固化常驻回归）。
 *
 * 每个探针是一段 **lowered 函数体**（`RunWorkflowOptions.lowered`：`(async (__host) => { … })`
 * 的身体），经共享夹具喂进真实子进程。探针在沙箱内尽力尝试已知逃逸面，把"拿到了什么"作为
 * JSON-able 结果返回；断言由测试对返回值做——探针自己不 assert（沙箱里也没有 assert）。
 *
 * 覆盖面（spec Implementation Decisions 列举的四个）：
 *   1. `__send.constructor` —— 修复前的逃逸起点，如今 `__send` 不应存在；
 *   2. `Function.constructor` —— Function 构造器逃逸的通式探查；
 *   3. globalThis 枚举 —— 以 realm 身份（instanceof / constructor 恒等）断言没有宿主函数值；
 *   4. process 探测 —— typeof / require / 动态 import / 可达字符串扫描（凭据 canary）。
 *
 * 探针只允许引用 `__host` 与语言内建（lowered 契约），对一切缺席标识符用 typeof 守卫。
 */

/** constructor 扫描探针的返回形状（run 顶层返回值，测试直接读 settlement.artifact）。 */
export interface ConstructorSweepFindings {
  /** `__send` 是否存在（应为 false——修复后沙箱里根本没有这个全局）。 */
  sendPresent: boolean;
  /** 若 `__send` 存在，`__send.constructor("return process")()` 的结局；否则 "absent"。 */
  sendEscape: string;
  /** globalThis 及其一级成员里，realm 判定失败的函数值名字（应为空）。 */
  crossRealmFunctions: string[];
  /** 经 constructor 两跳拿到 process 的全局名与泄露类型（应为空）。 */
  constructorEscapes: Array<{ name: string; leakedType: string }>;
}

/**
 * constructor 逃逸通探：枚举 globalThis 全部属性，函数值做 realm 判定，对象值做
 * `x.constructor.constructor("return process")()` 两跳尝试，并对每个对象的一级成员复扫。
 */
export const CONSTRUCTOR_SWEEP_PROBE = String.raw`
var findings = {
  sendPresent: false,
  sendEscape: "absent",
  crossRealmFunctions: [],
  constructorEscapes: [],
};
if (typeof __send !== "undefined") {
  // 修复前的逃逸原样复现：外层 realm 函数的 .constructor 即外层 Function。
  findings.sendPresent = true;
  try {
    var leakedViaSend = __send.constructor("return process")();
    findings.sendEscape = leakedViaSend === undefined ? "blocked" : "reached-process:" + typeof leakedViaSend;
  } catch (e) {
    findings.sendEscape = "threw: " + String((e && e.message) || e);
  }
}
var names = Object.getOwnPropertyNames(globalThis);
var visited = [];
for (var i = 0; i < names.length; i++) {
  var name = names[i];
  var value;
  try { value = globalThis[name]; } catch (eAccess) { continue; }
  var kind = typeof value;
  if (kind === "function") {
    // realm 判定只用 instanceof：宿主 realm 函数的原型链不含本 realm 的 Function.prototype。
    // 不能叠加 ".constructor === Function"——async/generator 家族的 constructor 是各自的
    // intrinsic（如 AsyncFunction），会把 context 原生的 __execute 误报成跨 realm。
    var sameRealm = value instanceof Function;
    if (!sameRealm) findings.crossRealmFunctions.push(name);
  } else if (kind === "object" && value !== null) {
    trySweepObject(name, value);
  }
}
function trySweepObject(name, obj) {
  // 环守卫：globalThis.globalThis 这类自引用会让无记忆的递归爆栈；见过的对象直接跳过。
  for (var k = 0; k < visited.length; k++) {
    if (visited[k] === obj) return;
  }
  visited.push(obj);
  if (visited.length > 128) return;
  // 两跳逃逸尝试：constructor → Function → 宿主 realm 求值。
  try {
    var C = obj.constructor;
    if (typeof C === "function") {
      var leaked = C.constructor("return process")();
      if (leaked !== undefined) {
        findings.constructorEscapes.push({ name: name, leakedType: typeof leaked });
      }
    }
  } catch (eEscape) {
    // 取不到 constructor 或求值被拒：都是"不可达"，正是期望。
  }
  // 一级成员复扫（如 __host 上的 shims、__outbox 的元素）。
  var own = [];
  try { own = Object.getOwnPropertyNames(obj); } catch (eOwn) { own = []; }
  for (var j = 0; j < own.length; j++) {
    var member;
    try { member = obj[own[j]]; } catch (eMember) { continue; }
    var mKind = typeof member;
    if (mKind === "function") {
      // 同上：instanceof 单判，不查 .constructor（async 成员同规）。
      var mSameRealm = member instanceof Function;
      if (!mSameRealm) findings.crossRealmFunctions.push(name + "." + own[j]);
    } else if (mKind === "object" && member !== null) {
      trySweepObject(name + "." + own[j], member);
    }
  }
}
return findings;
`;

/** process/凭据探针的返回形状。 */
export interface ProcessProbeFindings {
  processType: string;
  globalProcessType: string;
  requireType: string;
  /** 动态 import 的结局：沙箱无 importModuleDynamically 回调时应为 "refused: …"。 */
  importOutcome: string;
  /** 沙箱内可达字符串的全量汇集（截断），测试在其中找凭据 canary。 */
  reachableText: string;
}

/**
 * process 与凭据探针：typeof 探测、require/动态 import 尝试，再把 globalThis 可达对象图
 * （二跳、有界）里的一切字符串汇集起来——若任何路径带进了宿主环境，预埋 canary 会落在这里。
 */
export const PROCESS_ENV_PROBE = String.raw`
var findings = {
  processType: typeof process,
  globalProcessType: typeof globalThis.process,
  requireType: typeof require,
  importOutcome: "",
  reachableText: "",
};
try {
  var mod = await import("node:process");
  findings.importOutcome = "imported";
  findings.reachableText += "\n" + JSON.stringify(mod).slice(0, 4096);
} catch (e) {
  findings.importOutcome = "refused: " + String((e && e.message) || e);
}
var stack = [globalThis];
var visits = 0;
while (stack.length > 0 && visits < 64 && findings.reachableText.length < 65536) {
  var obj = stack.pop();
  visits = visits + 1;
  var own = [];
  try { own = Object.getOwnPropertyNames(obj); } catch (eOwn) { own = []; }
  for (var i = 0; i < own.length; i++) {
    var v;
    try { v = obj[own[i]]; } catch (eAccess) { continue; }
    var kind = typeof v;
    if (kind === "string") {
      findings.reachableText += "\n" + v.slice(0, 256);
    } else if (kind === "object" && v !== null) {
      stack.push(v);
    }
  }
}
return findings;
`;
