// 用量统计的纯数据类型、北京时间归日与峰谷判定。
//
// 这一层不依赖 Electron / 文件系统 / 网络，便于用 Node 直接做回归测试。
// 统计口径刻意与协议解耦：调用方只传「开始时间 + 服务商 + 模型 + 归一化后的 token」，
// 日聚合、峰谷、计价都在上层完成。

export class UsageProvider {
  static readonly DEEPSEEK: string = 'deepseek';
  static readonly OPENCODE_GO: string = 'opencode-go';
  static readonly OTHER: string = 'other';

  static label(provider: string): string {
    if (provider === UsageProvider.DEEPSEEK) {
      return 'DeepSeek';
    }
    if (provider === UsageProvider.OPENCODE_GO) {
      return 'OpenCode Go';
    }
    return '其他服务商';
  }
}

/** 协议归一化后的 token 口径（单位：tokens） */
export interface NormalizedUsage {
  /** 输入命中缓存 */
  inputHit: number;
  /** 输入未命中缓存 */
  inputMiss: number;
  /** 写入缓存的输入 */
  cacheWrite: number;
  /** 输出（reasoning 已包含在内，不重复计） */
  output: number;
  /** 服务端 web_search / web_fetch 次数 */
  searchCount: number;
  /** OpenCode 套餐额度消耗（USD） */
  allowanceUsd: number | null;
  /** 网关返回的实际成本（USD） */
  costUsd: number | null;
  /** 网关返回的等价按量成本（USD） */
  listCostUsd: number | null;
  /** go / go-plus / balance / byok / free ... */
  billingSource: string;
  /** 响应没有可用 usage，字段全部按 0 计 */
  missingUsage: boolean;
}

/** 一次真实 API 响应的记账记录 */
export interface UsageRecord {
  startedAt: number;
  provider: string;
  model: string;
  protocol: string;
  inputHit: number;
  inputMiss: number;
  cacheWrite: number;
  output: number;
  searchCount: number;
  allowanceUsd: number | null;
  costUsd: number | null;
  listCostUsd: number | null;
  billingSource: string;
  estimated: boolean;
  missingUsage: boolean;
  /** 仅用于「本轮统计」，不落盘 */
  sessionId: string;
}

/** 一个 日期 × 服务商 × 模型 × 峰/谷 的聚合桶 */
export interface UsageBucket {
  requests: number;
  inputHit: number;
  inputMiss: number;
  cacheWrite: number;
  output: number;
  searchCount: number;
  costUsd: number;
  listCostUsd: number;
  allowanceUsd: number;
  missingUsage: number;
  estimatedRequests: number;
  unpricedRequests: number;
}

export function emptyBucket(): UsageBucket {
  return {
    requests: 0,
    inputHit: 0,
    inputMiss: 0,
    cacheWrite: 0,
    output: 0,
    searchCount: 0,
    costUsd: 0,
    listCostUsd: 0,
    allowanceUsd: 0,
    missingUsage: 0,
    estimatedRequests: 0,
    unpricedRequests: 0
  };
}

export function cloneBucket(b: UsageBucket): UsageBucket {
  return {
    requests: b.requests,
    inputHit: b.inputHit,
    inputMiss: b.inputMiss,
    cacheWrite: b.cacheWrite,
    output: b.output,
    searchCount: b.searchCount,
    costUsd: b.costUsd,
    listCostUsd: b.listCostUsd,
    allowanceUsd: b.allowanceUsd,
    missingUsage: b.missingUsage,
    estimatedRequests: b.estimatedRequests,
    unpricedRequests: b.unpricedRequests
  };
}

export function addBucket(target: UsageBucket, source: UsageBucket): void {
  target.requests += source.requests;
  target.inputHit += source.inputHit;
  target.inputMiss += source.inputMiss;
  target.cacheWrite += source.cacheWrite;
  target.output += source.output;
  target.searchCount += source.searchCount;
  target.costUsd += source.costUsd;
  target.listCostUsd += source.listCostUsd;
  target.allowanceUsd += source.allowanceUsd;
  target.missingUsage += source.missingUsage;
  target.estimatedRequests += source.estimatedRequests;
  target.unpricedRequests += source.unpricedRequests;
}

