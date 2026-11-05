// 用量统计的进程级单例：内存账本 + 日聚合文件 + 防抖落盘 + DeepSeek 余额对账。
//
// 性能约束：
//   · record() 只在一次响应结束时做 O(1) 聚合，不碰 token 流；
//   · 文件序列化最多每 4 秒一次；流式过程中不会反复写盘；
//   · 不启后台轮询 / 常驻定时器；余额仅手动刷新或打开用量页且超过节流间隔时请求。
//   · 所有入口都 try/catch：统计失败绝不影响聊天。
import fs from 'node:fs';
import path from 'node:path';
import { filesDir } from '../platform/appPaths';
import { BuildUsageInput, UsagePricing } from './UsagePricing';
import {
  UsageBalanceData,
  UsageDayDetailView,
  UsageLedger,
  UsageRunTracker,
  UsageRunView,
  UsageSnapshotView,
  USAGE_RETENTION_DAYS
} from './UsageLedger';
import { UsageRecord, UsageTime } from './UsageTypes';

export class UsageService {
  static readonly FILE_NAME: string = 'usage-stats.json';
  static readonly SAVE_DEBOUNCE_MS: number = 4000;
  static readonly BALANCE_REFRESH_INTERVAL_MS: number = 6 * 60 * 60 * 1000;
  private static readonly BALANCE_URL: string = 'https://api.deepseek.com/user/balance';

  private static ledger: UsageLedger | null = null;
  private static loaded: boolean = false;
  private static dirty: boolean = false;
  private static saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static writeChain: Promise<void> = Promise.resolve();
  private static writeInProgress: boolean = false;
  /** 退出时同步写会作废仍在途的异步写，避免旧快照覆盖新快照 */
  private static writeGeneration: number = 0;
  private static prunedDay: string = '';

  static filePath(): string {
    return path.join(filesDir(), UsageService.FILE_NAME);
  }

  /** 启动时调用一次；读盘失败按空账本处理。 */
  static init(): void {
    if (UsageService.loaded) {
      return;
    }
    UsageService.loaded = true;
    try {
      const file: string = UsageService.filePath();
      let raw: string = '';
      if (fs.existsSync(file)) {
        raw = fs.readFileSync(file, 'utf8');
      }
      UsageService.ledger = UsageLedger.fromJson(raw);
      const removed: number = UsageService.ledger.prune(UsageTime.dateKey(Date.now()));
      UsageService.prunedDay = UsageTime.dateKey(Date.now());
      if (removed > 0) {
        UsageService.dirty = true;
        UsageService.scheduleSave();
      }
    } catch {
      UsageService.ledger = UsageLedger.createEmpty();
    }
  }

  private static ensureLoaded(): UsageLedger {
    if (!UsageService.loaded || UsageService.ledger === null) {
      UsageService.init();
    }
    return UsageService.ledger ?? UsageLedger.createEmpty();
  }

  /**
   * 记录一次真实 API 响应。失败静默，不向调用方抛任何异常。
   * sessionId 只用于「本轮统计」的内存汇总，不参与日聚合、不落盘到会话。
   */
  static record(input: BuildUsageInput): void {
    try {
      const ledger: UsageLedger = UsageService.ensureLoaded();
      const record: UsageRecord = UsagePricing.buildRecord(input);
      ledger.record(record);
      UsageRunTracker.record(record.sessionId, record);
      if (UsageService.prunedDay !== UsageTime.dateKey(record.startedAt)) {
        UsageService.prunedDay = UsageTime.dateKey(record.startedAt);
        ledger.prune(UsageService.prunedDay);
      }
      UsageService.dirty = true;
      UsageService.scheduleSave();
    } catch {
      // 统计失败不影响聊天主流程
    }
  }

  static snapshot(todayKey: string = UsageTime.dateKey(Date.now())): UsageSnapshotView {
    try {
      const ledger: UsageLedger = UsageService.ensureLoaded();
      const before: number = Object.keys(ledger.data.days).length;
      const view: UsageSnapshotView = ledger.snapshot(todayKey);
      if (Object.keys(ledger.data.days).length !== before) {
        // snapshot 内部会裁剪过期日；把裁剪结果也持久化
        UsageService.dirty = true;
        UsageService.scheduleSave();
      }
      return view;
    } catch {
      return UsageLedger.createEmpty().snapshot(todayKey);
    }
  }

