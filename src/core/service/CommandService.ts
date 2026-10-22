// CommandService: run_command / job_* 工具 —— 让智能体在本机跑命令，并把安全边界守住。
//
// 为什么不是「一个终端」：用户定的形态是「Agent 工具优先」—— 先给模型一条能跑命令的路,
// 用纯 child_process, 不引入 node-pty/xterm 这类原生依赖, 也不动打包链路;
// 界面可见的交互式终端标签页是下一阶段的事。
//
// 安全边界(全部集中在这一层, 平台层只管拉进程):
//   1. 工作目录锚定会话工作区, cwd 只接受工作区内的相对路径(越界拒绝);
//   2. 环境变量按白名单净化(主进程环境里的 API Key/令牌不会透传给子进程);
//   3. CommandGuard 硬禁表命中的命令**直接拒绝**, 不给审批入口;
//   4. 危险命令按会话档位走 AskUserBridge 人工批准, 超时/跳过/没点选项一律按**拒绝**处理
//      (fail-closed: 没人应答就等于不许);
//   5. 超时或被停止会杀掉整棵进程树, 不留孤儿进程;
//   6. 输出有缓冲上限 + 头尾截断, 超长全文落 .spill/ ——「截断不丢失」。
import { fileIo } from '@kit.CoreFileKit';
import { Constants } from '../common/Constants';
import { AbortSignal } from '../common/Types';
import { CommandGuard, GuardVerdict } from './CommandGuard';
import { AskUserBridge, AskAnswer } from './AskUserBridge';
import { SpillStore } from './SpillStore';
import { ToolExecResult, WorkFileService } from './WorkFileService';
import { ShellTask, ShellOutcome, buildCleanEnv } from '../platform/shellExec';

export const RUN_COMMAND_TOOL_NAME: string = 'run_command';
export const JOB_LIST_TOOL_NAME: string = 'job_list';
export const JOB_OUTPUT_TOOL_NAME: string = 'job_output';
export const JOB_KILL_TOOL_NAME: string = 'job_kill';

// 审批选项(文案即协议: 下面按这几个字判定用户意图, 改动要两边一起改)
const APPROVE_ONCE: string = '允许一次';
const APPROVE_ALL: string = '本次任务全部允许';
const APPROVE_DENY: string = '拒绝';

// 一次审批的落定结果
class Approval {
  allowed: boolean = false;
  grantAll: boolean = false;
  /** 拒绝原因(给人读的短句) */
  why: string = '';
  /** 用户在审批卡上补充的话(可空, 要让它看见) */
  note: string = '';
}

// 一个后台任务
class CommandJob {
  id: string = '';
  convId: string = '';
  command: string = '';
  cwd: string = '';
  task: ShellTask | null = null;
  /** job_output 的「读后即弃」游标: 每次返回游标之后的新增输出并推进 */
  cursor: number = 0;
  finished: boolean = false;
  exitCode: number = -1;
  killed: boolean = false;
  startedAt: number = 0;
}

export class CommandService {
  // 会话级审批档位(与 WorkFileService.customRoots 同构: core 侧注册表, 主进程按会话元数据回填)
  private static permissions: Record<string, string> = {};
  // 「本次任务全部允许」的会话内授权(用户重新发起任务时清空, 不跨任务残留)
  private static grants: Record<string, boolean> = {};
  private static jobs: CommandJob[] = [];
  private static jobSeq: number = 0;

  static setPermission(convId: string, permission: string): void {
    if (permission === '') {
      delete CommandService.permissions[convId];
      return;
    }
    CommandService.permissions[convId] = CommandGuard.normalizePermission(permission);
  }

  static permissionFor(convId: string): string {
    let v: string | undefined = CommandService.permissions[convId];
    return CommandGuard.normalizePermission(v === undefined ? '' : v);
  }

  /** 新一轮任务开始: 收回「本次任务全部允许」—— 它的字面范围就是"本次任务" */
  static clearGrant(convId: string): void {
    delete CommandService.grants[convId];
  }

