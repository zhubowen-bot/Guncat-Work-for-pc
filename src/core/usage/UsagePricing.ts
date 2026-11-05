// 三协议 usage 归一化 + DeepSeek 峰谷计价 + OpenCode 网关字段解析。
//
// 关键口径（不要混）：
//   Anthropic       input_tokens 不含缓存命中；命中在 cache_read_input_tokens
//   OpenAI Responses input_tokens 含缓存命中；命中在 input_tokens_details.cached_tokens
//   Completions     优先 prompt_cache_hit_tokens / prompt_cache_miss_tokens
//   OpenCode        优先 usage.opencode.tokens，并读取 allowance / cost / list_cost / billing_source
//
// 所有函数都是纯函数，单次请求只做一次 O(1) 解析，不触碰 token 流。
import {
  NormalizedUsage,
  UsageBucket,
  UsageProvider,
  UsageRecord,
  UsageTime,
  emptyBucket
} from './UsageTypes';

interface TokenPrice {
  hit: number;
  miss: number;
  output: number;
}

interface DeepSeekPrice {
  peak: TokenPrice;
  off: TokenPrice;
}

export interface BuildUsageInput {
  baseUrl: string;
  model: string;
  protocol: string;
  startedAt: number;
  usage: Record<string, Object> | null;
  sessionId: string;
}

export class UsagePricing {
  /** 价目表版本；改价时必须一起改 updatedAt，页面底部会原样展示 */
  static readonly VERSION: string = 'deepseek-cn-2026-08-17';
  static readonly UPDATED_AT: string = '2026-08-17';
  /** 参考汇率：只用于统一展示，不做任何交易/结算 */
  static readonly USD_TO_CNY: number = 7.2;
  static readonly EXCHANGE_UPDATED_AT: string = '2026-11-01';
  /** 服务端联网搜索/抓取：5 元 / 1000 次 */
  static readonly SEARCH_CNY_PER_CALL: number = 5 / 1000;
  static readonly PEAK_RULE: string =
    '北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰；其余时段、周末与法定节假日为空闲。';
  /** 缓存/搜索价目按人民币计，内部统一折算成 USD 存储，展示时再折回人民币 */
  private static readonly DEEPSEEK_PRICES: Record<string, DeepSeekPrice> = {
    flash: {
      peak: { hit: 0.04, miss: 2, output: 8 },
      off: { hit: 0.02, miss: 1, output: 4 }
    },
    pro: {
      peak: { hit: 0.30, miss: 9, output: 27 },
      off: { hit: 0.15, miss: 4.5, output: 13.5 }
    }
  };

