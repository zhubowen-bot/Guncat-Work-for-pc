// CommandGuard: run_command 的危险判定（纯逻辑，不碰进程，可脱离真实执行做断言）
//
// 为什么需要它：模型写的命令是不可信输入，而「命令」这个工具面一旦被滥用的代价是删掉用户
// 磁盘上的东西 —— 不是回滚一次提交就能了事的。所以借鉴 dsh 的安全模型，把判定分成两档：
//   forbidden（硬禁）：毁灭性、不可逆、且没有任何理由交给智能体做的操作（格式化磁盘、关机、
//     fork 炸弹…）。这一档**不给审批入口**，直接拒绝并说明理由 ——
//     「用户手滑点了允许」本身就是一种必须防住的失败模式。
//   risky（需批准）：有破坏性但常常是正当需求（删文件、装包、git push、curl 下载…）。
//     默认档位下这类命令要走 AskUserBridge 人工批准，其余命令直接执行。
//
// 取向：**宁可多问一次，不可漏判一次**（漏判的代价是用户的数据）；
// 但硬禁表保持克制 —— 只放真正不可逆的系统级操作，否则「什么都禁」等于没有安全。

export class GuardVerdict {
  forbidden: boolean = false
  risky: boolean = false
  /** 命中的原因（给人看的短句，审批卡片里直接展示） */
  reasons: string[] = []
}

interface Rule {
  re: RegExp
  why: string
}

export class CommandGuard {
  // 审批粒度档位（会话元数据 commandPermission 的取值；空串按默认档处理）
  static readonly PERMISSION_ASK: string = 'ask'          // 每条命令都要批准
  static readonly PERMISSION_ASK_RISK: string = 'ask-risk' // 默认: 只有危险命令要批准
  static readonly PERMISSION_AUTO: string = 'auto'        // 全自动（硬禁表仍然生效）
  static readonly PERMISSIONS: string[] = [
    CommandGuard.PERMISSION_ASK, CommandGuard.PERMISSION_ASK_RISK, CommandGuard.PERMISSION_AUTO
  ]

