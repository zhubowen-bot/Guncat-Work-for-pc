// 用量统计纯逻辑回归：三协议归一化、DeepSeek 峰谷边界、节假日/跨天/UTC+8、
// OpenCode 网关字段、日聚合/裁剪/CSV、缺失 usage 降级。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initAppPaths } from '../src/core/platform/appPaths'
import { UsagePricing } from '../src/core/usage/UsagePricing'
import { UsageLedger } from '../src/core/usage/UsageLedger'
import { UsageService } from '../src/core/usage/UsageService'
import {
  UsageProvider,
  UsageTime,
  emptyBucket,
  totalTokens
} from '../src/core/usage/UsageTypes'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/** 北京时间 → 毫秒时间戳（测试专用，不依赖本机时区） */
function bj(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0)
}

function near(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) <= epsilon
}

function main(): void {
  // ===== 1. 三协议归一化 =====
  section('1. 三协议 usage 归一化')
  const anthropic = UsagePricing.normalize('anthropic', {
    input_tokens: 100,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 50,
    output_tokens: 20
  })
  check('Anthropic 命中 = cache_read_input_tokens', anthropic.inputHit === 400)
  check('Anthropic 未命中 = input_tokens（不含命中）', anthropic.inputMiss === 100)
  check('Anthropic cacheWrite = cache_creation_input_tokens', anthropic.cacheWrite === 50)
  check('Anthropic 输出 = output_tokens', anthropic.output === 20)
  check(
    'Anthropic 总输入 = 命中 + 未命中 + cacheWrite',
    anthropic.inputHit + anthropic.inputMiss + anthropic.cacheWrite === 550
  )

  const responses = UsagePricing.normalize('responses', {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens: 30
  })
  check('Responses 命中 = cached_tokens', responses.inputHit === 40)
  check('Responses 未命中 = input_tokens - cached_tokens', responses.inputMiss === 60)
  check('Responses 输出 = output_tokens', responses.output === 30)

  const completionsNative = UsagePricing.normalize('completions', {
    prompt_tokens: 100,
    prompt_cache_hit_tokens: 70,
    prompt_cache_miss_tokens: 30,
    completion_tokens: 10
  })
  check('Completions 优先 prompt_cache_hit_tokens', completionsNative.inputHit === 70)
  check('Completions 优先 prompt_cache_miss_tokens', completionsNative.inputMiss === 30)

  const completionsFallback = UsagePricing.normalize('completions', {
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 25 },
    completion_tokens: 12
  })
  check('Completions 无原生分列时用 cached_tokens', completionsFallback.inputHit === 25)
  check('Completions 未命中 = prompt_tokens - cached', completionsFallback.inputMiss === 75)

  // ===== 2. 峰谷边界 =====
  section('2. DeepSeek 峰谷边界（北京时间）')
  const day = [2026, 11, 5] as const
  const cases: Array<[number, number, boolean, string]> = [
    [8, 59, false, '08:59 空闲'],
    [9, 0, true, '09:00 高峰'],
    [11, 59, true, '11:59 高峰'],
    [12, 0, false, '12:00 空闲'],
    [13, 59, false, '13:59 空闲'],
    [14, 0, true, '14:00 高峰'],
    [17, 59, true, '17:59 高峰'],
    [18, 0, false, '18:00 空闲']
  ]
  for (const [hour, minute, expected, label] of cases) {
    check(label, UsageTime.isPeak(bj(day[0], day[1], day[2], hour, minute)) === expected)
  }

  check(
    '周末全天空闲（周六 10:00）',
    UsageTime.isPeak(bj(2026, 11, 7, 10, 0)) === false
  )
  check(
    '法定节假日全天空闲（2026-10-01 10:00）',
    UsageTime.isPeak(bj(2026, 10, 1, 10, 0)) === false
  )
  check(
    '春节假期空闲（2026-02-17 10:00）',
    UsageTime.isPeak(bj(2026, 2, 17, 10, 0)) === false
  )

  // 缺失年份按工作日高峰保守估算
  const missingYearMs = bj(2031, 1, 6, 10, 0)
  const missingWeekday = UsageTime.weekdayIndex(missingYearMs)
  check(
    '缺失年份按工作日高峰估算（2031-01-06）',
    UsageTime.isPeak(missingYearMs) === (missingWeekday < 5),
    `weekdayIndex=${missingWeekday}`
  )
  check(
    '缺失年份在页面可被识别',
    UsageTime.holidayCoverage([2026, 2031]).missing.indexOf(2031) >= 0
  )

  // ===== 3. 归日 / 跨天 / UTC+8 =====
  section('3. 北京时间归日与跨天')
  check(
    'UTC 16:30 归到次日（UTC+8）',
    UsageTime.dateKey(Date.UTC(2026, 10, 4, 16, 30)) === '2026-11-05'
  )
  const lateNight = bj(2026, 11, 5, 23, 59)
  check('23:59 归当天', UsageTime.dateKey(lateNight) === '2026-11-05')
  check('23:59 为空闲', UsageTime.isPeak(lateNight) === false)
  const nextDay = bj(2026, 11, 6, 0, 1)
  check('跨天请求归次日', UsageTime.dateKey(nextDay) === '2026-11-06')

  // ===== 4. 服务商识别与 OpenCode =====
  section('4. 服务商识别与 OpenCode 字段')
  check(
    'DeepSeek 按 Base URL 识别',
    UsagePricing.detectProvider('https://api.deepseek.com') === UsageProvider.DEEPSEEK
  )
  check(
    'OpenCode Go 按 Base URL 识别',
    UsagePricing.detectProvider('https://opencode.ai/inference/go/anthropic') ===
      UsageProvider.OPENCODE_GO
  )
  check(
    'OpenCode 不按模型名套 DeepSeek 峰谷价',
    UsagePricing.detectProvider('https://example.com/v1') === UsageProvider.OTHER
  )
  const opencode = UsagePricing.buildRecord({
    baseUrl: 'https://opencode.ai/inference/go/anthropic',
    model: 'deepseek-v4.1-flash',
    protocol: 'anthropic',
    startedAt: bj(2026, 11, 5, 10, 0),
    sessionId: '',
    usage: {
      opencode: {
        tokens: { input: 100, output: 20, cache_read: 300, cache_write: 10 },
        allowance: 0.12,
        cost: 0,
        list_cost: 0.8,
        billing_source: 'go'
      }
    }
  })
  check('OpenCode 命中 = cache_read', opencode.inputHit === 300)
  check('OpenCode 未命中 = input', opencode.inputMiss === 100)
  check('OpenCode cacheWrite = cache_write', opencode.cacheWrite === 10)
  check('OpenCode allowance 保留', opencode.allowanceUsd === 0.12)
  check('OpenCode cost 保留 0', opencode.costUsd === 0)
  check('OpenCode list_cost 保留', opencode.listCostUsd === 0.8)
  check('OpenCode billing_source 保留', opencode.billingSource === 'go')
  check('OpenCode 不按 DeepSeek 峰谷价估算', opencode.estimated === false)

  // ===== 5. DeepSeek 计价 =====
  section('5. DeepSeek 峰谷计价与搜索')
  const deepseekUsage = {
    prompt_cache_hit_tokens: 1000000,
    prompt_cache_miss_tokens: 1000000,
    completion_tokens: 1000000,
    server_tool_use: { web_search_requests: 1 }
  }
  const peakRecord = UsagePricing.buildRecord({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    protocol: 'completions',
    startedAt: bj(2026, 11, 5, 10, 0),
    usage: deepseekUsage,
    sessionId: ''
  })
  const peakCny = (peakRecord.costUsd ?? 0) * UsagePricing.USD_TO_CNY
  check(
    'Flash 高峰 1M 命中+1M 未命中+1M 输出+1 次搜索 = 10.045 元',
    near(peakCny, 10.045, 1e-9),
    peakCny.toFixed(6)
  )
  check('DeepSeek 本地计价标记 estimated', peakRecord.estimated === true)

  const offRecord = UsagePricing.buildRecord({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    protocol: 'completions',
    startedAt: bj(2026, 11, 5, 20, 0),
    usage: deepseekUsage,
    sessionId: ''
  })
  const offCny = (offRecord.costUsd ?? 0) * UsagePricing.USD_TO_CNY
  check(
    'Flash 空闲同量 = 5.025 元（半价 + 搜索）',
    near(offCny, 5.025, 1e-9),
    offCny.toFixed(6)
  )

  const proRecord = UsagePricing.buildRecord({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    protocol: 'anthropic',
    startedAt: bj(2026, 11, 5, 10, 0),
    usage: {
      input_tokens: 0,
      cache_read_input_tokens: 1000000,
      cache_creation_input_tokens: 0,
      output_tokens: 0
    },
    sessionId: ''
  })
  check(
    'Pro 高峰命中 1M = 0.30 元',
    near((proRecord.costUsd ?? 0) * UsagePricing.USD_TO_CNY, 0.3, 1e-9)
  )

  // ===== 6. 日聚合 / 裁剪 / CSV / 缺失 usage =====
  section('6. 日聚合、裁剪、CSV 与缺失 usage')
  const ledger = UsageLedger.createEmpty(0)
  ledger.record(peakRecord)
  ledger.record(offRecord)

  const detail = ledger.dayDetail('2026-11-05')
  check('日明细按模型返回', detail.models.length === 1 && detail.models[0].model === 'deepseek-flash')
  check('峰时桶 1 次请求', detail.models[0].peak.requests === 1)
  check('空闲桶 1 次请求', detail.models[0].off.requests === 1)
  check(
    '峰谷 token 合计正确',
    totalTokens(detail.models[0].peak) + totalTokens(detail.models[0].off) === 6000000
  )

  const missingRecord = UsagePricing.buildRecord({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    protocol: 'completions',
    startedAt: bj(2026, 11, 5, 11, 0),
    usage: null,
    sessionId: ''
  })
  check('缺失 usage 被标记', missingRecord.missingUsage === true)
  check('缺失 usage 不猜测成本', missingRecord.costUsd === null)
  ledger.record(missingRecord)
  const afterMissing = ledger.dayDetail('2026-11-05')
  check('缺失 usage 计入请求数', afterMissing.models[0].peak.requests + afterMissing.models[0].off.requests === 3)
  check(
    '缺失 usage 单独计数',
    afterMissing.models[0].peak.missingUsage + afterMissing.models[0].off.missingUsage === 1
  )

  // 加一条 400 天前的数据，验证裁剪
  const oldRecord = UsagePricing.buildRecord({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    protocol: 'completions',
    startedAt: bj(2025, 9, 1, 10, 0),
    usage: { prompt_tokens: 10, completion_tokens: 2 },
    sessionId: ''
  })
  ledger.record(oldRecord)
  const removed = ledger.prune('2026-11-05')
  check('超过 400 天的日聚合被裁剪', removed >= 1 && ledger.data.days['2025-09-01'] === undefined)
  check('最近一天保留', ledger.data.days['2026-11-05'] !== undefined)

  const snapshot = ledger.snapshot('2026-11-05')
  check('快照只含最近 371 天范围', snapshot.rangeStart === '2025-10-31')
  check('快照含今天数据', snapshot.days.some((d) => d.date === '2026-11-05'))
  check('全量累计保留裁剪前的请求', snapshot.totals.requests === 4)

  const csv = ledger.csv()
  check('CSV 带表头', csv.split('\n')[0].indexOf('date,provider,model,period') === 0)
  check('CSV 含峰/谷行', csv.indexOf(',peak,') >= 0 && csv.indexOf(',off,') >= 0)
  check('CSV 含模型名', csv.indexOf('deepseek-flash') >= 0)

  // ===== 7. 边界杂项 =====
  section('7. 其它边界')
  check(
    '未知服务商不猜测成本',
    UsagePricing.buildRecord({
      baseUrl: 'https://example.com/v1',
      model: 'foo',
      protocol: 'completions',
      startedAt: Date.now(),
      usage: { prompt_tokens: 10, completion_tokens: 2 },
      sessionId: ''
    }).costUsd === null
  )
  check(
    '已知端点才补 stream_options.include_usage',
    UsagePricing.supportsIncludeUsage('https://api.deepseek.com') === true &&
      UsagePricing.supportsIncludeUsage('https://example.com/v1') === false
  )
  check(
    'Anthropic message_start usage 可被提取',
    // 解析器本身在 ChatService，这里用归一化验证嵌套输入不会丢
    UsagePricing.normalize('anthropic', {
      input_tokens: 10,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 0,
      output_tokens: 5
    }).inputHit === 90
  )
  const empty = emptyBucket()
  check('空桶请求数为 0', empty.requests === 0 && totalTokens(empty) === 0)

  // ===== 8. 落盘与服务层 =====
  section('8. 原子落盘与余额解析')
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guncat-usage-'))
  try {
    initAppPaths({ dataRoot, resourcesRoot: path.resolve('resources') })
    UsageService.record({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      protocol: 'completions',
      startedAt: bj(2026, 11, 5, 10, 0),
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      sessionId: 'smoke-session'
    })
    UsageService.flushSync()
    const file = UsageService.filePath()
    check('用量文件写在应用私有目录', fs.existsSync(file), file)
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    check('文件带 version', persisted.version === 1)
    check('文件包含日聚合与全量累计', typeof persisted.days === 'object' && typeof persisted.totals === 'object')
    const balance = UsageService.parseBalance({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }
      ]
    })
    check(
      'DeepSeek 余额响应解析',
      balance !== null &&
        balance.currency === 'CNY' &&
        near(balance.total, 12.34) &&
        near(balance.granted, 2) &&
        near(balance.toppedUp, 10.34)
    )
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  if (failed > 0) {
    console.log('失败项:\n' + failures.map((f) => `  - ${f}`).join('\n'))
    process.exitCode = 1
  }
}

main()
