// 用量账本：逐请求写入 → 按日聚合 → 裁剪 → 快照 / 明细 / CSV。
//
// 设计约束：
//   · 只保存聚合桶，不保存逐请求明细；400 天日聚合通常只有几十到几百 KB。
//   · 所有读取都在内存账本上完成，热力图只在页面打开时生成一次快照。
//   · 纯逻辑，不依赖文件系统；落盘/防抖由 UsageService 负责。
import {
  UsageBucket,
  UsageDay,
  UsageModelDay,
  UsageRecord,
  UsageRunStats,
  UsageTime,
  UsageProvider,
  addBucket,
  cloneBucket,
  emptyBucket,
  emptyRunStats,
  roundMoney,
  totalTokens
} from './UsageTypes';
import { UsagePricing } from './UsagePricing';

export const USAGE_FILE_VERSION: number = 1;
export const USAGE_RETENTION_DAYS: number = 400;
export const USAGE_HEATMAP_DAYS: number = 371;

export interface UsageBalanceData {
  at: number;
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
  available: boolean;
  error: string;
}

export interface UsageMetaData {
  budgetCny: number;
  balance: UsageBalanceData | null;
  balanceAttemptAt: number;
  balanceError: string;
  billingSources: string[];
}

export interface UsageFileData {
  version: number;
  createdAt: number;
  updatedAt: number;
  priceVersion: string;
  days: Record<string, UsageDay>;
  totals: Record<string, UsageBucket>;
  meta: UsageMetaData;
}

export interface UsageDayProviderView {
  peak: UsageBucket;
  off: UsageBucket;
}

export interface UsageDayView {
  date: string;
  providers: Record<string, UsageDayProviderView>;
}

export interface UsageDayModelView {
  provider: string;
  model: string;
  billingSources: string[];
  peak: UsageBucket;
  off: UsageBucket;
}

export interface UsageDayDetailView {
  date: string;
  models: UsageDayModelView[];
}

export interface UsageSnapshotView {
  generatedAt: number;
  today: string;
  rangeStart: string;
  rangeEnd: string;
  days: UsageDayView[];
  monthByProvider: Record<string, UsageBucket>;
  billingSources: string[];
  balance: UsageBalanceData | null;
  balanceError: string;
  budget: {
    monthlyCny: number;
    monthCostCny: number;
    over: boolean;
  };
  totals: UsageBucket;
  price: {
    version: string;
    updatedAt: string;
    usdToCny: number;
    exchangeUpdatedAt: string;
    peakRule: string;
    holidayYears: number[];
    missingHolidayYears: number[];
    searchCnyPerCall: number;
  };
}

function emptyMeta(): UsageMetaData {
  return {
    budgetCny: 0,
    balance: null,
    balanceAttemptAt: 0,
    balanceError: '',
    billingSources: []
  };
}

function emptyFile(now: number): UsageFileData {
  return {
    version: USAGE_FILE_VERSION,
    createdAt: now,
    updatedAt: now,
    priceVersion: UsagePricing.VERSION,
    days: {},
    totals: {},
    meta: emptyMeta()
  };
}

/** 防止 __proto__ / constructor 这类模型名污染普通对象 */
function safeKey(key: string): string {
  const value: string = (key ?? '').trim();
  if (value === '' || value === '__proto__' || value === 'constructor' || value === 'prototype') {
    return '_' + value;
  }
  return value;
}

