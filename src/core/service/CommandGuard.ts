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
//
// 三层独立规则，缺一不可（AI 实测出 7 类绕过之后整理出来的结构）：
//   关键词表（FORBIDDEN/RISKY）—— 但要**先看原文，再看还原转义后的文本**：
//     cmd 的 ^、拆词的引号、POSIX 的反斜杠在执行时都会消失，只看原文等于让 shut^down 绕过硬禁表。
//   意图读不出（OPAQUE）—— 解释器内联代码、Base64 载荷、命令替换、系统自带下载器。
//     这类命令文本里天生就没有危险词，靠关键词永远追不上，所以按「决定权交给了谁」一刀切。
//   位置越界（绝对路径 / .. 上跳）—— 写法无关，实测连 ^ 变体也拦得住，是这三层里最硬的一层。

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
    { re: /Remove-Item|Clear-Content|Clear-RecycleBin|Remove-ItemProperty|Remove-PSItem/i, why: 'PowerShell 删除' },
    // 覆盖写（不是新建）会让原内容不可恢复，与 del/mv 同一档；New-Item 这种「凭空建一个」不算。
    { re: /\b(?:Set-Content|Out-File|Add-Content)\b/i, why: 'PowerShell 覆盖写文件' },
    // Remove-Item 的官方别名是 ri/rmi，只收 rm/del/erase/rd 会漏掉它们（实测：ri -Recurse -Force 静默删整棵树）
    { re: /\b(?:powershell|pwsh)\b[^\n]*?\b(?:ri|rmi|rm|del|erase|rd|rmdir|ac|sc|si)\b/i, why: 'PowerShell 删除/改写别名' },
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
    { re: /-W\s+hidden|-ExecutionPolicy\s+Bypass/i, why: '隐藏窗口执行（刻意不给用户看见）' },
    { re: /(?:^|[;&|]\s*)(?:set\b|env\b|printenv\b|Get-ChildItem\s+env:)/i, why: '导出全部环境变量' },
    { re: /(?:\.ssh\b|id_rsa|known_hosts|\.aws\b|credentials\.aws|\.npmrc|\.netrc|lsass|\.env\b)/i, why: '触及凭据/密钥文件' },
    { re: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i, why: '删除数据库内容' }
  ]

  // 「文本里没有危险词」不等于「执行时无害」。这一档不看关键词，只看**这条命令把决定权交给了谁**：
  // 解释器的内层代码、Base64 载荷、命令替换、系统自带下载器 —— 真实意图不在文本里，
  // 上面的关键词表对它们必然失配（实测：powershell -enc、node -e、python -c、run.bat 全部免审批直通）。
  // 所以像工作区越界那样单独立一条独立规则层：判定读不出这条命令到底做什么，就按危险处理。
  private static readonly OPAQUE: Rule[] = [
    { re: /(?:^|[\s;&|(])(?:cmd|command)(?:\.exe|\.com)?\s*\/[ck]/i, why: '让 cmd 再解释一层命令（内层可以用 ^ 拆词）' },
    { re: /(?:^|[\s;&|(])(?:powershell|pwsh)(?:\.exe)?\s/i, why: '交给 PowerShell 解释执行（别名与内联代码读不出真实意图）' },
    { re: /\b(?:sh|bash|zsh|dash|ksh)(?:\.exe)?\b[^\n|;&]*?\s-\w*c\b/i, why: '交给 shell 内联执行一段代码' },
    { re: /\b(?:node|iojs|deno|bun)(?:\.exe)?\b[^\n|;&]*?\s-(?:e|p)\b|\b(?:node|iojs|deno|bun)(?:\.exe)?\b[^\n|;&]*?\s--(?:eval|print)\b/i, why: '交给 JS 运行时内联执行代码' },
    { re: /\b(?:python|python\d|pypy|py)(?:\.exe)?\b[^\n|;&]*?\s-(?:c|m)\b/i, why: '交给 Python 内联执行代码' },
    { re: /\b(?:perl|ruby|php|lua|tclsh|awk|gawk)(?:\.exe)?\b[^\n|;&]*?\s-\w*[er]\b|\bawk\b[^\n|;]*system\s*\(/i, why: '交给脚本语言内联执行代码' },
    { re: /\bsed\b\s+(?:--?\w+\s+)*-\w*i\b|\bsed\b\s+--in-place/i, why: 'sed 原地改写文件' },
    { re: /\bjava(?:w)?\s+(?:-\w+\s+)*-jar\b/i, why: '执行 jar 包（二进制内容审阅不了）' },
    // TS 不进脚本同审的后缀表（源码里满是小写 fetch/注释里的 rmSync，一读就误报），
    // 所以直接把「跑 TS 的入口」一刀切：这些命令做的就是把一段我们没读过的代码交给解释器。
    { re: /\bdeno\s+run|(?:^|[\s;&|])(?:ts-node|tsx)\s/i, why: '直接执行 TypeScript 脚本（内容不在命令里）' },
    { re: /-{1,2}enc\w*\b|frombase64string|tobase64string|\bbase64\s+(?:-d|--decode)\b|\becho\s+[a-z0-9+/=]{24,}\s*\|/i, why: 'Base64 或编码载荷（解码后才知道要执行什么）' },
    { re: /\b(?:certutil|bitsadmin|mshta|rundll32|regsvr32|msiexec|wmic)\b/i, why: '系统组件下载/执行（常被用来绕过安全策略）' },
    { re: /\biex\b|\bstart-process\b|\bnew-object\b[^\n|;]*shell/i, why: 'PowerShell 执行原语' },
    { re: /\$\(|`[^`\n]+`/, why: '命令替换（$(…) 或反引号）：文本里看到的不是最终执行的那一段' },
    { re: /%\w+:[~^=]|\$\{[A-Za-z_][A-Za-z0-9_]*[:@!\\/]/, why: '变量切片展开（用字符串拼出命令名）' }
  ]

  // 脚本文件里做的是「编程」而不是「敲命令」，删除与外发走的是语言 API，上面那些 shell 关键词看不见。
  // 只盯「shell 那一层同样要批准」的动作：删文件、改名、联网、上跳/越界（越界由路径规则管）。
  // 写文件不进这张表 —— write_file 工具本来就不需要批准，脚本里 fs.writeFileSync 不该更严；
  // 起子进程也不进（构建脚本天天 spawn 工具链），它内层的命令行仍然被上面两张表扫过。
  private static readonly CODE: Rule[] = [
    { re: /\b(?:rmSync|unlinkSync|rmdirSync|truncateSync)\s*\(|\brimraf\b/i, why: 'JS 删除文件' },
    { re: /\bshutil\.(?:rmtree|move)\s*\(|os\.(?:remove|unlink|rename|kill)\s*\(/i, why: 'Python 删除/移动文件' },
    { re: /\b(?:File|Files)\.(?:delete|Delete)\s*\(|\bremoveDirectory\b/i, why: '删除目录或文件' },
    { re: /\b(?:net\.Socket|createConnection|URLSession)\b|XmlHttpRequest|\bfetch\s*\(\s*['"]https?:/i, why: '脚本自己联网外发' }
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
    return CommandGuard.scan(command, root, false)
  }

  /**
   * 判定一段**脚本源码**（命令引用的 .ps1/.bat/.js/.py 之类的内容）。
   * 与 assess 同一套尺子，额外再过一遍语言 API —— 脚本里的 `fs.rmSync` 不像 shell 的 `rm`，
   * 但删起文件来一模一样。
   */
  static assessScript(text: string, root: string = ''): GuardVerdict {
    return CommandGuard.scan(text, root, true)
  }

  private static scan(text: string, root: string, script: boolean): GuardVerdict {
    let verdict: GuardVerdict = new GuardVerdict()
    let trimmed: string = text.trim()
    if (trimmed === '') {
      verdict.forbidden = true
      verdict.reasons.push('命令为空')
      return verdict
    }
    if (trimmed.length > 4000) {
      verdict.forbidden = true
      verdict.reasons.push('命令过长（超过 4000 字符），无法逐字审阅')
      return verdict
    }
    // 原文与「还原转义后的文本」都过一遍：cmd 的 ^、拆词的引号、POSIX 的反斜杠在执行时会消失，
    // 只看原文就等于让 shut^down、de^l、form^at 用一个字符绕过硬禁表（实测缺口，见 unobfuscate）。
    let norm: string = CommandGuard.unobfuscate(trimmed)
    let forbidden: string[] = CommandGuard.matched(trimmed, CommandGuard.FORBIDDEN)
    let risky: string[] = CommandGuard.matched(trimmed, CommandGuard.RISKY)
      .concat(CommandGuard.matched(trimmed, CommandGuard.OPAQUE))
    // 语言 API 只作危险项：脚本里写文件是常态，硬禁表留给真正不可逆的系统级操作
    if (script) {
      risky = risky.concat(CommandGuard.matched(trimmed, CommandGuard.CODE))
    }
    // 还原后的文本只可能**追加**命中（unobfuscate 只会去字符），所以危险档位按追加后的结果定：
    // 形如 shut^down 的写法必须照样落进硬禁表，不能降级成「问一句就跑」。
    let freshForbidden: string[] = norm === trimmed ? [] :
      CommandGuard.onlyMissing(CommandGuard.matched(norm, CommandGuard.FORBIDDEN), forbidden)
    let freshRisky: string[] = norm === trimmed ? [] : CommandGuard.onlyMissing(
      CommandGuard.matched(norm, CommandGuard.RISKY)
        .concat(script ? CommandGuard.matched(norm, CommandGuard.CODE) : []), risky)
    if (freshForbidden.length > 0 || freshRisky.length > 0) {
      forbidden = forbidden.concat(freshForbidden)
      risky = risky.concat(freshRisky)
    }
    let obfuscated: boolean = freshForbidden.length > 0 || freshRisky.length > 0
    for (let i: number = 0; i < forbidden.length; i++) {
      verdict.forbidden = true
      CommandGuard.pushReason(verdict, forbidden[i])
    }
    if (verdict.forbidden) {
      if (obfuscated) {
        CommandGuard.pushReason(verdict, CommandGuard.OBFUSCATED_WHY)
      }
      return verdict
    }
    for (let j: number = 0; j < risky.length; j++) {
      verdict.risky = true
      CommandGuard.pushReason(verdict, risky[j])
    }
    if (obfuscated) {
      verdict.risky = true
      CommandGuard.pushReason(verdict, CommandGuard.OBFUSCATED_WHY)
    }
    let outside: string = CommandGuard.firstPathOutsideWorkspace(trimmed, root)
    if (outside !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '触及工作区之外的路径 ' + outside)
    }
    // 绝对路径那套正则看不见「相对上跳」：dir .. / echo x > ..\y.txt 同样是出圈，
    // 同一个越界效果不能因为写法不同就一路绿灯（实测缺口，见 firstUpTraversal 的说明）。
    let up: string = CommandGuard.firstUpTraversal(trimmed)
    if (up !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '命令里有 .. 上跳，读写位置在工作区之外：' + up)
    }
    return verdict
  }

  private static readonly OBFUSCATED_WHY: string =
    '命令被转义/拆词混淆过，还原后才看得出危险'

  // 还原 shell 的转义与拆词写法。只做「把字符去掉」，不做展开，所以结果只会**多出**命中，
  // 不会让原本判危险的命令变干净 —— 判定用的始终是「原文 ∪ 还原文」。
  private static unobfuscate(text: string): string {
    let out: string = text
    out = out.replace(/\^\^/g, ' ')          // cmd: ^^ 是字面意义的 ^，先隔离开
    out = out.replace(/\^([^\s])/g, '$1')    // cmd: ^x 执行时就是 x（shell:true 走的就是 cmd）
    out = out.replace(/\\([A-Za-z_])/g, '$1') // POSIX: \x 执行时就是 x
    out = out.replace(/["']/g, '')           // 拆词: d"e"l 执行时就是 del
    return out
  }

  private static matched(text: string, rules: Rule[]): string[] {
    let hits: string[] = []
    for (let i: number = 0; i < rules.length; i++) {
      if (rules[i].re.test(text) && hits.indexOf(rules[i].why) === -1) {
        hits.push(rules[i].why)
      }
    }
    return hits
  }

  private static onlyMissing(candidates: string[], known: string[]): string[] {
    let fresh: string[] = []
    for (let i: number = 0; i < candidates.length; i++) {
      if (known.indexOf(candidates[i]) === -1 && fresh.indexOf(candidates[i]) === -1) {
        fresh.push(candidates[i])
      }
    }
    return fresh
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

  // 命令里可能被「执行」的脚本后缀。只收到能被 shell/解释器直接跑起来的那些：
  // .json/.md/.txt 这类数据文件不算，否则读任何配置文件都要打扰用户。
  private static readonly SCRIPT_EXT_RE: RegExp =
    /\.(?:ps1|psm1|bat|cmd|sh|bash|zsh|vbs|js|mjs|cjs|py|pyw|rb|pl|lua|ahk|wsf)$/i

  /**
   * 取出命令里引用到的脚本文件（带引号的整段路径也算一个）。
   * 判定只看命令文本，而 `run.bat` / `node cleanup.js` 的危险全在文件里 —— 这里把文件名交出去，
   * 由 CommandService 读进内容过同一套判定（见 assessScript）。
   */
  static scriptRefs(command: string): string[] {
    let parts: string[] = []
    // 带引号的整段先取出来（"My Scripts\clean up.ps1" 是一个文件，不是两个 token），
    // 再把这段引号从文本里挖掉，剩下的才按空白切 token —— 否则引号内的半个路径会被当成第二个脚本。
    let rest: string = ''
    let cursor: number = 0
    let quotedRe: RegExp = /"([^"\n]+)"/g
    let match: RegExpExecArray | null = quotedRe.exec(command)
    while (match !== null) {
      parts.push(match[1])
      rest += command.substring(cursor, match.index) + ' '
      cursor = match.index + match[0].length
      match = quotedRe.exec(command)
    }
    rest += command.substring(cursor)
    let bareRe: RegExp = /[^\s"'`;|&<>()]+/g
    match = bareRe.exec(rest)
    while (match !== null) {
      parts.push(match[0])
      match = bareRe.exec(rest)
    }
    let refs: string[] = []
    for (let i: number = 0; i < parts.length && refs.length < 8; i++) {
      let part: string = parts[i].trim().replace(/^['"]+|['"]+$/g, '')
      if (part.length > 0 && part.length <= 260 && CommandGuard.SCRIPT_EXT_RE.test(part) &&
        refs.indexOf(part) === -1) {
        refs.push(part)
      }
    }
    return refs
  }
}