  private static readonly FORBIDDEN: Rule[] = [
    { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
    { re: /\bmkfs(\.\w+)?\b/i, why: '格式化磁盘（mkfs）' },
    { re: /\bdiskpart\b/i, why: '磁盘分区操作' },
    { re: /\bdd\b[^\n|;]*\bof=\/dev\//i, why: 'dd 直接写裸设备' },
    { re: /physicaldrive/i, why: '直接写物理磁盘' },
    { re: /\b(?:shutdown|reboot|poweroff)\b/i, why: '关机/重启整台机器' },
    { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/i, why: 'fork 炸弹' },
    { re: /\brm\s+(?:-[^\s]*\s+)*\/(?:\*|\s|$)/i, why: '删除根目录' },
    { re: /\brm\s+(?:-[^\s]*\s+)*(?:~|\$HOME|%USERPROFILE%)(?:\s|\/|$)/i, why: '删除用户主目录' },
    { re: /\bchmod\s+(?:-[^\s]*\s+)*777\s+\//i, why: '把系统目录改成全局可写' },
    { re: /\breg\s+delete\s+"?\s*hklm/i, why: '删除机器级注册表项' },
    { re: /\bbcdedit\b/i, why: '修改系统引导配置' },
    { re: /\bcipher\s+\/w\b/i, why: '擦除磁盘空闲空间' }
  ]

  private static readonly RISKY: Rule[] = [
    { re: /\b(?:rm|del|erase|rd|rmdir\d?|deltree|shred|unlink)\b/i, why: '删除文件/目录' },
    { re: /\b(?:mv|move)\b\s+[-\w."']/i, why: '移动/改名文件' },
    { re: /Remove-Item|Clear-Content|Clear-RecycleBin/i, why: 'PowerShell 删除' },
    { re: /\b(?:git|svn)\b[^\n|;]*(?:clean|reset\s+--hard|checkout|restore|filter-branch|push|rebase|ci|commit)/i, why: '版本库改写或对外推送' },
    { re: /\b(?:setx|reg|schtasks|crontab|systemctl|service)\b/i, why: '改系统配置/计划任务/服务' },
    { re: /\bnet\s+(?:user|localgroup|share|start|stop|config)\b/i, why: '改账号/共享/网络配置' },
    { re: /\b(?:taskkill|killall|pkill)\b|Stop-Process|kill\s+-9/i, why: '杀进程' },
    { re: /\b(?:chmod|chown|icacls|takeown|cacls|runas|sudo|doas)\b/i, why: '改权限或以他人身份运行' },
    { re: /\b(?:npm|pnpm|yarn|bun|pip|pip3|gem|cargo)\b[^\n|;]*(?:-g|--global|install|uninstall|link)\b|\b(?:npx|choco|winget|brew)\b/i, why: '安装或运行外部包（会写到工作区之外）' },
    { re: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b/i, why: '从网络下载' },
    { re: /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\|\s*(?:powershell|pwsh|iex)\b|Invoke-Expression/i, why: '把网络内容直接管道给 shell 执行' },
    { re: /\b(?:docker|podman|kubectl)\b/i, why: '操作容器/集群' },
    { re: /\b(?:chkdsk|defrag)\b/i, why: '磁盘维护' },
    { re: /\brobocopy\b[^\n]*(?:\/MIR|\/PURGE)/i, why: '镜像同步（会删目标目录的差异文件）' },
    { re: /-(?:E|e)ncodedCommand|\b-enc\b|-W\s+hidden|-ExecutionPolicy\s+Bypass/i, why: '编码或隐藏的 PowerShell 命令（读不出真实意图）' },
    { re: /(?:^|[;&|]\s*)(?:set\b|env\b|printenv\b|Get-ChildItem\s+env:)/i, why: '导出全部环境变量' },
    { re: /(?:\.ssh\b|id_rsa|known_hosts|\.aws\b|credentials\.aws|\.npmrc|\.netrc|lsass|\.env\b)/i, why: '触及凭据/密钥文件' },
    { re: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i, why: '删除数据库内容' }
  ]

  /**
   * 工作区内的绝对路径不算「越界」，所以把根目录一起传进来比对。
   * Windows 分隔符与大小写都不敏感，先归一再前缀比较。
   */
  private static normalizePath(text: string): string {
    return text.replace(/\\/g, '/').toLowerCase()
  }

  // 命令里出现的绝对路径 token: 盘符路径, 或系统级 POSIX/Windows 目录开头的路径
  private static readonly ABS_PATH_RE: RegExp =
    /(?:[a-zA-Z]:[\\/]|[\\/](?:etc|usr|var|opt|bin|sbin|boot|sys|dev|home|root|tmp|mnt|media|Users|Program Files(?:\s?\(x86\))?|ProgramData|Windows)[\\/])/g

  /**
   * 判定一条命令。root 传当前工作区根目录（用于豁免「就在工作区里干活」的绝对路径），
   * 传空串表示不做豁免。
   */
  static assess(command: string, root: string = ''): GuardVerdict {
    let verdict: GuardVerdict = new GuardVerdict()
    let text: string = command.trim()
    if (text === '') {
      verdict.forbidden = true
      verdict.reasons.push('命令为空')
      return verdict
    }
    if (text.length > 4000) {
      verdict.forbidden = true
      verdict.reasons.push('命令过长（超过 4000 字符），无法逐字审阅')
      return verdict
    }
    for (let i: number = 0; i < CommandGuard.FORBIDDEN.length; i++) {
      if (CommandGuard.FORBIDDEN[i].re.test(text)) {
        verdict.forbidden = true
        CommandGuard.pushReason(verdict, CommandGuard.FORBIDDEN[i].why)
      }
    }
    if (verdict.forbidden) {
      return verdict
    }
    for (let j: number = 0; j < CommandGuard.RISKY.length; j++) {
      if (CommandGuard.RISKY[j].re.test(text)) {
        verdict.risky = true
        CommandGuard.pushReason(verdict, CommandGuard.RISKY[j].why)
      }
    }
    let outside: string = CommandGuard.firstPathOutsideWorkspace(text, root)
    if (outside !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '触及工作区之外的路径 ' + outside)
    }
    // 绝对路径那套正则看不见「相对上跳」：dir .. / echo x > ..\y.txt 同样是出圈，
    // 同一个越界效果不能因为写法不同就一路绿灯（实测缺口，见 firstUpTraversal 的说明）。
    let up: string = CommandGuard.firstUpTraversal(text)
    if (up !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '命令里有 .. 上跳，读写位置在工作区之外：' + up)
    }
    return verdict
  }

  /** 命中危险特征就需要批准；'auto' 档一律放行，'ask' 档一律要批准 */
  static needsApproval(verdict: GuardVerdict, permission: string): boolean {
    if (permission === CommandGuard.PERMISSION_AUTO) {
      return false
    }
    if (permission === CommandGuard.PERMISSION_ASK) {
      return true
    }
    return verdict.risky
  }

  /** 会话档位取值（旧数据/未设置都是空串 → 默认档「危险需批准」） */
  static normalizePermission(permission: string): string {
    return CommandGuard.PERMISSIONS.indexOf(permission) !== -1 ? permission :
      CommandGuard.PERMISSION_ASK_RISK
  }

  static forbiddenReason(verdict: GuardVerdict): string {
    return verdict.forbidden ? verdict.reasons.join('、') : ''
  }

  private static pushReason(verdict: GuardVerdict, why: string): void {
    if (verdict.reasons.indexOf(why) === -1) {
      verdict.reasons.push(why)
    }
  }

  // 找出命令里第一个「不在工作区内」的绝对路径；没有则返回空串
  private static firstPathOutsideWorkspace(text: string, root: string): string {
    // 归一后的根目录不带尾斜杠: 比较时按「等于根目录」或「根目录/ 开头」两种情况算在内
    let normRoot: string = root === '' ? '' :
      CommandGuard.normalizePath(root).replace(/\/+$/, '')
    let re: RegExp = new RegExp(CommandGuard.ABS_PATH_RE.source, 'gi')
    let tokenRe: RegExp = /[^\s"'`;|&)<>]+/g
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      // 从命中的起点开始吃一整段路径 token
      let start: number = match.index
      tokenRe.lastIndex = start
      let tokenMatch: RegExpExecArray | null = tokenRe.exec(text)
      let token: string = tokenMatch !== null ? tokenMatch[0] : match[0]
      if (normRoot === '') {
        return token
      }
      let normToken: string = CommandGuard.normalizePath(token).replace(/\/+$/, '')
      if (normToken === normRoot || normToken.startsWith(normRoot + '/')) {
        match = re.exec(text)
        continue
      }
      return token
    }
    return ''
  }

  // 一个命令行 token：空白与引号、重定向、管道、括号都做分隔（引号会把 token 切开，
  // 正好是我们想要的 —— "..\x" 里的 .. 一样得上跳）
  private static readonly TOKEN_RE: RegExp = /[^\s"'`;|&)<>]+/g

  // 「..」要真的是一段路径的开头才算上跳：前面是 token 开头或 \ / = 之一，后面是结尾或分隔符。
  // 这样 HEAD~1..HEAD、1..5、v1..v2 一类区间写法不会被冤枉，而 --prefix=../outside
  // 这种把越界挂在参数上的写法也跑不掉。
  private static readonly UP_SEGMENT_RE: RegExp = /(?:^|[\\/=])\.\.(?=$|[\\/])/

  /**
   * 找出命令里第一个含「.. 上跳段」的 token；没有则返回空串。
   *
   * 为什么单独立一条：工作区是命令唯一的活动范围，但 shell 里的相对路径不受任何约束 ——
   * `dir ..`、`echo x > ..\y.txt` 直接读写了工作区的父目录，而绝对路径正则（ABS_PATH_RE）
   * 只认「带盘符或系统目录开头」的写法，对这类上跳完全无感。实测过一次静默越界：
   * 同一条 `dir .. /b` 无审批直接列出了父目录，而 `type C:\Windows\win.ini` 却被拦下问人。
   */
  private static firstUpTraversal(text: string): string {
    let re: RegExp = new RegExp(CommandGuard.TOKEN_RE.source, 'g')
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      if (CommandGuard.UP_SEGMENT_RE.test(match[0])) {
        return match[0]
      }
      match = re.exec(text)
    }
    return ''
  }
}