export function totalTokens(b: UsageBucket): number {
  return b.inputHit + b.inputMiss + b.cacheWrite + b.output;
}

export function roundMoney(value: number, digits: number = 6): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor: number = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/** 模型每日聚合：峰/谷两个桶 + 计费来源 */
export interface UsageModelDay {
  peak: UsageBucket;
  off: UsageBucket;
  billingSources: string[];
}

export interface UsageDay {
  /** dateKey -> provider -> model -> 聚合 */
  providers: Record<string, Record<string, UsageModelDay>>;
}

export interface UsageRunStats {
  startedAt: number;
  lastAt: number;
  ended: boolean;
  requests: number;
  inputHit: number;
  inputMiss: number;
  cacheWrite: number;
  output: number;
  costUsd: number;
  listCostUsd: number;
  allowanceUsd: number;
  missingUsage: number;
  unpricedRequests: number;
}

export function emptyRunStats(startedAt: number): UsageRunStats {
  return {
    startedAt,
    lastAt: startedAt,
    ended: false,
    requests: 0,
    inputHit: 0,
    inputMiss: 0,
    cacheWrite: 0,
    output: 0,
    costUsd: 0,
    listCostUsd: 0,
    allowanceUsd: 0,
    missingUsage: 0,
    unpricedRequests: 0
  };
}

/**
 * 北京时间工具。
 *
 * 所有边界（归日、峰谷、月份归属）都只依赖「请求开始时间」。
 * 这里不使用 Intl / 系统时区：直接把时间戳 +8h 后按 UTC 字段读取，
 * 无论用户机器在哪个时区都得到同一结果。
 */
export class UsageTime {
  static readonly BEIJING_OFFSET_MS: number = 8 * 60 * 60 * 1000;
  static readonly DAY_MS: number = 24 * 60 * 60 * 1000;

  // 中国法定节假日（只列「全天放假」的日期；调休上班的周末不特殊处理——
  // 规则明确写的是「周末一律空闲」，调休日仍按周末口径，保守且不会高估费用）。
  static readonly HOLIDAY_YEARS: number[] = [2024, 2025, 2026];

  private static readonly HOLIDAYS: Record<string, boolean> = UsageTime.buildHolidays();

  private static buildHolidays(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    const addRange = (from: string, to: string): void => {
      let cursor: string = from;
      while (cursor <= to) {
        out[cursor] = true;
        cursor = UsageTime.addDays(cursor, 1);
      }
    };
    // 2024 国务院办公厅安排
    addRange('2024-01-01', '2024-01-01');
    addRange('2024-02-10', '2024-02-17');
    addRange('2024-04-04', '2024-04-06');
    addRange('2024-05-01', '2024-05-05');
    addRange('2024-06-10', '2024-06-10');
    addRange('2024-09-15', '2024-09-17');
    addRange('2024-10-01', '2024-10-07');
    // 2025 国务院办公厅安排
    addRange('2025-01-01', '2025-01-01');
    addRange('2025-01-28', '2025-02-04');
    addRange('2025-04-04', '2025-04-06');
    addRange('2025-05-01', '2025-05-05');
    addRange('2025-05-31', '2025-06-02');
    addRange('2025-10-01', '2025-10-08');
    // 2026 国务院办公厅安排（国办发明电〔2025〕7号）
    addRange('2026-01-01', '2026-01-03');
    addRange('2026-02-15', '2026-02-23');
    addRange('2026-04-04', '2026-04-06');
    addRange('2026-05-01', '2026-05-05');
    addRange('2026-06-19', '2026-06-21');
    addRange('2026-09-25', '2026-09-27');
    addRange('2026-10-01', '2026-10-07');
    return out;
  }