  static dayDetail(dateKey: string): UsageDayDetailView {
    try {
      return UsageService.ensureLoaded().dayDetail(dateKey);
    } catch {
      return { date: dateKey, models: [] };
    }
  }

  static setBudget(budgetCny: number): void {
    try {
      UsageService.ensureLoaded().setBudget(budgetCny);
      UsageService.dirty = true;
      UsageService.scheduleSave();
    } catch {
      // 静默
    }
  }

  static getBudget(): number {
    try {
      return UsageService.ensureLoaded().getBudget();
    } catch {
      return 0;
    }
  }

  static csv(): string {
    try {
      return UsageService.ensureLoaded().csv();
    } catch {
      return '';
    }
  }

  // ===== 本轮统计（仅内存） =====

  static beginRun(sessionId: string): void {
    try {
      UsageRunTracker.begin(sessionId);
    } catch {
      // 静默
    }
  }

  static endRun(sessionId: string): void {
    try {
      UsageRunTracker.end(sessionId);
    } catch {
      // 静默
    }
  }

  static forgetRun(sessionId: string): void {
    try {
      UsageRunTracker.forget(sessionId);
    } catch {
      // 静默
    }
  }

  static runView(sessionId: string): UsageRunView {
    try {
      return UsageRunTracker.view(sessionId);
    } catch {
      return { costCny: 0, tokens: 0, requests: 0, missingUsage: 0, unpricedRequests: 0 };
    }
  }

  // ===== DeepSeek 余额（可选对账） =====

  static balanceDue(): boolean {
    try {
      const ledger: UsageLedger = UsageService.ensureLoaded();
      const last: number = ledger.data.meta.balanceAttemptAt;
      return last <= 0 || Date.now() - last >= UsageService.BALANCE_REFRESH_INTERVAL_MS;
    } catch {
      return false;
    }
  }