function hasOwn(obj: Record<string, Object>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function childRecord(
  parent: Record<string, Object>,
  key: string
): Record<string, Object> {
  if (!hasOwn(parent, key) || typeof parent[key] !== 'object' || parent[key] === null) {
    parent[key] = {};
  }
  return parent[key] as Record<string, Object>;
}

function numberField(obj: Record<string, Object>, key: string): number {
  const value: Object = obj[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value as number;
  }
  if (typeof value === 'string') {
    const n: number = parseFloat(value as string);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function sanitizeBucket(raw: Object | null): UsageBucket {
  const out: UsageBucket = emptyBucket();
  if (typeof raw !== 'object' || raw === null) {
    return out;
  }
  const rec: Record<string, Object> = raw as Record<string, Object>;
  out.requests = Math.max(0, numberField(rec, 'requests'));
  out.inputHit = Math.max(0, numberField(rec, 'inputHit'));
  out.inputMiss = Math.max(0, numberField(rec, 'inputMiss'));
  out.cacheWrite = Math.max(0, numberField(rec, 'cacheWrite'));
  out.output = Math.max(0, numberField(rec, 'output'));
  out.searchCount = Math.max(0, numberField(rec, 'searchCount'));
  out.costUsd = Math.max(0, numberField(rec, 'costUsd'));
  out.listCostUsd = Math.max(0, numberField(rec, 'listCostUsd'));
  out.allowanceUsd = Math.max(0, numberField(rec, 'allowanceUsd'));
  out.missingUsage = Math.max(0, numberField(rec, 'missingUsage'));
  out.estimatedRequests = Math.max(0, numberField(rec, 'estimatedRequests'));
  out.unpricedRequests = Math.max(0, numberField(rec, 'unpricedRequests'));
  return out;
}

function sanitizeModelDay(raw: Object | null): UsageModelDay {
  const out: UsageModelDay = {
    peak: emptyBucket(),
    off: emptyBucket(),
    billingSources: []
  };
  if (typeof raw !== 'object' || raw === null) {
    return out;
  }
  const rec: Record<string, Object> = raw as Record<string, Object>;
  out.peak = sanitizeBucket(rec['peak'] as Object);
  out.off = sanitizeBucket(rec['off'] as Object);
  const sources: Object = rec['billingSources'];
  if (sources instanceof Array) {
    for (let i: number = 0; i < (sources as Object[]).length; i++) {
      const value: Object = (sources as Object[])[i];
      if (typeof value === 'string' && value !== '' && out.billingSources.indexOf(value as string) < 0) {
        out.billingSources.push(value as string);
      }
    }
  }
  return out;
}

export class UsageLedger {
  data: UsageFileData;

  constructor(data?: UsageFileData) {
    this.data = data ?? emptyFile(Date.now());
  }

  static createEmpty(now: number = Date.now()): UsageLedger {
    return new UsageLedger(emptyFile(now));
  }

  static fromJson(raw: string): UsageLedger {
    if (raw.trim() === '') {
      return UsageLedger.createEmpty();
    }
    try {
      const parsed: Object = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || parsed instanceof Array) {
        return UsageLedger.createEmpty();
      }
      const rec: Record<string, Object> = parsed as Record<string, Object>;
      const now: number = Date.now();
      const data: UsageFileData = emptyFile(now);
      data.version = Math.max(1, numberField(rec, 'version') || USAGE_FILE_VERSION);
      data.createdAt = Math.max(0, numberField(rec, 'createdAt')) || now;
      data.updatedAt = Math.max(0, numberField(rec, 'updatedAt')) || now;
      data.priceVersion = typeof rec['priceVersion'] === 'string'
        ? rec['priceVersion'] as string
        : UsagePricing.VERSION;

      const daysRaw: Object = rec['days'];
      if (typeof daysRaw === 'object' && daysRaw !== null && !(daysRaw instanceof Array)) {
        const dayKeys: string[] = Object.keys(daysRaw as Record<string, Object>);
        for (let i: number = 0; i < dayKeys.length; i++) {
          const dateKey: string = dayKeys[i];
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
            continue;
          }
          const rawDay: Object = (daysRaw as Record<string, Object>)[dateKey];
          if (typeof rawDay !== 'object' || rawDay === null) {
            continue;
          }
          const rawProviders: Object = (rawDay as Record<string, Object>)['providers'];
          if (typeof rawProviders !== 'object' || rawProviders === null) {
            continue;
          }
          const day: UsageDay = { providers: {} };
          const providerKeys: string[] = Object.keys(rawProviders as Record<string, Object>);
          for (let p: number = 0; p < providerKeys.length; p++) {
            const provider: string = providerKeys[p];
            const rawModels: Object = (rawProviders as Record<string, Object>)[provider];
            if (typeof rawModels !== 'object' || rawModels === null) {
              continue;
            }
            const models: Record<string, UsageModelDay> = {};
            const modelKeys: string[] = Object.keys(rawModels as Record<string, Object>);
            for (let m: number = 0; m < modelKeys.length; m++) {
              models[safeKey(modelKeys[m])] = sanitizeModelDay(
                (rawModels as Record<string, Object>)[modelKeys[m]] as Object
              );
            }
            day.providers[safeKey(provider)] = models;
          }
          if (Object.keys(day.providers).length > 0) {
            data.days[dateKey] = day;
          }
        }
      }

      const totalsRaw: Object = rec['totals'];
      if (typeof totalsRaw === 'object' && totalsRaw !== null && !(totalsRaw instanceof Array)) {
        const keys: string[] = Object.keys(totalsRaw as Record<string, Object>);
        for (let i: number = 0; i < keys.length; i++) {
          data.totals[safeKey(keys[i])] = sanitizeBucket(
            (totalsRaw as Record<string, Object>)[keys[i]] as Object
          );
        }
      }
      if (Object.keys(data.totals).length === 0) {
        // 旧文件/损坏文件没有全量累计时，用现有日聚合重建（会少掉已裁剪的天数）
        UsageLedger.rebuildTotals(data);
      }

      const metaRaw: Object = rec['meta'];
      data.meta = emptyMeta();
      if (typeof metaRaw === 'object' && metaRaw !== null) {
        const meta: Record<string, Object> = metaRaw as Record<string, Object>;
        data.meta.budgetCny = Math.max(0, numberField(meta, 'budgetCny'));
        data.meta.balanceAttemptAt = Math.max(0, numberField(meta, 'balanceAttemptAt'));
        data.meta.balanceError = typeof meta['balanceError'] === 'string'
          ? meta['balanceError'] as string
          : '';
        const sources: Object = meta['billingSources'];
        if (sources instanceof Array) {
          for (let i: number = 0; i < (sources as Object[]).length; i++) {
            const value: Object = (sources as Object[])[i];
            if (typeof value === 'string' && value !== '' && data.meta.billingSources.indexOf(value as string) < 0) {
              data.meta.billingSources.push(value as string);
            }
          }
        }
        data.meta.balance = UsageLedger.sanitizeBalance(meta['balance'] as Object);
      }
      return new UsageLedger(data);
    } catch {
      return UsageLedger.createEmpty();
    }
  }

  private static sanitizeBalance(raw: Object | null): UsageBalanceData | null {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const rec: Record<string, Object> = raw as Record<string, Object>;
    const at: number = numberField(rec, 'at');
    if (at <= 0) {
      return null;
    }
    return {
      at: at,
      currency: typeof rec['currency'] === 'string' ? rec['currency'] as string : 'CNY',
      total: numberField(rec, 'total'),
      granted: numberField(rec, 'granted'),
      toppedUp: numberField(rec, 'toppedUp'),
      available: rec['available'] === true,
      error: typeof rec['error'] === 'string' ? rec['error'] as string : ''
    };
  }

  private static rebuildTotals(data: UsageFileData): void {
    const totals: Record<string, UsageBucket> = {};
    const dates: string[] = Object.keys(data.days);
    for (let i: number = 0; i < dates.length; i++) {
      const day: UsageDay = data.days[dates[i]];
      const providers: string[] = Object.keys(day.providers);
      for (let p: number = 0; p < providers.length; p++) {
        const provider: string = providers[p];
        if (!hasOwn(totals, provider)) {
          totals[provider] = emptyBucket();
        }
        const models: Record<string, UsageModelDay> = day.providers[provider];
        const modelKeys: string[] = Object.keys(models);
        for (let m: number = 0; m < modelKeys.length; m++) {
          addBucket(totals[provider], models[modelKeys[m]].peak);
          addBucket(totals[provider], models[modelKeys[m]].off);
        }
      }
    }
    data.totals = totals;
  }

  /** 逐请求记账：O(模型数)，不扫描历史 */
  record(record: UsageRecord): void {
    const dateKey: string = UsageTime.dateKey(record.startedAt);
    const provider: string = safeKey(record.provider);
    const model: string = safeKey(record.model);
    const peak: boolean = UsageTime.isPeak(record.startedAt);

    if (!hasOwn(this.data.days, dateKey)) {
      this.data.days[dateKey] = { providers: {} };
    }
    const day: UsageDay = this.data.days[dateKey];
    if (!hasOwn(day.providers, provider)) {
      day.providers[provider] = {};
    }
    if (!hasOwn(day.providers[provider], model)) {
      day.providers[provider][model] = {
        peak: emptyBucket(),
        off: emptyBucket(),
        billingSources: []
      };
    }
    const modelDay: UsageModelDay = day.providers[provider][model];
    const bucket: UsageBucket = peak ? modelDay.peak : modelDay.off;

    bucket.requests++;
    bucket.inputHit += record.inputHit;
    bucket.inputMiss += record.inputMiss;
    bucket.cacheWrite += record.cacheWrite;
    bucket.output += record.output;
    bucket.searchCount += record.searchCount;
    bucket.costUsd += record.costUsd ?? 0;
    bucket.listCostUsd += record.listCostUsd ?? 0;
    bucket.allowanceUsd += record.allowanceUsd ?? 0;
    if (record.missingUsage) {
      bucket.missingUsage++;
    }
    if (record.estimated) {
      bucket.estimatedRequests++;
    }
    if (!record.missingUsage && record.costUsd === null && record.listCostUsd === null) {
      bucket.unpricedRequests++;
    }

    if (record.billingSource !== '' && modelDay.billingSources.indexOf(record.billingSource) < 0) {
      modelDay.billingSources.push(record.billingSource);
      if (modelDay.billingSources.length > 8) {
        modelDay.billingSources = modelDay.billingSources.slice(-8);
      }
    }
    if (record.billingSource !== '' && this.data.meta.billingSources.indexOf(record.billingSource) < 0) {
      this.data.meta.billingSources.push(record.billingSource);
      if (this.data.meta.billingSources.length > 8) {
        this.data.meta.billingSources = this.data.meta.billingSources.slice(-8);
      }
    }

    if (!hasOwn(this.data.totals, provider)) {
      this.data.totals[provider] = emptyBucket();
    }
    const totalBucket: UsageBucket = this.data.totals[provider];
    totalBucket.requests++;
    totalBucket.inputHit += record.inputHit;
    totalBucket.inputMiss += record.inputMiss;
    totalBucket.cacheWrite += record.cacheWrite;
    totalBucket.output += record.output;
    totalBucket.searchCount += record.searchCount;
    totalBucket.costUsd += record.costUsd ?? 0;
    totalBucket.listCostUsd += record.listCostUsd ?? 0;
    totalBucket.allowanceUsd += record.allowanceUsd ?? 0;
    if (record.missingUsage) {
      totalBucket.missingUsage++;
    }
    if (record.estimated) {
      totalBucket.estimatedRequests++;
    }
    if (!record.missingUsage && record.costUsd === null && record.listCostUsd === null) {
      totalBucket.unpricedRequests++;
    }

    this.data.updatedAt = Date.now();
    this.data.priceVersion = UsagePricing.VERSION;
  }

  /** 保留最近约 400 天（按北京时间日期做字典序比较） */
  prune(todayKey: string = UsageTime.dateKey(Date.now())): number {
    const cutoff: string = UsageTime.addDays(todayKey, -(USAGE_RETENTION_DAYS - 1));
    const dates: string[] = Object.keys(this.data.days);
    let removed: number = 0;
    for (let i: number = 0; i < dates.length; i++) {
      if (dates[i] < cutoff) {
        delete this.data.days[dates[i]];
        removed++;
      }
    }
    return removed;
  }

  setBudget(budgetCny: number): void {
    this.data.meta.budgetCny = Math.max(0, Number.isFinite(budgetCny) ? budgetCny : 0);
    this.data.updatedAt = Date.now();
  }

  getBudget(): number {
    return this.data.meta.budgetCny;
  }

  setBalance(balance: UsageBalanceData | null): void {
    this.data.meta.balance = balance;
    this.data.meta.balanceAttemptAt = Date.now();
    this.data.meta.balanceError = '';
    this.data.updatedAt = Date.now();
  }

  setBalanceError(message: string): void {
    this.data.meta.balanceError = message;
    this.data.updatedAt = Date.now();
  }

  setBalanceAttempt(at: number): void {
    this.data.meta.balanceAttemptAt = at;
    this.data.updatedAt = Date.now();
  }

  snapshot(
    todayKey: string = UsageTime.dateKey(Date.now()),
    days: number = USAGE_HEATMAP_DAYS
  ): UsageSnapshotView {
    this.prune(todayKey);
    const startKey: string = UsageTime.addDays(todayKey, -(Math.max(1, days) - 1));
    const dayViews: UsageDayView[] = [];
    const monthKey: string = todayKey.substring(0, 7);
    const monthStart: string = monthKey + '-01';
    const monthByProvider: Record<string, UsageBucket> = {};
    const total: UsageBucket = emptyBucket();

    let cursor: string = startKey;
    while (cursor <= todayKey) {
      const day: UsageDay | undefined = this.data.days[cursor];
      if (day !== undefined) {
        const view: UsageDayView = { date: cursor, providers: {} };
        const providers: string[] = Object.keys(day.providers);
        for (let p: number = 0; p < providers.length; p++) {
          const provider: string = providers[p];
          const peak: UsageBucket = emptyBucket();
          const off: UsageBucket = emptyBucket();
          const models: Record<string, UsageModelDay> = day.providers[provider];
          const modelKeys: string[] = Object.keys(models);
          for (let m: number = 0; m < modelKeys.length; m++) {
            addBucket(peak, models[modelKeys[m]].peak);
            addBucket(off, models[modelKeys[m]].off);
          }
          if (peak.requests + off.requests > 0) {
            view.providers[provider] = {
              peak: UsageLedger.roundBucket(peak),
              off: UsageLedger.roundBucket(off)
            };
          }
          if (cursor >= monthStart) {
            if (!hasOwn(monthByProvider, provider)) {
              monthByProvider[provider] = emptyBucket();
            }
            addBucket(monthByProvider[provider], peak);
            addBucket(monthByProvider[provider], off);
          }
        }
        if (Object.keys(view.providers).length > 0) {
          dayViews.push(view);
        }
      }
      cursor = UsageTime.addDays(cursor, 1);
    }

    const totals: string[] = Object.keys(this.data.totals);
    for (let i: number = 0; i < totals.length; i++) {
      addBucket(total, this.data.totals[totals[i]]);
    }

    // 预算按「实际 + OpenCode 等价成本」的统一人民币口径计算
    let monthUsd: number = 0;
    const monthProviders: string[] = Object.keys(monthByProvider);
    for (let i: number = 0; i < monthProviders.length; i++) {
      monthUsd += UsagePricing.effectiveCostUsd(
        monthProviders[i],
        monthByProvider[monthProviders[i]]
      );
    }
    const monthCostCny: number = roundMoney(monthUsd * UsagePricing.USD_TO_CNY, 2);
    const budgetCny: number = roundMoney(this.data.meta.budgetCny, 2);

    const years: number[] = [];
    const startYear: number = parseInt(startKey.substring(0, 4), 10);
    const endYear: number = parseInt(todayKey.substring(0, 4), 10);
    for (let y: number = startYear; y <= endYear; y++) {
      years.push(y);
    }
    const coverage = UsageTime.holidayCoverage(years);

    return {
      generatedAt: Date.now(),
      today: todayKey,
      rangeStart: startKey,
      rangeEnd: todayKey,
      days: dayViews,
      monthByProvider: UsageLedger.roundProviderMap(monthByProvider),
      billingSources: this.data.meta.billingSources.slice(),
      balance: this.data.meta.balance,
      balanceError: this.data.meta.balanceError,
      budget: {
        monthlyCny: budgetCny,
        monthCostCny: monthCostCny,
        over: budgetCny > 0 && monthCostCny > budgetCny
      },
      totals: UsageLedger.roundBucket(total),
      price: {
        version: UsagePricing.VERSION,
        updatedAt: UsagePricing.UPDATED_AT,
        usdToCny: UsagePricing.USD_TO_CNY,
        exchangeUpdatedAt: UsagePricing.EXCHANGE_UPDATED_AT,
        peakRule: UsagePricing.PEAK_RULE,
        holidayYears: UsageTime.HOLIDAY_YEARS.slice(),
        missingHolidayYears: coverage.missing,
        searchCnyPerCall: UsagePricing.SEARCH_CNY_PER_CALL
      }
    };
  }

  dayDetail(dateKey: string): UsageDayDetailView {
    const day: UsageDay | undefined = this.data.days[dateKey];
    const out: UsageDayDetailView = { date: dateKey, models: [] };
    if (day === undefined) {
      return out;
    }
    const providers: string[] = Object.keys(day.providers);
    for (let p: number = 0; p < providers.length; p++) {
      const provider: string = providers[p];
      const models: Record<string, UsageModelDay> = day.providers[provider];
      const modelKeys: string[] = Object.keys(models);
      for (let m: number = 0; m < modelKeys.length; m++) {
        const model: string = modelKeys[m];
        const entry: UsageModelDay = models[model];
        out.models.push({
          provider: provider,
          model: model,
          billingSources: entry.billingSources.slice(),
          peak: UsageLedger.roundBucket(entry.peak),
          off: UsageLedger.roundBucket(entry.off)
        });
      }
    }
    out.models.sort((a: UsageDayModelView, b: UsageDayModelView): number => {
      const ar: number = a.peak.requests + a.off.requests;
      const br: number = b.peak.requests + b.off.requests;
      if (ar !== br) {
        return br - ar;
      }
      const ac: number = a.peak.costUsd + a.off.costUsd + a.peak.listCostUsd + a.off.listCostUsd;
      const bc: number = b.peak.costUsd + b.off.costUsd + b.peak.listCostUsd + b.off.listCostUsd;
      return bc - ac;
    });
    return out;
  }

  /** 按日明细 CSV（每行 = 日期 × 服务商 × 模型 × 峰/谷） */
  csv(): string {
    const header: string[] = [
      'date',
      'provider',
      'model',
      'period',
      'requests',
      'input_hit',
      'input_miss',
      'cache_write',
      'output',
      'search_count',
      'cost_cny',
      'list_cost_cny',
      'allowance_usd',
      'billing_sources',
      'missing_usage',
      'estimated_requests',
      'unpriced_requests'
    ];
    const rows: string[] = [header.join(',')];
    const dates: string[] = Object.keys(this.data.days).sort();
    for (let d: number = 0; d < dates.length; d++) {
      const dateKey: string = dates[d];
      const day: UsageDay = this.data.days[dateKey];
      const providers: string[] = Object.keys(day.providers).sort();
      for (let p: number = 0; p < providers.length; p++) {
        const provider: string = providers[p];
        const models: Record<string, UsageModelDay> = day.providers[provider];
        const modelKeys: string[] = Object.keys(models).sort();
        for (let m: number = 0; m < modelKeys.length; m++) {
          const model: string = modelKeys[m];
          const entry: UsageModelDay = models[model];
          const periods: Array<{ name: string; bucket: UsageBucket }> = [
            { name: 'peak', bucket: entry.peak },
            { name: 'off', bucket: entry.off }
          ];
          for (let pi: number = 0; pi < periods.length; pi++) {
            const bucket: UsageBucket = periods[pi].bucket;
            if (bucket.requests <= 0) {
              continue;
            }
            rows.push([
              dateKey,
              provider,
              UsageLedger.csvCell(model),
              periods[pi].name,
              bucket.requests.toString(),
              bucket.inputHit.toString(),
              bucket.inputMiss.toString(),
              bucket.cacheWrite.toString(),
              bucket.output.toString(),
              bucket.searchCount.toString(),
              roundMoney(bucket.costUsd * UsagePricing.USD_TO_CNY, 6).toString(),
              roundMoney(bucket.listCostUsd * UsagePricing.USD_TO_CNY, 6).toString(),
              roundMoney(bucket.allowanceUsd, 6).toString(),
              UsageLedger.csvCell(entry.billingSources.join('|')),
              bucket.missingUsage.toString(),
              bucket.estimatedRequests.toString(),
              bucket.unpricedRequests.toString()
            ].join(','));
          }
        }
      }
    }
    return rows.join('\n');
  }

  runStatsFor(record: UsageRecord, stats: UsageRunStats): void {
    stats.lastAt = record.startedAt;
    stats.requests++;
    stats.inputHit += record.inputHit;
    stats.inputMiss += record.inputMiss;
    stats.cacheWrite += record.cacheWrite;
    stats.output += record.output;
    stats.costUsd += record.costUsd ?? 0;
    stats.listCostUsd += record.listCostUsd ?? 0;
    stats.allowanceUsd += record.allowanceUsd ?? 0;
    if (record.missingUsage) {
      stats.missingUsage++;
    }
    if (!record.missingUsage && record.costUsd === null && record.listCostUsd === null) {
      stats.unpricedRequests++;
    }
  }

  static runCostCny(stats: UsageRunStats, provider: string = UsageProvider.OTHER): number {
    // DeepSeek 的 cost 与 list_cost 相同；OpenCode 套餐 cost 可能为 0，
    // 这时用等价按量成本参与「本轮费用」展示。
    const usd: number = stats.listCostUsd > 0 ? stats.listCostUsd : stats.costUsd;
    return roundMoney(usd * UsagePricing.USD_TO_CNY, 4);
  }

  static runTokens(stats: UsageRunStats): number {
    return stats.inputHit + stats.inputMiss + stats.cacheWrite + stats.output;
  }

  private static csvCell(value: string): string {
    const text: string = value ?? '';
    if (text.indexOf(',') >= 0 || text.indexOf('"') >= 0 || text.indexOf('\n') >= 0) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  private static roundProviderMap(
    source: Record<string, UsageBucket>
  ): Record<string, UsageBucket> {
    const out: Record<string, UsageBucket> = {};
    const keys: string[] = Object.keys(source);
    for (let i: number = 0; i < keys.length; i++) {
      out[keys[i]] = UsageLedger.roundBucket(source[keys[i]]);
    }
    return out;
  }

  private static roundBucket(bucket: UsageBucket): UsageBucket {
    const out: UsageBucket = cloneBucket(bucket);
    out.costUsd = roundMoney(out.costUsd);
    out.listCostUsd = roundMoney(out.listCostUsd);
    out.allowanceUsd = roundMoney(out.allowanceUsd);
    return out;
  }
}

/** 供 UI 直接展示的「本轮」派生值（不落盘） */
export interface UsageRunView {
  costCny: number;
  tokens: number;
  requests: number;
  missingUsage: number;
  unpricedRequests: number;
}

export class UsageRunTracker {
  private static runs: Map<string, UsageRunStats> = new Map();

  static begin(sessionId: string): void {
    if (sessionId === '') {
      return;
    }
    UsageRunTracker.runs.set(sessionId, emptyRunStats(Date.now()));
  }

  static end(sessionId: string): void {
    // 保留最后一次汇总供「本轮统计」读取；下一次 begin 覆盖。
    // end 之后由标题生成等异步请求产生的记录不再计入这一轮，避免串到下一次运行。
    if (sessionId === '') {
      return;
    }
    const stats: UsageRunStats | undefined = UsageRunTracker.runs.get(sessionId);
    if (stats !== undefined) {
      stats.ended = true;
    }
  }

  static record(sessionId: string, record: UsageRecord): void {
    if (sessionId === '') {
      return;
    }
    let stats: UsageRunStats | undefined = UsageRunTracker.runs.get(sessionId);
    if (stats === undefined || stats.ended) {
      // 没有显式 begin（例如标题生成）或本轮已收尾时不累计；
      // 日聚合仍然照常记录，页面上的总额不受影响。
      return;
    }
    const ledger: UsageLedger = UsageRunTracker.scratch;
    ledger.runStatsFor(record, stats);
  }

  static view(sessionId: string): UsageRunView {
    const stats: UsageRunStats | undefined = UsageRunTracker.runs.get(sessionId);
    if (stats === undefined) {
      return { costCny: 0, tokens: 0, requests: 0, missingUsage: 0, unpricedRequests: 0 };
    }
    return {
      costCny: UsageLedger.runCostCny(stats, UsageProvider.OTHER),
      tokens: UsageLedger.runTokens(stats),
      requests: stats.requests,
      missingUsage: stats.missingUsage,
      unpricedRequests: stats.unpricedRequests
    };
  }

  static forget(sessionId: string): void {
    UsageRunTracker.runs.delete(sessionId);
  }

  static clearAll(): void {
    UsageRunTracker.runs.clear();
  }

  // 仅用于复用 runStatsFor / runCostCny 的纯计算，不持有任何数据
  private static readonly scratch: UsageLedger = UsageLedger.createEmpty(0);
}

export { totalTokens };