  /** 会话被删除: 杀掉它的后台任务, 清掉档位与授权 */
  static releaseConversation(convId: string): void {
    let keep: CommandJob[] = [];
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      let job: CommandJob = CommandService.jobs[i];
      if (job.convId === convId) {
        if (!job.finished && job.task !== null) {
          job.task.kill();
        }
        continue;
      }
      keep.push(job);
    }
    CommandService.jobs = keep;
    delete CommandService.permissions[convId];
    delete CommandService.grants[convId];
  }

  /** 应用退出: 后台任务一起带走(否则退出后留下一堆由本应用拉起的进程) */
  static killAllJobs(): void {
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      let job: CommandJob = CommandService.jobs[i];
      if (!job.finished && job.task !== null) {
        job.task.kill();
      }
    }
    CommandService.jobs = [];
  }

  static isCommandTool(name: string): boolean {
    return name === RUN_COMMAND_TOOL_NAME || name === JOB_LIST_TOOL_NAME ||
      name === JOB_OUTPUT_TOOL_NAME || name === JOB_KILL_TOOL_NAME;
  }

  // ===== run_command =====

  static async run(convId: string, root: string, args: Record<string, Object>,
    abortSignal: AbortSignal | null): Promise<ToolExecResult> {
    let command: string = CommandService.strArg(args, 'command', '');
    if (command.trim() === '') {
      return CommandService.fail('缺少参数 command(要执行的命令行)');
    }
    // 1. 硬禁判定(带上工作区根: 就在工作区里干活的绝对路径不算越界)
    let verdict: GuardVerdict = CommandGuard.assess(command, root);
    let forbiddenReason: string = CommandGuard.forbiddenReason(verdict);
    if (forbiddenReason !== '') {
      return CommandService.fail('该命令被安全策略拒绝(' + forbiddenReason +
        ')。这类操作不可逆, 本应用不会代为执行 —— 请把要做什么说清楚, 交给用户自己在终端里完成');
    }
    // 2. 工作目录: 只允许工作区内的相对路径(与文件工具同一把尺子)
    let cwdRel: string = CommandService.strArg(args, 'cwd', '').replace(/^\/+/, '');
    let cwd: string = root;
    if (cwdRel !== '') {
      let resolved: string | null = WorkFileService.resolveSafePublic(root, cwdRel);
      if (resolved === null) {
        return CommandService.fail('cwd 必须是工作区内的相对路径(不允许越出工作区): ' + cwdRel);
      }
      if (!fileIo.accessSync(resolved) || !fileIo.statSync(resolved).isDirectory()) {
        return CommandService.fail('cwd 不是工作区里已存在的目录: ' + cwdRel);
      }
      cwd = resolved;
    }
    // 3. 审批(档位 + 本次任务的授权)
    let permission: string = CommandService.permissionFor(convId);
    let note: string = '';
    if (CommandService.grants[convId] !== true &&
      CommandGuard.needsApproval(verdict, permission)) {
      let approval: Approval = await CommandService.askApproval(convId, command, cwdRel, verdict);
      if (!approval.allowed) {
        return CommandService.denyResult(command, approval.why, approval.note);
      }
      if (approval.grantAll) {
        CommandService.grants[convId] = true;
      }
      note = approval.note;
    }
    // 4. 超时(命令自己的超时必须先于工具层的兜底超时触发, 否则进程没人收)
    let timeoutMs: number = CommandService.intArg(args, 'timeout_ms',
      Constants.WORK_CMD_DEFAULT_TIMEOUT_MS);
    if (timeoutMs <= 0) {
      timeoutMs = Constants.WORK_CMD_DEFAULT_TIMEOUT_MS;
    }
    if (timeoutMs > Constants.WORK_CMD_MAX_TIMEOUT_MS) {
      timeoutMs = Constants.WORK_CMD_MAX_TIMEOUT_MS;
    }
    // 5. 拉起进程
    let background: boolean = CommandService.boolArg(args, 'run_in_background', false);
    let task: ShellTask = new ShellTask(command, cwd);
    let limit: number = background ? Constants.WORK_CMD_JOB_BUFFER_BYTES :
      Constants.WORK_CMD_STREAM_BUFFER_BYTES;
    let startError: ShellOutcome | null = task.start(buildCleanEnv(), limit);
    if (startError !== null) {
      return CommandService.fail('命令启动失败: ' + startError.error);
    }
    if (background) {
      return CommandService.registerJob(convId, command, cwdRel, task, verdict, note);
    }
    let outcome: ShellOutcome = await task.wait(timeoutMs, abortSignal);
    return CommandService.renderForeground(root, cwdRel, outcome, verdict, note);
  }

  // ===== job_list / job_output / job_kill =====

  static listJobs(convId: string): ToolExecResult {
    CommandService.reapAll();
    let rows: string[] = [];
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      let job: CommandJob = CommandService.jobs[i];
      if (job.convId !== convId) {
        continue;
      }
      let status: string = job.finished ?
        (job.killed ? '已被终止' : '退出码 ' + job.exitCode.toString()) : '运行中';
      let unread: number = job.task === null ? 0 :
        Math.max(0, job.task.outputLength - job.cursor);
      rows.push('[' + job.id + '] ' + status + ' · 未读输出 ' + unread.toString() + ' 字符 · ' +
        CommandService.clip(job.command, 80) +
        ' · 目录 ' + (job.cwd === '' ? '工作区根' : job.cwd));
    }
    if (rows.length === 0) {
      return CommandService.ok('(本会话没有后台任务)');
    }
    return CommandService.ok('后台任务 ' + rows.length.toString() + ' 个:\n' + rows.join('\n') +
      '\n用 job_output(id) 读新增输出(每次只给上次之后的部分)。');
  }

  static jobOutput(convId: string, root: string,
    args: Record<string, Object>): ToolExecResult {
    CommandService.reapAll();
    let job: CommandJob | null = CommandService.findJob(convId,
      CommandService.strArg(args, 'job_id', ''));
    if (job === null) {
      return CommandService.fail('未找到该后台任务(用 job_list 查看 id)');
    }
    if (job.task === null) {
      return CommandService.ok('[' + job.id + '] 已结束, 没有更多输出');
    }
    let fresh: string = job.task.snapshot(job.cursor);
    job.cursor = job.task.outputLength;
    let head: string = '[' + job.id + '] ' + (job.finished ?
      (job.killed ? '已被终止' : '已结束, 退出码 ' + job.exitCode.toString()) : '仍在运行');
    if (fresh === '') {
      return CommandService.ok(head + '\n(本次没有新增输出)');
    }
    if (fresh.length > Constants.WORK_CMD_JOB_OUTPUT_MAX_CHARS) {
      fresh = CommandService.spillAndTruncate(root, 'job_output_' + job.id, fresh);
    }
    return CommandService.ok(head + '\n' + fresh);
  }

  static killJob(convId: string, args: Record<string, Object>): ToolExecResult {
    let id: string = CommandService.strArg(args, 'job_id', '');
    let job: CommandJob | null = CommandService.findJob(convId, id);
    if (job === null) {
      return CommandService.fail('未找到该后台任务(用 job_list 查看 id)');
    }
    if (job.finished) {
      return CommandService.ok('[' + job.id + '] 已经结束, 无需终止');
    }
    if (job.task !== null) {
      job.task.kill();
    }
    job.killed = true;
    job.finished = true;
    return CommandService.ok('已终止后台任务 [' + job.id + '] ' +
      CommandService.clip(job.command, 60));
  }

  // 同步结算已退出的后台任务(ShellTask 的 close 事件只维护自己的状态, 这里按快照回收到登记处)
  private static reapAll(): void {
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      let job: CommandJob = CommandService.jobs[i];
      if (job.finished || job.task === null || job.task.alive) {
        continue;
      }
      job.finished = true;
      job.exitCode = job.task.exitCodeValue;
      job.killed = job.task.wasKilled;
    }
  }

  private static findJob(convId: string, id: string): CommandJob | null {
    if (id === '') {
      return null;
    }
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      if (CommandService.jobs[i].convId === convId && CommandService.jobs[i].id === id) {
        return CommandService.jobs[i];
      }
    }
    return null;
  }

  private static registerJob(convId: string, command: string, cwdRel: string,
    task: ShellTask, verdict: GuardVerdict, note: string): ToolExecResult {
    CommandService.reapAll();
    CommandService.pruneFinished();
    if (CommandService.jobs.length >= Constants.WORK_CMD_MAX_JOBS) {
      task.kill();
      return CommandService.fail('后台任务已达上限(' +
        Constants.WORK_CMD_MAX_JOBS.toString() + ' 个), 先用 job_kill 结束不需要的任务');
    }
    let job: CommandJob = new CommandJob();
    job.id = 'cmd-' + (CommandService.jobSeq++).toString();
    job.convId = convId;
    job.command = command;
    job.cwd = cwdRel;
    job.task = task;
    job.startedAt = task.startedAt;
    CommandService.jobs.push(job);
    let r: ToolExecResult = CommandService.ok(
      '[run_command] 已放入后台, 任务 id=' + job.id + ', 目录 ' +
      (cwdRel === '' ? '工作区根' : cwdRel) + '\n' +
      '它在后台继续跑, 本轮不用等它。之后用 job_output(' + job.id +
      ') 读新增输出(每次只返回上次读过之后的部分), job_list 看状态, job_kill 结束它。' +
      CommandService.riskLine(verdict, note));
    return r;
  }

  // 结束态任务只保留最近 4 个, 避免长会话里注册表无限增长
  private static pruneFinished(): void {
    let finished: CommandJob[] = [];
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      if (CommandService.jobs[i].finished) {
        finished.push(CommandService.jobs[i]);
      }
    }
    if (finished.length <= 4) {
      return;
    }
    let drop: CommandJob[] = [];
    for (let d: number = 0; d < finished.length - 4; d++) {
      drop.push(finished[d]);
    }
    let keep: CommandJob[] = [];
    for (let j: number = 0; j < CommandService.jobs.length; j++) {
      if (drop.indexOf(CommandService.jobs[j]) === -1) {
        keep.push(CommandService.jobs[j]);
      }
    }
    CommandService.jobs = keep;
  }

  // ===== 审批 =====

  private static async askApproval(convId: string, command: string, cwdRel: string,
    verdict: GuardVerdict): Promise<Approval> {
    let lines: string[] = [];
    lines.push('智能体请求执行一条命令, 需要你批准。');
    lines.push('工作目录: ' + (cwdRel === '' ? '工作区根' : cwdRel));
    if (verdict.reasons.length > 0) {
      lines.push('风险: ' + verdict.reasons.join('、'));
    }
    lines.push('命令:');
    lines.push(command.trim());
    // 桥返回 null 的三种情况(超时/跳过/任务中止)都按拒绝处理 —— 没人应答就等于不许。
    let answer: AskAnswer | null = await AskUserBridge.ask(lines.join('\n'),
      [APPROVE_ONCE, APPROVE_ALL, APPROVE_DENY], false,
      Constants.WORK_ASK_WAIT_TIMEOUT_MS, convId);
    let approval: Approval = new Approval();
    if (answer === null) {
      approval.why = '未获得批准(超时或已跳过, 按拒绝处理)';
      return approval;
    }
    approval.note = answer.note.trim();
    let picked: string = answer.selections.join('|');
    if (picked.indexOf(APPROVE_DENY) !== -1) {
      approval.why = '用户明确拒绝';
      return approval;
    }
    if (picked.indexOf(APPROVE_ONCE) === -1 && picked.indexOf(APPROVE_ALL) === -1) {
      // 只写了补充说明、没点许可项: 审批必须点到明确的许可上, 不能把沉默当同意
      approval.why = '没有点选许可项';
      return approval;
    }
    approval.allowed = true;
    approval.grantAll = picked.indexOf(APPROVE_ALL) !== -1;
    return approval;
  }

  private static denyResult(command: string, why: string, note: string): ToolExecResult {
    let extra: string = note === '' ? '' : '; 用户补充: ' + note;
    return CommandService.fail('命令未执行(' + why + extra + '): ' +
      CommandService.clip(command, 120) +
      '。请改用文件/搜索等工具完成, 或把要执行的命令与理由写进回答交给用户, 不要重复请求同一条命令');
  }

  // ===== 结果渲染 =====

  private static renderForeground(root: string, cwdRel: string, outcome: ShellOutcome,
    verdict: GuardVerdict, note: string): ToolExecResult {
    let r: ToolExecResult = new ToolExecResult();
    let header: string = '[run_command] 退出码 ' + outcome.exitCode.toString() + ' · 用时 ' +
      (Math.round(outcome.durationMs / 100) / 10).toString() + 's · 目录 ' +
      (cwdRel === '' ? '工作区根' : cwdRel);
    let notes: string[] = [];
    if (outcome.timedOut) {
      notes.push('已达超时上限, 进程树已被终止(需要更久的话用 run_in_background 放后台)');
      r.timeout = true;
    }
    if (outcome.signal === 'aborted') {
      notes.push('任务被停止, 进程树已被终止');
      r.cancelled = true;
    }
    if (outcome.droppedChars > 0) {
      notes.push('输出超过缓冲上限, 开头 ' + outcome.droppedChars.toString() +
        ' 字符已被丢弃(下面只是结尾部分, 不是全量)');
    }
    let body: string = outcome.output.trim();
    if (body === '') {
      body = '(没有输出)';
    }
    if (body.length > Constants.WORK_RESULT_MAX_CHARS) {
      body = CommandService.spillAndTruncate(root, 'run_command', body);
    }
    r.ok = outcome.exitCode === 0 && !r.timeout && !r.cancelled;
    let tail: string = notes.length > 0 ? '\n注意: ' + notes.join('; ') : '';
    r.output = header + CommandService.riskLine(verdict, note) + tail + '\n\n' + body;
    if (!r.ok) {
      r.output = 'ERROR: ' + r.output;
    }
    return r;
  }

  private static riskLine(verdict: GuardVerdict, note: string): string {
    let text: string = '';
    if (verdict.risky) {
      text += '\n(已批准的危险项: ' + verdict.reasons.join('、') + ')';
    }
    if (note !== '') {
      text += '\n(用户批准时的补充要求: ' + note + ')';
    }
    return text;
  }

  // 超长输出: 全文落工作区 .spill/, 送回模型的只留头尾 + 定位(对齐 dsh 的「截断不丢失」)
  private static spillAndTruncate(root: string, label: string, text: string): string {
    let spillRel: string = SpillStore.save(root, label, text);
    return SpillStore.truncateWithLocator(text, spillRel);
  }

  // ===== 参数与小工具 =====

  private static clip(text: string, max: number): string {
    let oneLine: string = text.replace(/\s+/g, ' ').trim();
    return oneLine.length <= max ? oneLine : oneLine.substring(0, max) + '…';
  }

  private static strArg(args: Record<string, Object>, key: string, defVal: string): string {
    let v: Object = args[key];
    if (typeof v === 'string') {
      return v as string;
    }
    if (typeof v === 'number') {
      return (v as number).toString();
    }
    return defVal;
  }

  private static intArg(args: Record<string, Object>, key: string, defVal: number): number {
    let v: Object = args[key];
    if (typeof v === 'number' && !isNaN(v as number)) {
      return Math.floor(v as number);
    }
    if (typeof v === 'string') {
      let n: number = parseInt(v as string, 10);
      if (!isNaN(n)) {
        return n;
      }
    }
    return defVal;
  }

  private static boolArg(args: Record<string, Object>, key: string, defVal: boolean): boolean {
    let v: Object = args[key];
    if (typeof v === 'boolean') {
      return v as boolean;
    }
    if (typeof v === 'string') {
      let s: string = (v as string).toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') {
        return true;
      }
      if (s === 'false' || s === '0' || s === 'no') {
        return false;
      }
    }
    return defVal;
  }

  private static ok(output: string): ToolExecResult {
    let r: ToolExecResult = new ToolExecResult();
    r.ok = true;
    r.output = output;
    return r;
  }

  private static fail(output: string): ToolExecResult {
    let r: ToolExecResult = new ToolExecResult();
    r.ok = false;
    r.output = 'ERROR: ' + output;
    return r;
  }
}