  /**
   * 按 Base URL 判定服务商。
   * OpenCode Go 必须优先用地址区分，不能按模型名套 DeepSeek 峰谷价。
   */
  static detectProvider(baseUrl: string): string {
    const host: string = UsagePricing.hostOf(baseUrl);
    const path: string = UsagePricing.pathOf(baseUrl);
    if (host.indexOf('opencode.ai') >= 0 && path.indexOf('/inference/go') >= 0) {
      return UsageProvider.OPENCODE_GO;
    }
    if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) {
      return UsageProvider.DEEPSEEK;
    }
    return UsageProvider.OTHER;
  }

  static hostOf(baseUrl: string): string {
    const raw: string = (baseUrl ?? '').trim().toLowerCase();
    if (raw === '') {
      return '';
    }
    try {
      return new URL(raw).host.toLowerCase();
    } catch {
      const m: RegExpMatchArray | null = /^[a-z]+:\/\/([^/]+)/i.exec(raw);
      return m === null ? '' : m[1].toLowerCase();
    }
  }

  static pathOf(baseUrl: string): string {
    const raw: string = (baseUrl ?? '').trim();
    if (raw === '') {
      return '';
    }
    try {
      return new URL(raw).pathname.toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }

  /**
   * 是否给 Chat Completions 请求补 stream_options.include_usage。
   *
   * 只在已知支持该字段的端点开启：部分严格网关会把未知请求字段直接判 400，
   * 为了统计把聊天打挂是不可接受的。未知服务商宁可不带，页面会如实显示缺失 usage。
   */
  static supportsIncludeUsage(baseUrl: string): boolean {
    const host: string = UsagePricing.hostOf(baseUrl);
    if (host === '') {
      return false;
    }
    return (
      host === 'api.openai.com' ||
      host === 'api.deepseek.com' ||
      host.endsWith('.openai.azure.com') ||
      host === 'openrouter.ai' ||
      host === 'api.siliconflow.cn' ||
      host === 'api.moonshot.cn' ||
      host === 'ark.cn-beijing.volces.com' ||
      host === 'open.bigmodel.cn'
    );
  }

  static deepseekPrice(model: string): DeepSeekPrice | null {
    const name: string = (model ?? '').toLowerCase();
    if (name.indexOf('pro') >= 0) {
      return UsagePricing.DEEPSEEK_PRICES.pro;
    }
    if (name.indexOf('flash') >= 0) {
      return UsagePricing.DEEPSEEK_PRICES.flash;
    }
    return null;
  }

  /**
   * 合并同一请求的多条 usage 事件（Anthropic 的 message_start 带输入、
   * message_delta 带输出；流式网关也可能分多次下发）。数值取 max，避免把
   * 累计值当成增量再加一遍。
   */
  static mergeUsage(
    prev: Record<string, Object> | null,
    next: Record<string, Object> | null
  ): Record<string, Object> | null {
    if (next === null) {
      return prev;
    }
    if (prev === null) {
      return next;
    }
    const out: Record<string, Object> = { ...prev };
    const keys: string[] = Object.keys(next);
    for (let i: number = 0; i < keys.length; i++) {
      const key: string = keys[i];
      const a: Object = out[key];
      const b: Object = next[key];
      if (typeof a === 'number' && typeof b === 'number') {
        out[key] = Math.max(a as number, b as number);
      } else if (UsagePricing.isRecord(a) && UsagePricing.isRecord(b)) {
        out[key] = UsagePricing.mergeUsage(a as Record<string, Object>, b as Record<string, Object>);
      } else {
        out[key] = b;
      }
    }
    return out;
  }

  /**
   * 三协议 + OpenCode 统一归一化。
   * reasoning 已包含在 output 里，不额外加；cache read / write 只在输入侧。
   */
  static normalize(protocol: string, usage: Record<string, Object> | null): NormalizedUsage {
    const result: NormalizedUsage = {
      inputHit: 0,
      inputMiss: 0,
      cacheWrite: 0,
      output: 0,
      searchCount: 0,
      allowanceUsd: null,
      costUsd: null,
      listCostUsd: null,
      billingSource: '',
      missingUsage: false
    };
    if (usage === null) {
      result.missingUsage = true;
      return result;
    }
    const opencode: Record<string, Object> | null = UsagePricing.recordOf(usage['opencode']);
    let hasToken: boolean = false;

    if (opencode !== null) {
      const tokens: Record<string, Object> =
        UsagePricing.recordOf(opencode['tokens']) ?? opencode;
      const input: number | null = UsagePricing.pickNumber(tokens, [
        'input',
        'input_tokens',
        'prompt_tokens'
      ]);
      const hit: number | null = UsagePricing.pickNumber(tokens, [
        'cache_read',
        'cache_read_input_tokens',
        'cached_tokens',
        'input_hit'
      ]);
      const cacheWrite: number | null = UsagePricing.pickNumber(tokens, [
        'cache_write',
        'cache_creation_input_tokens',
        'cache_write_tokens'
      ]);
      const output: number | null = UsagePricing.pickNumber(tokens, [
        'output',
        'output_tokens',
        'completion_tokens'
      ]);
      if (input !== null || hit !== null || cacheWrite !== null || output !== null) {
        hasToken = true;
      }
      result.inputHit = hit ?? 0;
      result.inputMiss = input ?? 0;
      result.cacheWrite = cacheWrite ?? 0;
      result.output = output ?? 0;
      result.allowanceUsd = UsagePricing.pickNumber(opencode, [
        'allowance',
        'allowance_usd',
        'allowance_cost'
      ]);
      result.costUsd = UsagePricing.pickNumber(opencode, ['cost', 'cost_usd']);
      result.listCostUsd = UsagePricing.pickNumber(opencode, [
        'list_cost',
        'list_cost_usd',
        'listCost'
      ]);
      const source: Object = opencode['billing_source'] ?? opencode['billingSource'];
      if (typeof source === 'string') {
        result.billingSource = source as string;
      }
    } else if (protocol === 'anthropic') {
      const hit: number | null = UsagePricing.numberOrNull(usage['cache_read_input_tokens']);
      const miss: number | null = UsagePricing.numberOrNull(usage['input_tokens']);
      const cacheWrite: number | null = UsagePricing.numberOrNull(usage['cache_creation_input_tokens']);
      const output: number | null = UsagePricing.numberOrNull(usage['output_tokens']);
      if (hit !== null || miss !== null || cacheWrite !== null || output !== null) {
        hasToken = true;
      }
      result.inputHit = hit ?? 0;
      result.inputMiss = miss ?? 0;
      result.cacheWrite = cacheWrite ?? 0;
      result.output = output ?? 0;
    } else if (protocol === 'responses') {
      const input: number | null =
        UsagePricing.numberOrNull(usage['input_tokens']) ??
        UsagePricing.numberOrNull(usage['prompt_tokens']);
      const details: Record<string, Object> | null =
        UsagePricing.recordOf(usage['input_tokens_details']) ??
        UsagePricing.recordOf(usage['prompt_tokens_details']);
      const cached: number | null = details === null
        ? null
        : UsagePricing.numberOrNull(details['cached_tokens']);
      const output: number | null =
        UsagePricing.numberOrNull(usage['output_tokens']) ??
        UsagePricing.numberOrNull(usage['completion_tokens']);
      if (input !== null || cached !== null || output !== null) {
        hasToken = true;
      }
      result.inputHit = cached ?? 0;
      // Responses 的 input_tokens 含缓存命中，未命中必须相减
      result.inputMiss = Math.max(0, (input ?? result.inputHit) - result.inputHit);
      result.output = output ?? 0;
    } else {
      const prompt: number | null =
        UsagePricing.numberOrNull(usage['prompt_tokens']) ??
        UsagePricing.numberOrNull(usage['input_tokens']);
      const hitRaw: number | null = UsagePricing.numberOrNull(usage['prompt_cache_hit_tokens']);
      const missRaw: number | null = UsagePricing.numberOrNull(usage['prompt_cache_miss_tokens']);
      const details: Record<string, Object> | null =
        UsagePricing.recordOf(usage['prompt_tokens_details']) ??
        UsagePricing.recordOf(usage['input_tokens_details']);
      const cached: number | null = details === null
        ? null
        : UsagePricing.numberOrNull(details['cached_tokens']);
      const cacheWrite: number | null = details === null
        ? null
        : UsagePricing.numberOrNull(details['cache_creation_tokens']);
      const output: number | null =
        UsagePricing.numberOrNull(usage['completion_tokens']) ??
        UsagePricing.numberOrNull(usage['output_tokens']);
      if (
        prompt !== null ||
        hitRaw !== null ||
        missRaw !== null ||
        cached !== null ||
        output !== null
      ) {
        hasToken = true;
      }
      if (hitRaw !== null && missRaw !== null) {
        // DeepSeek 原生：命中/未命中原生分列，不再做减法
        result.inputHit = hitRaw;
        result.inputMiss = missRaw;
      } else {
        const hit: number = cached ?? hitRaw ?? 0;
        result.inputHit = hit;
        // 拿不到 prompt_tokens 时只能把 cached 当全部输入，miss 为 0
        result.inputMiss = Math.max(0, (prompt ?? hit) - hit);
      }
      result.cacheWrite = cacheWrite ?? 0;
      result.output = output ?? 0;
    }

    result.searchCount = UsagePricing.parseSearchCount(usage);
    result.missingUsage = !hasToken;
    return result;
  }

  /** 服务端 web_search / web_fetch 次数（只读，不混进 token 公式） */
  static parseSearchCount(usage: Record<string, Object> | null): number {
    if (usage === null) {
      return 0;
    }
    let total: number = 0;
    const server: Record<string, Object> | null = UsagePricing.recordOf(usage['server_tool_use']);
    if (server !== null) {
      total += UsagePricing.pickNumber(server, ['web_search_requests', 'web_search', 'search_count']) ?? 0;
      total += UsagePricing.pickNumber(server, ['web_fetch_requests', 'web_fetch', 'fetch_count']) ?? 0;
    }
    total += UsagePricing.pickNumber(usage, ['web_search_count', 'server_search_count']) ?? 0;
    return total;
  }

  /**
   * 构造一条记账记录。
   * DeepSeek 按 startAt 的峰谷与模型价目表本地计价；OpenCode 只认网关给的
   * allowance / cost / list_cost，绝不按模型名套 DeepSeek 价。
   */
  static buildRecord(input: BuildUsageInput): UsageRecord {
    const provider: string = UsagePricing.detectProvider(input.baseUrl);
    const normalized: NormalizedUsage = UsagePricing.normalize(input.protocol, input.usage);
    let costUsd: number | null = normalized.costUsd;
    let listCostUsd: number | null = normalized.listCostUsd;
    let estimated: boolean = false;

    if (provider === UsageProvider.DEEPSEEK) {
      const price: DeepSeekPrice | null = UsagePricing.deepseekPrice(input.model);
      if (price !== null && !normalized.missingUsage) {
        const table: TokenPrice = UsagePricing.isPeak(input.startedAt) ? price.peak : price.off;
        const cny: number =
          (normalized.inputHit / 1000000) * table.hit +
          (normalized.inputMiss / 1000000) * table.miss +
          // cacheWrite 是「新写入缓存」的输入，按未命中输入计价，避免低估；
          // DeepSeek 官方价目表没有单列 cache write 价格。
          (normalized.cacheWrite / 1000000) * table.miss +
          (normalized.output / 1000000) * table.output +
          normalized.searchCount * UsagePricing.SEARCH_CNY_PER_CALL;
        costUsd = cny / UsagePricing.USD_TO_CNY;
        listCostUsd = costUsd;
        estimated = true;
      } else {
        costUsd = null;
        listCostUsd = null;
      }
    } else if (provider === UsageProvider.OPENCODE_GO) {
      // Go 套餐内 cost 可能为 0，allowance 才是额度消耗；list_cost 是等价按量成本
      estimated = normalized.costUsd === null && normalized.listCostUsd === null && !normalized.missingUsage;
    } else {
      costUsd = null;
      listCostUsd = null;
    }

    return {
      startedAt: input.startedAt,
      provider: provider,
      model: (input.model ?? '').trim() === '' ? '未知模型' : input.model.trim(),
      protocol: input.protocol,
      inputHit: normalized.inputHit,
      inputMiss: normalized.inputMiss,
      cacheWrite: normalized.cacheWrite,
      output: normalized.output,
      searchCount: normalized.searchCount,
      allowanceUsd: normalized.allowanceUsd,
      costUsd: costUsd,
      listCostUsd: listCostUsd,
      billingSource: normalized.billingSource,
      estimated: estimated,
      missingUsage: normalized.missingUsage,
      sessionId: input.sessionId ?? ''
    };
  }

  static isPeak(startedAt: number): boolean {
    // 计价与归日共用同一套北京时间规则
    return UsageTime.isPeak(startedAt);
  }

  /** 实际计入对比的成本：OpenCode 优先用等价按量成本，套餐 cost=0 时热力图才有意义 */
  static effectiveCostUsd(provider: string, bucket: UsageBucket): number {
    if (provider === UsageProvider.OPENCODE_GO) {
      return bucket.listCostUsd > 0 ? bucket.listCostUsd : bucket.costUsd;
    }
    return bucket.costUsd;
  }

  static emptyBucket(): UsageBucket {
    return emptyBucket();
  }

  // ===== 小工具 =====

  static isRecord(value: Object): boolean {
    return typeof value === 'object' && value !== null && !(value instanceof Array);
  }

  static recordOf(value: Object | undefined | null): Record<string, Object> | null {
    if (!UsagePricing.isRecord(value as Object)) {
      return null;
    }
    return value as Record<string, Object>;
  }

  static numberOrNull(value: Object | undefined | null): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value as number;
    }
    if (typeof value === 'string') {
      const n: number = parseFloat(value as string);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  static pickNumber(obj: Record<string, Object>, keys: string[]): number | null {
    for (let i: number = 0; i < keys.length; i++) {
      const n: number | null = UsagePricing.numberOrNull(obj[keys[i]]);
      if (n !== null) {
        return n;
      }
    }
    return null;
  }
}