  /** 毫秒时间戳 → 北京时间 YYYY-MM-DD */
  static dateKey(ms: number): string {
    const d: Date = new Date(ms + UsageTime.BEIJING_OFFSET_MS);
    return UsageTime.formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  /** 毫秒时间戳 → 北京时间 YYYY-MM */
  static monthKey(ms: number): string {
    return UsageTime.dateKey(ms).substring(0, 7);
  }

  static formatDate(year: number, month: number, day: number): string {
    const mm: string = month < 10 ? '0' + month.toString() : month.toString();
    const dd: string = day < 10 ? '0' + day.toString() : day.toString();
    return year.toString() + '-' + mm + '-' + dd;
  }

  /**
   * YYYY-MM-DD ± days。
   * 用 UTC 零点做算术，避免本地时区在跨月/夏令时上引入偏差。
   */
  static addDays(dateKey: string, days: number): string {
    const parts: number[] = UsageTime.parseDateKey(dateKey);
    const base: number = Date.UTC(parts[0], parts[1] - 1, parts[2]);
    const d: Date = new Date(base + days * UsageTime.DAY_MS);
    return UsageTime.formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  static parseDateKey(dateKey: string): number[] {
    const m: RegExpMatchArray | null = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
    if (m === null) {
      return [1970, 1, 1];
    }
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  }

  /** 周一 = 0 ... 周日 = 6（北京时间） */
  static weekdayIndex(ms: number): number {
    const day: number = new Date(ms + UsageTime.BEIJING_OFFSET_MS).getUTCDay();
    return (day + 6) % 7;
  }

  static isWeekend(ms: number): boolean {
    const day: number = new Date(ms + UsageTime.BEIJING_OFFSET_MS).getUTCDay();
    return day === 0 || day === 6;
  }

  static isHoliday(ms: number): boolean {
    const key: string = UsageTime.dateKey(ms);
    return UsageTime.HOLIDAYS[key] === true;
  }

  /** 当天北京时间的分钟数（0..1439） */
  static minuteOfDay(ms: number): number {
    const d: Date = new Date(ms + UsageTime.BEIJING_OFFSET_MS);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  /**
   * 是否高峰：工作日（周一至周五）09:00–12:00、14:00–18:00。
   * 边界按左闭右开处理：08:59 空闲、09:00 高峰、11:59 高峰、12:00 空闲、
   * 13:59 空闲、14:00 高峰、17:59 高峰、18:00 空闲。
   */
  static isPeak(ms: number): boolean {
    if (UsageTime.isWeekend(ms) || UsageTime.isHoliday(ms)) {
      return false;
    }
    const minute: number = UsageTime.minuteOfDay(ms);
    return (minute >= 9 * 60 && minute < 12 * 60) || (minute >= 14 * 60 && minute < 18 * 60);
  }

  static peakLabel(ms: number): string {
    return UsageTime.isPeak(ms) ? 'peak' : 'off';
  }

  /** 缺失年份说明用：返回覆盖年份与当前查询年份中未收录的部分 */
  static holidayCoverage(years: number[]): { covered: number[]; missing: number[] } {
    const covered: number[] = [];
    const missing: number[] = [];
    for (let i: number = 0; i < years.length; i++) {
      if (UsageTime.HOLIDAY_YEARS.indexOf(years[i]) >= 0) {
        covered.push(years[i]);
      } else {
        missing.push(years[i]);
      }
    }
    return { covered, missing };
  }

  static formatBeijingDateTime(ms: number): string {
    const d: Date = new Date(ms + UsageTime.BEIJING_OFFSET_MS);
    const y: string = d.getUTCFullYear().toString();
    const mo: string = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const da: string = d.getUTCDate().toString().padStart(2, '0');
    const h: string = d.getUTCHours().toString().padStart(2, '0');
    const mi: string = d.getUTCMinutes().toString().padStart(2, '0');
    return y + '-' + mo + '-' + da + ' ' + h + ':' + mi;
  }
}