  /**
   * 手动刷新传 force=true；打开用量页传 false（受 6 小时节流）。
   * 任何失败都只记录错误文本，不抛、不影响页面其余数据。
   */
  static async refreshDeepSeekBalance(apiKey: string, force: boolean = false): Promise<void> {
    if ((apiKey ?? '').trim() === '') {
      return;
    }
    const ledger: UsageLedger = UsageService.ensureLoaded();
    const now: number = Date.now();
    const last: number = ledger.data.meta.balanceAttemptAt;
    if (!force && last > 0 && now - last < UsageService.BALANCE_REFRESH_INTERVAL_MS) {
      return;
    }
    ledger.setBalanceAttempt(now);
    UsageService.dirty = true;
    UsageService.scheduleSave();

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const controller: AbortController = new AbortController();
      timer = setTimeout(() => controller.abort(), 10000);
      timer.unref?.();
      const response: Response = await fetch(UsageService.BALANCE_URL, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + apiKey.trim(),
          Accept: 'application/json'
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status.toString());
      }
      const json: Object = await response.json();
      const balance: UsageBalanceData | null = UsageService.parseBalance(json);
      if (balance === null) {
        throw new Error('余额响应格式无法识别');
      }
      ledger.setBalance(balance);
    } catch (e) {
      const message: string = (e as Error)?.name === 'AbortError'
        ? '余额刷新超时'
        : ((e as Error)?.message ?? '余额刷新失败');
      ledger.setBalanceError(message);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
      UsageService.dirty = true;
      UsageService.scheduleSave();
    }
  }

  static parseBalance(json: Object): UsageBalanceData | null {
    if (typeof json !== 'object' || json === null) {
      return null;
    }
    const rec: Record<string, Object> = json as Record<string, Object>;
    const infos: Object = rec['balance_infos'];
    if (!(infos instanceof Array) || (infos as Object[]).length === 0) {
      return null;
    }
    const list: Object[] = infos as Object[];
    let chosen: Record<string, Object> | null = null;
    for (let i: number = 0; i < list.length; i++) {
      if (typeof list[i] !== 'object' || list[i] === null) {
        continue;
      }
      const item: Record<string, Object> = list[i] as Record<string, Object>;
      if (chosen === null) {
        chosen = item;
      }
      if (typeof item['currency'] === 'string' &&
        (item['currency'] as string).toUpperCase() === 'CNY') {
        chosen = item;
        break;
      }
    }
    if (chosen === null) {
      return null;
    }
    const number = (key: string): number => {
      const value: Object = chosen !== null ? chosen[key] : undefined;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value as number;
      }
      if (typeof value === 'string') {
        const n: number = parseFloat(value as string);
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    };
    return {
      at: Date.now(),
      currency: typeof chosen['currency'] === 'string' ? chosen['currency'] as string : 'CNY',
      total: number('total_balance'),
      granted: number('granted_balance'),
      toppedUp: number('topped_up_balance'),
      available: rec['is_available'] === true,
      error: ''
    };
  }

  // ===== 落盘 =====

  private static scheduleSave(): void {
    try {
      // 只保证「首次记账后 4 秒内写一次」，不因后续记录不断重置而饿死；
      // 长 Agent Loop 里每轮都重置的话，可能连续几分钟都不落盘。
      if (UsageService.saveTimer !== null) {
        return;
      }
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        UsageService.saveTimer = null;
        void UsageService.flush();
      }, UsageService.SAVE_DEBOUNCE_MS);
      timer.unref?.();
      UsageService.saveTimer = timer;
    } catch {
      // 静默
    }
  }

  static flush(): Promise<void> {
    if (!UsageService.dirty) {
      return UsageService.writeChain;
    }
    if (UsageService.saveTimer !== null) {
      clearTimeout(UsageService.saveTimer);
      UsageService.saveTimer = null;
    }
    let text: string = '';
    try {
      text = JSON.stringify(UsageService.ensureLoaded().data);
    } catch {
      return UsageService.writeChain;
    }
    UsageService.dirty = false;
    const generation: number = ++UsageService.writeGeneration;
    UsageService.writeChain = UsageService.writeChain
      .then(async (): Promise<void> => {
        UsageService.writeInProgress = true;
        try {
          await UsageService.writeAtomic(text, generation);
        } finally {
          UsageService.writeInProgress = false;
        }
      })
      .catch(() => {
        // 写失败不抛出、不影响计时器；下一次记账还会触发重试
        UsageService.dirty = true;
      });
    return UsageService.writeChain;
  }

  /** 退出/切后台时同步落盘；允许最后几秒统计丢失，稳定优先 */
  static flushSync(): void {
    if (!UsageService.dirty && !UsageService.writeInProgress) {
      return;
    }
    // 作废仍在途的异步写，防止它随后用旧快照覆盖这次同步写
    UsageService.writeGeneration++;
    if (UsageService.saveTimer !== null) {
      clearTimeout(UsageService.saveTimer);
      UsageService.saveTimer = null;
    }
    try {
      const text: string = JSON.stringify(UsageService.ensureLoaded().data);
      const file: string = UsageService.filePath();
      const dir: string = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      const tmp: string = file + '.tmp';
      fs.writeFileSync(tmp, text, 'utf8');
      try {
        fs.renameSync(tmp, file);
      } catch {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // ignore
        }
        fs.renameSync(tmp, file);
      }
      UsageService.dirty = false;
    } catch {
      // 静默
    }
  }

  private static async writeAtomic(text: string, generation: number): Promise<void> {
    const file: string = UsageService.filePath();
    const dir: string = path.dirname(file);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp: string = file + '.tmp';
    await fs.promises.writeFile(tmp, text, 'utf8');
    if (generation !== UsageService.writeGeneration) {
      // 已被退出时的同步写取代：清理临时文件，不再动正式文件
      await fs.promises.rm(tmp, { force: true }).catch((): void => {})
      return;
    }
    try {
      await fs.promises.rename(tmp, file);
    } catch {
      try {
        await fs.promises.rm(file, { force: true });
      } catch {
        // ignore
      }
      if (generation !== UsageService.writeGeneration) {
        await fs.promises.rm(tmp, { force: true }).catch((): void => {})
        return;
      }
      await fs.promises.rename(tmp, file);
    }
  }
}

export { USAGE_RETENTION_DAYS };
