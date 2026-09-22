/**
 * 子进程 spawn 环境白名单（沙箱边界的第二半，spec：docs/specs/dynamic-workflow/sandbox-boundary.md）。
 *
 * 为什么是白名单而不是 `{...process.env}`（2026-09-22 修复）：workflow 子进程过去全量继承宿主
 * CLI 的环境，CLI 从 `.env` 装载的模型 API key、外部服务凭据会原样出现在子进程可枚举环境里；
 * 而沙箱脚本只需拿到一次 `process` 即可整包读走并外传（沙箱 realm 侧的逃逸修复见
 * child-source.ts 顶部）。环境白名单把「这个子进程能看到什么」变成一份可以逐项回答的清单：
 * 白名单之外的变量在子进程里**不存在**，而不是"存在但指望脚本自觉不读"。
 *
 * 取舍（spec 的默认决定）：清单按「当前 spawn 实际依赖项」取最小集。缺一项的代价是子进程在
 * 特定平台/打包形态下启动异常，所以每一项都注明缺席的具体死法；新增业务变量一律**不**进
 * 白名单，也不设审批机制（spec 待确认问题 1 的默认）——外部服务的凭据由调用方自己的安全装载
 * 机制解决（如 env 文件回退）。deny-by-default 意味着 NODE_OPTIONS 这类旗标注入向量天然被
 * 排除，无需逐个点名。
 */

/** 子进程允许继承的环境变量名。集中常量，逐项注释必要性；改动需同步 spec 的验收场景。 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  // —— 跨平台/打包形态的启动保命项 ——

  // 桌面打包态：Desktop 的 agent 由 Electron Helper 运行（process.execPath 指向 Helper），而
  // CLI 启动时会把 ELECTRON_RUN_AS_NODE 从自身 env sanitize 掉——所以这一项**不能照抄父进程**，
  // buildChildEnv 里恒置 "1"。缺了它子进程按完整 Electron/Chromium 应用启动并卡在 GPU 初始化，
  // 永不报错也不退出，run 卡死在 run-started。纯 Node 的 execPath 下该变量无效、无副作用。
  "ELECTRON_RUN_AS_NODE",

  // 进程查找惯例项。当前子进程自身不再 spawn 工具，但保留它使 Node/平台内部的少数解析路径
  // （诊断、未来 re-exec）不至于因 PATH 缺席而行为漂移。只泄露目录列表，不是凭据面。
  "PATH",

  // —— home 与临时目录（os.homedir / os.tmpdir 的环境来源；POSIX 与 Windows 各自的键）——

  // POSIX home。Windows 上缺席无害（键不存在即不复制）。
  "HOME",
  // Windows home（os.homedir() 在 win32 的来源）；同时是 Windows 上 os.tmpdir() 的回退。
  "USERPROFILE",
  // POSIX 临时目录（os.tmpdir()）。
  "TMPDIR",
  // Windows 临时目录（os.tmpdir() 在 win32 读 TEMP，回退 TMP）。
  "TEMP",
  "TMP",

  // Windows：Node/Win32 初始化（加密、网络栈）依赖 SystemRoot；缺席会以极难诊断的方式启动
  // 失败。POSIX 上缺席无害。
  "SYSTEMROOT",

  // —— 本地化 ——

  // locale 提示：让子进程的报错/格式化与宿主一致。刻意不带 TZ——workflow 禁时钟
  // （Date.now / argless new Date()），时区不进沙箱反而消掉一个非确定性源。
  "LANG",
] as const;

/**
 * 从 `env`（缺省 `process.env`）拼装子进程环境：只取白名单内的项，再恒置
 * `ELECTRON_RUN_AS_NODE=1`。`env` 参数可注入——测试用它断言白名单行为，不必改测试进程的
 * 真实环境。
 */
export function buildChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined) childEnv[name] = value;
  }
  // 恒置而不是照抄：CLI 启动时已把 ELECTRON_RUN_AS_NODE 从自身 env sanitize 掉（见上），
  // 照抄永远拿不到值；父进程即便带着非 "1" 的值也要覆盖——子进程必须是纯 Node 语义。
  childEnv.ELECTRON_RUN_AS_NODE = "1";
  return childEnv;
}
