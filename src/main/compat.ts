// 兼容模式的参数拼装。
//
// 抽成纯函数是为了能被无头验证覆盖：这段逻辑一旦拼错，自动降级会静默失效 ——
// 用户看到的仍然是白屏，而且没有任何报错指向参数问题。
//
// 背景（用户机器上实测）：只有带下面这组参数时渲染进程才起得来。
// 不带时主进程一路正常，渲染进程发出 did-start-loading 后即无下文，
// 约 10 秒后主进程触发致命 CHECK 终止。

export const SAFE_MODE_FLAG = '--guncat-safe-mode'
export const FRESH_PROFILE_FLAG = '--guncat-fresh-profile'

/** 实测唯一能起来的组合 */
export const COMPAT_SWITCHES: string[] = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-software-rasterizer'
]

/** 兼容模式下要加到命令行上的全部内容 */
export const COMPAT_ARGS: string[] = COMPAT_SWITCHES.concat([
  SAFE_MODE_FLAG,
  FRESH_PROFILE_FLAG
])

/**
 * 组装自动降级时的重启参数。
 * 必须保留原有参数（开发态 argv[1] 是应用目录，丢了就启动不到应用），
 * 同时去掉重复项，避免参数越叠越长。
 */
export function buildCompatArgs(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter((a: string) => !COMPAT_ARGS.includes(a))
    .concat(COMPAT_ARGS)
}

/** 命令行是否显式要求兼容模式 */
export function isSafeModeRequested(argv: string[]): boolean {
  return argv.includes(SAFE_MODE_FLAG)
}
