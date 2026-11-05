// 独立「用量与成本」页：汇总卡 + 53 周热力图 + 日明细 + 服务商卡片 + 预算 + CSV。
//
// 性能说明：
//   · 页面打开时才向主进程要一次快照（本地日聚合，无网络）；
//   · 热力图只有 371 个格子，构建成本可忽略；逐日模型明细在点击某天时才拉；
//   · 不轮询、不定时刷新；DeepSeek 余额只在打开页（受节流）或手动刷新时请求。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  UsageBucketDto,
  UsageDayDetailDto,
  UsageDayDto,
  UsageSnapshotDto
} from '@ipc/contract'
import { useStore } from '../store'
import {
  IconArrowLeft,
  IconCalendar,
  IconClose,
  IconDownload,
  IconInfo,
  IconRefresh
} from '../icons'

type ProviderFilter = 'all' | 'deepseek' | 'opencode-go'
type Metric = 'cost' | 'tokens' | 'requests'

const PROVIDERS: Array<{ id: ProviderFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'opencode-go', label: 'OpenCode Go' }
]

const METRICS: Array<{ id: Metric; label: string }> = [
  { id: 'cost', label: '费用' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'requests', label: '请求数' }
]

const WEEK_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const WEEK_SHORT_LABELS = ['一', '', '三', '', '五', '', '日']

const EMPTY_BUCKET: UsageBucketDto = {
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
}

function addBucket(target: UsageBucketDto, source: UsageBucketDto | undefined): void {
  if (source === undefined) {
    return
  }
  target.requests += source.requests
  target.inputHit += source.inputHit
  target.inputMiss += source.inputMiss
  target.cacheWrite += source.cacheWrite
  target.output += source.output
  target.searchCount += source.searchCount
  target.costUsd += source.costUsd
  target.listCostUsd += source.listCostUsd
  target.allowanceUsd += source.allowanceUsd
  target.missingUsage += source.missingUsage
  target.estimatedRequests += source.estimatedRequests
  target.unpricedRequests += source.unpricedRequests
}

function bucketTokens(bucket: UsageBucketDto): number {
  return bucket.inputHit + bucket.inputMiss + bucket.cacheWrite + bucket.output
}

/** 与服务商口径一致：OpenCode 套餐 cost 可能为 0，用 list_cost 做等价比较 */
function bucketCostUsd(provider: string, bucket: UsageBucketDto): number {
  if (provider === 'opencode-go') {
    return bucket.listCostUsd > 0 ? bucket.listCostUsd : bucket.costUsd
  }
  return bucket.costUsd
}

function providerCostUsd(provider: string, bucket: UsageBucketDto): number {
  return bucketCostUsd(provider, bucket)
}

/** 某一天的聚合视图（按当前服务商筛选） */
interface DayAggregate {
  costUsd: number
  tokens: number
  requests: number
  allowanceUsd: number
  missingUsage: number
  inputHit: number
  inputMiss: number
  cacheWrite: number
  output: number
  searchCount: number
}

function emptyAggregate(): DayAggregate {
  return {
    costUsd: 0,
    tokens: 0,
    requests: 0,
    allowanceUsd: 0,
    missingUsage: 0,
    inputHit: 0,
    inputMiss: 0,
    cacheWrite: 0,
    output: 0,
    searchCount: 0
  }
}

function addDayToAggregate(
  aggregate: DayAggregate,
  provider: string,
  bucket: UsageBucketDto
): void {
  aggregate.costUsd += providerCostUsd(provider, bucket)
  aggregate.tokens += bucketTokens(bucket)
  aggregate.requests += bucket.requests
  aggregate.allowanceUsd += bucket.allowanceUsd
  aggregate.missingUsage += bucket.missingUsage
  aggregate.inputHit += bucket.inputHit
  aggregate.inputMiss += bucket.inputMiss
  aggregate.cacheWrite += bucket.cacheWrite
  aggregate.output += bucket.output
  aggregate.searchCount += bucket.searchCount
}

function isTrackedProvider(provider: string): boolean {
  return provider === 'deepseek' || provider === 'opencode-go'
}

function aggregateDay(day: UsageDayDto | undefined, filter: ProviderFilter): DayAggregate {
  const aggregate = emptyAggregate()
  if (day === undefined) {
    return aggregate
  }
  const providers = Object.keys(day.providers)
  for (const provider of providers) {
    // 「全部」= 两个预置服务商；多模态/表格识别等辅助调用留在账本里，
    // 不混进这两家的费用对比。
    if (!isTrackedProvider(provider)) {
      continue
    }
    if (filter !== 'all' && provider !== filter) {
      continue
    }
    const bucket = day.providers[provider]
    addDayToAggregate(aggregate, provider, bucket.peak)
    addDayToAggregate(aggregate, provider, bucket.off)
  }
  return aggregate
}

function aggregateFromMonth(
  snapshot: UsageSnapshotDto,
  filter: ProviderFilter,
  monthKey: string
): DayAggregate {
  const aggregate = emptyAggregate()
  for (const day of snapshot.days) {
    if (!day.date.startsWith(monthKey)) {
      continue
    }
    const part = aggregateDay(day, filter)
    aggregate.costUsd += part.costUsd
    aggregate.tokens += part.tokens
    aggregate.requests += part.requests
    aggregate.allowanceUsd += part.allowanceUsd
    aggregate.missingUsage += part.missingUsage
    aggregate.inputHit += part.inputHit
    aggregate.inputMiss += part.inputMiss
    aggregate.cacheWrite += part.cacheWrite
    aggregate.output += part.output
    aggregate.searchCount += part.searchCount
  }
  return aggregate
}

function aggregateRange(
  snapshot: UsageSnapshotDto,
  filter: ProviderFilter,
  from: string,
  to: string
): DayAggregate {
  const aggregate = emptyAggregate()
  const map = new Map<string, UsageDayDto>()
  for (const day of snapshot.days) {
    map.set(day.date, day)
  }
  let cursor = from
  while (cursor <= to) {
    const part = aggregateDay(map.get(cursor), filter)
    aggregate.costUsd += part.costUsd
    aggregate.tokens += part.tokens
    aggregate.requests += part.requests
    aggregate.allowanceUsd += part.allowanceUsd
    aggregate.missingUsage += part.missingUsage
    aggregate.inputHit += part.inputHit
    aggregate.inputMiss += part.inputMiss
    aggregate.cacheWrite += part.cacheWrite
    aggregate.output += part.output
    aggregate.searchCount += part.searchCount
    cursor = addDaysKey(cursor, 1)
  }
  return aggregate
}

// ===== 日期工具（按日历日期运算，不依赖本机时区） =====

function parseDateKey(key: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (m === null) {
    return [1970, 1, 1]
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function addDaysKey(key: string, days: number): string {
  const [year, month, day] = parseDateKey(key)
  const base = Date.UTC(year, month - 1, day)
  const d = new Date(base + days * 86400000)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mm}-${dd}`
}

function weekdayIndexKey(key: string): number {
  const [year, month, day] = parseDateKey(key)
  const d = new Date(Date.UTC(year, month - 1, day))
  return (d.getUTCDay() + 6) % 7
}

function daysInMonthKey(key: string): number {
  const [year, month] = parseDateKey(key)
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function monthDay(key: string): number {
  return parseDateKey(key)[2]
}

interface HeatmapWeek {
  start: string
  days: string[]
}

function buildHeatmap(todayKey: string): { weeks: HeatmapWeek[]; start: string } {
  const weekStart = addDaysKey(todayKey, -weekdayIndexKey(todayKey))
  const start = addDaysKey(weekStart, -52 * 7)
  const weeks: HeatmapWeek[] = []
  for (let w = 0; w < 53; w++) {
    const weekStartKey = addDaysKey(start, w * 7)
    const days: string[] = []
    for (let d = 0; d < 7; d++) {
      days.push(addDaysKey(weekStartKey, d))
    }
    weeks.push({ start: weekStartKey, days })
  }
  return { weeks, start }
}

function formatCny(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0
  if (n === 0) {
    return '¥0.00'
  }
  if (n < 0.01) {
    return `¥${n.toFixed(4)}`
  }
  if (n < 1) {
    return `¥${n.toFixed(3)}`
  }
  return `¥${n.toFixed(2)}`
}

function formatUsd(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`
}

function formatTokens(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0
  if (n >= 100000000) {
    return `${(n / 100000000).toFixed(2)} 亿`
  }
  if (n >= 10000) {
    return `${(n / 10000).toFixed(1)} 万`
  }
  return Math.round(n).toLocaleString('zh-CN')
}

function formatRequests(value: number): string {
  return `${Math.round(value).toLocaleString('zh-CN')} 次`
}

function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '—'
  }
  const d = new Date(ms + 8 * 3600000)
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${h}:${mi}`
}

function formatDayLabel(dateKey: string): string {
  const [year, month, day] = parseDateKey(dateKey)
  return `${year} 年 ${month} 月 ${day} 日`
}

function weekdayLabel(dateKey: string): string {
  return WEEK_LABELS[weekdayIndexKey(dateKey)]
}

/** 5 档热力图阈值：按非零值四分位，避免长尾把大部分格子压到最浅一档 */
function heatThresholds(values: number[]): number[] {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (positive.length === 0) {
    return [0, 0, 0, 0]
  }
  const pick = (q: number): number => positive[Math.min(positive.length - 1, Math.floor(positive.length * q))]
  return [pick(0.25), pick(0.5), pick(0.75), positive[positive.length - 1]]
}

function heatLevel(value: number, thresholds: number[]): number {
  if (!(value > 0)) {
    return 0
  }
  if (value <= thresholds[0]) {
    return 1
  }
  if (value <= thresholds[1]) {
    return 2
  }
  if (value <= thresholds[2]) {
    return 3
  }
  return 4
}

// ===== 页面 =====

export interface UsagePageProps {
  /** SSR/无头断言用；平时由 store 的 usageOpen 决定 */
  open?: boolean
}

export function UsagePage({ open: openOverride }: UsagePageProps = {}) {
  const storeOpen = useStore((s) => s.usageOpen)
  const open = openOverride ?? storeOpen
  const openUsage = useStore((s) => s.openUsage)
  const pushNotice = useStore((s) => s.pushNotice)

  const [snapshot, setSnapshot] = useState<UsageSnapshotDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<ProviderFilter>('all')
  const [metric, setMetric] = useState<Metric>('cost')
  const [selectedDate, setSelectedDate] = useState('')
  const [detail, setDetail] = useState<UsageDayDetailDto | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [refreshingBalance, setRefreshingBalance] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [budgetInput, setBudgetInput] = useState('')
  const [savingBudget, setSavingBudget] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const detailRequestRef = useRef(0)

  useEffect(() => {
    if (!open) {
      return
    }
    void loadSnapshot(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 设置页可能还挂在下面；先关最上层的用量页，不要让两个 Esc 一起响应
        event.stopImmediatePropagation()
        openUsage(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, openUsage])

  // 打开页面触发的余额刷新在后台完成，不阻塞本地账本首屏
  useEffect(() => {
    if (!open) {
      return
    }
    return window.guncat.onEvent((event) => {
      if (event.type === 'usage:balance') {
        setSnapshot((current) =>
          current === null
            ? current
            : { ...current, balance: event.balance, balanceError: event.balanceError }
        )
      }
    })
  }, [open])

  useEffect(() => {
    if (snapshot === null) {
      return
    }
    setBudgetInput(snapshot.budget.monthlyCny > 0 ? String(snapshot.budget.monthlyCny) : '')
  }, [snapshot?.budget.monthlyCny])

  // 默认滚到最近一周（每次打开/切换筛选都回到最右）
  useEffect(() => {
    if (!open || snapshot === null) {
      return
    }
    const element = scrollRef.current
    if (element !== null) {
      element.scrollLeft = element.scrollWidth
    }
  }, [open, snapshot, filter, metric])

  async function loadSnapshot(allowAutoBalance: boolean): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const next = await window.guncat.usage.snapshot(allowAutoBalance)
      setSnapshot(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function refreshBalance(): Promise<void> {
    if (refreshingBalance) {
      return
    }
    setRefreshingBalance(true)
    try {
      const next = await window.guncat.usage.refreshBalance()
      setSnapshot(next)
    } catch (e) {
      pushNotice('error', `余额刷新失败：${String(e)}`)
    } finally {
      setRefreshingBalance(false)
    }
  }

  async function exportCsv(): Promise<void> {
    if (exporting) {
      return
    }
    setExporting(true)
    try {
      const result = await window.guncat.usage.exportCsv()
      if (result.saved) {
        pushNotice('info', `用量明细已导出：${result.path ?? ''}`)
      }
    } catch (e) {
      pushNotice('error', `导出失败：${String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  async function saveBudget(): Promise<void> {
    if (savingBudget) {
      return
    }
    const value = Number(budgetInput.replace(/,/g, '').trim())
    if (!Number.isFinite(value) || value < 0) {
      pushNotice('warn', '预算需要填写一个不小于 0 的数字')
      return
    }
    setSavingBudget(true)
    try {
      const next = await window.guncat.usage.saveBudget(value)
      setSnapshot(next)
      pushNotice('info', value > 0 ? `本月预算已设为 ${formatCny(value)}` : '已关闭本月预算提醒')
    } catch (e) {
      pushNotice('error', `预算保存失败：${String(e)}`)
    } finally {
      setSavingBudget(false)
    }
  }

  async function selectDay(date: string): Promise<void> {
    if (date > (snapshot?.today ?? '')) {
      return
    }
    if (selectedDate === date) {
      detailRequestRef.current++
      setSelectedDate('')
      setDetail(null)
      return
    }
    const requestId = ++detailRequestRef.current
    setSelectedDate(date)
    setDetail(null)
    setDetailLoading(true)
    try {
      const next = await window.guncat.usage.day(date)
      if (detailRequestRef.current === requestId) {
        setDetail(next)
      }
    } catch {
      if (detailRequestRef.current === requestId) {
        setDetail({ date, models: [] })
      }
    } finally {
      if (detailRequestRef.current === requestId) {
        setDetailLoading(false)
      }
    }
  }

  const today = snapshot?.today ?? ''
  const heatmap = useMemo(() => (today === '' ? null : buildHeatmap(today)), [today])
  const dayMap = useMemo(() => {
    const map = new Map<string, UsageDayDto>()
    for (const day of snapshot?.days ?? []) {
      map.set(day.date, day)
    }
    return map
  }, [snapshot])

  if (!open) {
    return null
  }

  const monthKey = today !== '' ? today.substring(0, 7) : ''
  const monthStart = monthKey !== '' ? `${monthKey}-01` : ''
  const todayAggregate = aggregateDay(dayMap.get(today), filter)
  const last7Aggregate = aggregateRange(snapshot ?? emptySnapshot(), filter, addDaysKey(today, -6), today)
  const monthAggregate = aggregateFromMonth(snapshot ?? emptySnapshot(), filter, monthKey)
  const dayOfMonth = monthDay(today)
  const monthDays = daysInMonthKey(today)
  const monthFactor = dayOfMonth > 0 ? monthDays / dayOfMonth : 1
  const monthProjectionUsd = monthAggregate.costUsd * monthFactor
  const monthProjectionTokens = monthAggregate.tokens * monthFactor

  const heatValues: number[] = []
  if (heatmap !== null) {
    for (const week of heatmap.weeks) {
      for (const key of week.days) {
        if (key > today) {
          continue
        }
        const aggregate = aggregateDay(dayMap.get(key), filter)
        heatValues.push(metricValue(aggregate, metric))
      }
    }
  }
  const thresholds = heatThresholds(heatValues)
  const monthLabels = heatmap === null ? [] : buildMonthLabels(heatmap.weeks)

  const deepseekMonth = snapshot?.monthByProvider.deepseek ?? EMPTY_BUCKET
  const opencodeMonth = snapshot?.monthByProvider['opencode-go'] ?? EMPTY_BUCKET
  const opencodeEquivalentUsd = providerCostUsd('opencode-go', opencodeMonth)
  const deepseekCostCny = providerCostUsd('deepseek', deepseekMonth) * (snapshot?.price.usdToCny ?? 7.2)
  const opencodeCostCny = opencodeEquivalentUsd * (snapshot?.price.usdToCny ?? 7.2)
  const monthCostCny = snapshot?.budget.monthCostCny ?? 0
  const budgetCny = snapshot?.budget.monthlyCny ?? 0
  const budgetPercent = budgetCny > 0 ? Math.min(100, (monthCostCny / budgetCny) * 100) : 0
  const overBudget = budgetCny > 0 && monthCostCny > budgetCny
  const detailModels = (detail?.models ?? []).filter(
    (model) => isTrackedProvider(model.provider) && (filter === 'all' || model.provider === filter)
  )
  const detailAggregate = emptyAggregate()
  for (const model of detailModels) {
    addDayToAggregate(detailAggregate, model.provider, model.peak)
    addDayToAggregate(detailAggregate, model.provider, model.off)
  }
  let detailPeakUsd = 0
  let detailOffUsd = 0
  let detailAllowanceUsd = 0
  for (const model of detailModels) {
    detailPeakUsd += providerCostUsd(model.provider, model.peak)
    detailOffUsd += providerCostUsd(model.provider, model.off)
    detailAllowanceUsd += model.peak.allowanceUsd + model.off.allowanceUsd
  }

  return (
    <div className="usage-page" role="dialog" aria-modal="true" aria-label="用量与成本">
      <header className="usage-page__head">
        <div className="usage-page__headinner">
          <button
            type="button"
            className="usage-page__back"
            title="返回"
            aria-label="返回"
            onClick={() => openUsage(false)}
          >
            <IconArrowLeft size={22} />
          </button>
          <div className="usage-page__brandcopy">
            <h1>用量与成本</h1>
            <p>逐请求记账 · 按日聚合 · 本地统计</p>
          </div>
          <div className="usage-page__actions">
            <button
              className="btn btn--sm"
              disabled={exporting}
              onClick={() => void exportCsv()}
            >
              <IconDownload size={15} />
              {exporting ? '导出中…' : '导出 CSV'}
            </button>
            <button
              className="btn btn--sm"
              disabled={refreshingBalance || snapshot?.providers.deepseek.enabled !== true}
              title={
                snapshot?.providers.deepseek.enabled === true
                  ? '手动刷新 DeepSeek 余额（仅作对账）'
                  : '未配置 DeepSeek API Key'
              }
              onClick={() => void refreshBalance()}
            >
              <IconRefresh size={15} />
              {refreshingBalance ? '刷新中…' : '刷新余额'}
            </button>
          </div>
        </div>
      </header>

      <div className="usage-page__body">
        <div className="usage-toolbar">
          <div className="usage-segment" role="tablist" aria-label="服务商筛选">
            {PROVIDERS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                data-active={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="usage-toolbar__right">
            <span className="usage-toolbar__hint">主显示</span>
            <div className="usage-segment" role="tablist" aria-label="主显示指标切换">
              {METRICS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={metric === item.id}
                  data-active={metric === item.id}
                  onClick={() => setMetric(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error !== '' ? (
          <div className="usage-error">
            <IconInfo size={18} />
            <span>用量数据读取失败：{error}</span>
            <button className="btn btn--sm" onClick={() => void loadSnapshot(true)}>
              重试
            </button>
          </div>
        ) : null}

        <section className="usage-summary" aria-label="用量汇总">
          <SummaryCard
            label="今日"
            metric={metric}
            costUsd={todayAggregate.costUsd}
            rate={snapshot?.price.usdToCny ?? 7.2}
            tokens={todayAggregate.tokens}
            requests={todayAggregate.requests}
          />
          <SummaryCard
            label="近 7 天"
            metric={metric}
            costUsd={last7Aggregate.costUsd}
            rate={snapshot?.price.usdToCny ?? 7.2}
            tokens={last7Aggregate.tokens}
            requests={last7Aggregate.requests}
          />
          <SummaryCard
            label="本月"
            metric={metric}
            costUsd={monthAggregate.costUsd}
            rate={snapshot?.price.usdToCny ?? 7.2}
            tokens={monthAggregate.tokens}
            requests={monthAggregate.requests}
          />
          <SummaryCard
            label="本月预计"
            metric={metric}
            costUsd={monthProjectionUsd}
            rate={snapshot?.price.usdToCny ?? 7.2}
            tokens={monthProjectionTokens}
            requests={Math.round(monthAggregate.requests * monthFactor)}
            hint={`按已过 ${dayOfMonth} 天折算`}
          />
        </section>

        <section className="usage-card usage-heatmap-card" data-metric={metric}>
          <div className="usage-card__head">
            <div>
              <h2>每日{metric === 'cost' ? '费用' : metric === 'tokens' ? ' token 用量' : '请求数'}</h2>
              <p>
                最近 53 周 · 周一为第一行
                {filter === 'opencode-go' ? ' · 费用按网关等价成本（list_cost）展示' : ''}
              </p>
            </div>
            <div className="usage-heatmap__legend" aria-label="热力图图例">
              <span>少</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <i key={level} data-level={level} />
              ))}
              <span>多</span>
            </div>
          </div>

          {loading && snapshot === null ? (
            <div className="usage-empty">正在读取本地用量账本…</div>
          ) : heatmap === null ? (
            <div className="usage-empty">暂无数据</div>
          ) : (
            <div className="usage-heatmap__body">
              <div className="usage-heatmap__weekdays" aria-hidden="true">
                <div className="usage-heatmap__weekday-spacer" />
                {WEEK_SHORT_LABELS.map((label, index) => (
                  <span key={index} title={WEEK_LABELS[index]}>
                    {label}
                  </span>
                ))}
              </div>
              <div className="usage-heatmap__scroll" ref={scrollRef}>
                <div className="usage-heatmap__canvas">
                  <div className="usage-heatmap__months">
                    {monthLabels.map((label, index) => (
                      <span key={index}>{label}</span>
                    ))}
                  </div>
                  <div className="usage-heatmap__weeks">
                    {heatmap.weeks.map((week) => (
                      <div className="usage-heatmap__week" key={week.start}>
                        {week.days.map((key) => {
                          const aggregate = aggregateDay(dayMap.get(key), filter)
                          const value = metricValue(aggregate, metric)
                          const future = key > today
                          const level = future ? 0 : heatLevel(value, thresholds)
                          return (
                            <button
                              key={key}
                              type="button"
                              className="usage-heatmap__cell"
                              data-level={level}
                              data-future={future}
                              data-selected={selectedDate === key}
                              disabled={future}
                              aria-label={`${key} ${metricLabel(metric, aggregate)}`}
                              title={
                                future
                                  ? key
                                  : `${key} ${weekdayLabel(key)}\n${metricLabel(metric, aggregate)}\n${formatRequests(aggregate.requests)}`
                              }
                              onClick={() => void selectDay(key)}
                            />
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="usage-heatmap__foot">
            <span>
              {snapshot !== null && heatmap !== null
                ? `${heatmap.start} 至 ${snapshot.rangeEnd}`
                : '仅统计本机实际 API 调用'}
            </span>
            <span>点击有颜色的格子查看当日明细</span>
          </div>
        </section>

        {selectedDate !== '' ? (
          <section className="usage-card usage-day">
            <div className="usage-card__head">
              <div>
                <h2>
                  {formatDayLabel(selectedDate)}
                  <span className="usage-day__weekday">{weekdayLabel(selectedDate)}</span>
                </h2>
                <p>
                  {filter === 'all' ? '全部服务商' : PROVIDERS.find((p) => p.id === filter)?.label}
                  {detailLoading ? ' · 正在读取明细…' : ''}
                </p>
              </div>
              <button className="icon-btn" title="收起" onClick={() => void selectDay(selectedDate)}>
                <IconClose size={16} />
              </button>
            </div>

            {detailLoading ? (
              <div className="usage-empty">正在读取当日明细…</div>
            ) : detailModels.length === 0 ? (
              <div className="usage-empty">这一天没有用量记录</div>
            ) : (
              <>
                <div className="usage-day__stats">
                  <DayStat
                    label="费用"
                    value={formatCny(detailAggregate.costUsd * (snapshot?.price.usdToCny ?? 7.2))}
                    active={metric === 'cost'}
                  />
                  <DayStat
                    label="总 tokens"
                    value={formatTokens(detailAggregate.tokens)}
                    active={metric === 'tokens'}
                  />
                  <DayStat
                    label="请求数"
                    value={formatRequests(detailAggregate.requests)}
                    active={metric === 'requests'}
                  />
                  <DayStat label="输入命中" value={formatTokens(detailAggregate.inputHit)} />
                  <DayStat label="输入未命中" value={formatTokens(detailAggregate.inputMiss)} />
                  <DayStat label="缓存写入" value={formatTokens(detailAggregate.cacheWrite)} />
                  <DayStat label="输出" value={formatTokens(detailAggregate.output)} />
                </div>
                <div className="usage-day__split">
                  <DayStat
                    label="峰时费用"
                    value={formatCny(detailPeakUsd * (snapshot?.price.usdToCny ?? 7.2))}
                  />
                  <DayStat
                    label="空闲费用"
                    value={formatCny(detailOffUsd * (snapshot?.price.usdToCny ?? 7.2))}
                  />
                  {detailAggregate.searchCount > 0 ? (
                    <DayStat label="联网搜索/抓取" value={`${detailAggregate.searchCount} 次`} />
                  ) : null}
                  {detailAllowanceUsd > 0 ? (
                    <DayStat label="OpenCode 额度消耗" value={formatUsd(detailAllowanceUsd)} />
                  ) : null}
                </div>

                <div className="usage-models">
                  <div className="usage-models__head">
                    <span>模型</span>
                    <span>占比（tokens）</span>
                    <span>请求</span>
                    <span>费用</span>
                  </div>
                  {detailModels.map((model) => {
                    const tokens = bucketTokens(model.peak) + bucketTokens(model.off)
                    const cost =
                      providerCostUsd(model.provider, model.peak) +
                      providerCostUsd(model.provider, model.off)
                    const requests = model.peak.requests + model.off.requests
                    const share = detailAggregate.tokens > 0 ? tokens / detailAggregate.tokens : 0
                    return (
                      <div className="usage-models__row" key={`${model.provider}-${model.model}`}>
                        <div className="usage-models__name">
                          <strong title={model.model}>{model.model}</strong>
                          <small>
                            {model.provider === 'deepseek' ? 'DeepSeek' : model.provider === 'opencode-go' ? 'OpenCode Go' : model.provider}
                            {model.billingSources.length > 0
                              ? ` · ${model.billingSources.join(' / ')}`
                              : ''}
                          </small>
                        </div>
                        <div className="usage-models__share">
                          <span className="usage-models__bar">
                            <i style={{ width: `${Math.round(share * 100)}%` }} />
                          </span>
                          <span>{Math.round(share * 100)}%</span>
                        </div>
                        <span>{requests}</span>
                        <span>{formatCny(cost * (snapshot?.price.usdToCny ?? 7.2))}</span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </section>
        ) : null}

        <section className="usage-providers" aria-label="服务商账单">
          <ProviderCard
            title="DeepSeek"
            subtitle="按官方峰谷价目本地计价"
            enabled={snapshot?.providers.deepseek.enabled === true}
            mainLabel="本月实付"
            mainValue={formatCny(deepseekCostCny)}
            rows={[
              { label: '本月请求', value: formatRequests(deepseekMonth.requests) },
              { label: '本月 tokens', value: formatTokens(bucketTokens(deepseekMonth)) },
              ...(deepseekMonth.unpricedRequests > 0
                ? [{ label: '未收录价目请求', value: `${deepseekMonth.unpricedRequests} 次` }]
                : [])
            ]}
            extra={
              <div className="usage-balance">
                <div className="usage-balance__head">
                  <span>余额（仅对账）</span>
                  <span className="usage-balance__time">
                    {snapshot?.balance !== null && snapshot?.balance !== undefined
                      ? formatDateTime(snapshot.balance.at)
                      : '尚未刷新'}
                  </span>
                </div>
                {snapshot?.providers.deepseek.enabled !== true ? (
                  <p className="usage-muted">未启用：填写 DeepSeek API Key 后可查询余额。</p>
                ) : snapshot?.balance !== null && snapshot?.balance !== undefined ? (
                  <div className="usage-balance__value">
                    <strong>
                      {snapshot.balance.currency === 'USD' ? '$' : '¥'}
                      {snapshot.balance.total.toFixed(2)}
                    </strong>
                    <span>{snapshot.balance.currency}</span>
                  </div>
                ) : (
                  <p className="usage-muted">暂无余额快照，点击右上角「刷新余额」。</p>
                )}
                {snapshot?.balanceError !== undefined && snapshot.balanceError !== '' ? (
                  <p className="usage-warn">上次刷新失败：{snapshot.balanceError}</p>
                ) : null}
                <p className="usage-muted usage-balance__note">
                  余额仅作对账，不参与热力图，也不会反推每日/模型/峰谷统计。
                </p>
              </div>
            }
          />

          <ProviderCard
            title="OpenCode Go"
            subtitle="套餐额度与等价按量成本分开显示"
            enabled={snapshot?.providers.opencodeGo.enabled === true}
            mainLabel="本月额度消耗"
            mainValue={formatUsd(opencodeMonth.allowanceUsd)}
            rows={[
              { label: '等价成本', value: formatCny(opencodeCostCny) },
              { label: '本月请求', value: formatRequests(opencodeMonth.requests) },
              { label: '本月 tokens', value: formatTokens(bucketTokens(opencodeMonth)) },
              ...(snapshot !== null && snapshot.billingSources.length > 0
                ? [{ label: '计费来源', value: snapshot.billingSources.join(' / ') }]
                : [])
            ]}
            extra={
              <div className="usage-windows">
                <div className="usage-windows__title">套餐窗口</div>
                <p className="usage-muted">
                  套餐参考价 $10 / 月；网关返回的 usage 中未包含 5 小时 / 周 / 月窗口数据，
                  当前以 allowance 与 list_cost 展示。具体模型额度以 OpenCode 网关为准，不硬编码成计费依据。
                </p>
              </div>
            }
          />
        </section>

        <section className="usage-card usage-budget">
          <div className="usage-card__head">
            <div>
              <h2>本月预算</h2>
              <p>按 DeepSeek 实付 + OpenCode 等价成本合计，超过后仅提示，不阻断使用。</p>
            </div>
            {overBudget ? <span className="usage-badge usage-badge--warn">已超预算</span> : null}
          </div>
          <div className="usage-budget__body">
            <div className="usage-budget__form">
              <label htmlFor="usage-budget-input">每月预算（人民币）</label>
              <div className="usage-budget__input">
                <span>¥</span>
                <input
                  id="usage-budget-input"
                  inputMode="decimal"
                  placeholder="不设置则留空"
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void saveBudget()
                    }
                  }}
                />
                <button className="btn btn--sm" disabled={savingBudget} onClick={() => void saveBudget()}>
                  {savingBudget ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
            <div className="usage-budget__progress">
              <div className="usage-budget__progress-head">
                <span>本月已用 {formatCny(monthCostCny)}</span>
                <span>{budgetCny > 0 ? `预算 ${formatCny(budgetCny)}` : '未设置预算'}</span>
              </div>
              <span className="usage-budget__track">
                <i
                  data-over={overBudget}
                  style={{ width: `${budgetCny > 0 ? budgetPercent : 0}%` }}
                />
              </span>
              {overBudget ? (
                <p className="usage-warn">
                  已超出预算 {formatCny(monthCostCny - budgetCny)}。这是非阻塞提示，聊天与 Agent 仍可继续使用。
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <footer className="usage-foot">
          <div className="usage-foot__line">
            <IconCalendar size={14} />
            <span>价目表 {snapshot?.price.version ?? '—'} · 更新 {snapshot?.price.updatedAt ?? '—'}</span>
            <span>汇率 1 USD = {snapshot?.price.usdToCny ?? 7.2} CNY · 参考更新 {snapshot?.price.exchangeUpdatedAt ?? '—'}</span>
          </div>
          <div className="usage-foot__line">
            <IconInfo size={14} />
            <span>{snapshot?.price.peakRule ?? '按北京时间判断峰谷。'}</span>
          </div>
          <div className="usage-foot__line">
            <IconInfo size={14} />
            <span>
              节假日表覆盖 {snapshot?.price.holidayYears.join(' / ') ?? '2024 / 2025 / 2026'} 年
              {snapshot !== null && snapshot.price.missingHolidayYears.length > 0
                ? `；未收录 ${snapshot.price.missingHolidayYears.join(' / ')} 年，按工作日高峰保守估算`
                : '；缺失年份按工作日高峰保守估算'}
            </span>
          </div>
          <div className="usage-foot__line">
            <IconInfo size={14} />
            <span>
              缺失 usage 的请求 {snapshot?.totals.missingUsage ?? 0} 次；未收录价目请求{' '}
              {snapshot?.totals.unpricedRequests ?? 0} 次。统计只保留最近约 400 天，文件位于应用私有目录。
            </span>
          </div>
          <div className="usage-foot__line">
            <IconInfo size={14} />
            <span>
              余额仅作对账，不参与热力图。OpenCode 套餐内 cost 可能为 0，页面用 list_cost
              展示等价成本；模型额度以网关返回为准。
            </span>
          </div>
          <div className="usage-foot__line">
            <IconInfo size={14} />
            <span>
              热力图聚焦 DeepSeek 与 OpenCode Go；多模态解析、表格识别等其他辅助 API
              调用仍会记账，但不混入这两家的费用对比。
            </span>
          </div>
        </footer>
      </div>
    </div>
  )
}

function emptySnapshot(): UsageSnapshotDto {
  return {
    generatedAt: 0,
    today: '',
    rangeStart: '',
    rangeEnd: '',
    days: [],
    monthByProvider: {},
    billingSources: [],
    balance: null,
    balanceError: '',
    budget: { monthlyCny: 0, monthCostCny: 0, over: false },
    totals: { ...EMPTY_BUCKET },
    price: {
      version: '',
      updatedAt: '',
      usdToCny: 7.2,
      exchangeUpdatedAt: '',
      peakRule: '',
      holidayYears: [],
      missingHolidayYears: [],
      searchCnyPerCall: 0
    },
    providers: {
      deepseek: { enabled: false },
      opencodeGo: { enabled: false }
    }
  }
}

function metricValue(aggregate: DayAggregate, metric: Metric): number {
  if (metric === 'tokens') {
    return aggregate.tokens
  }
  if (metric === 'requests') {
    return aggregate.requests
  }
  return aggregate.costUsd
}

function metricLabel(metric: Metric, aggregate: DayAggregate): string {
  if (metric === 'tokens') {
    return `Tokens ${formatTokens(aggregate.tokens)}`
  }
  if (metric === 'requests') {
    return `请求 ${formatRequests(aggregate.requests)}`
  }
  return `费用 ${formatCny(aggregate.costUsd * 7.2)}`
}

function buildMonthLabels(weeks: HeatmapWeek[]): string[] {
  const labels: string[] = []
  let lastMonth = ''
  for (const week of weeks) {
    const [year, month] = parseDateKey(week.start)
    const current = `${year}-${month}`
    if (current !== lastMonth) {
      labels.push(`${month} 月`)
      lastMonth = current
    } else {
      labels.push('')
    }
  }
  return labels
}

function metricShortLabel(metric: Metric): string {
  if (metric === 'tokens') {
    return 'Tokens'
  }
  if (metric === 'requests') {
    return '请求数'
  }
  return '费用'
}

function SummaryCard({
  label,
  metric,
  costUsd,
  rate,
  tokens,
  requests,
  hint
}: {
  label: string
  metric: Metric
  costUsd: number
  rate: number
  tokens: number
  requests: number
  hint?: string
}) {
  const costText = formatCny(costUsd * rate)
  const tokenText = formatTokens(tokens)
  const requestText = Math.round(requests).toLocaleString('zh-CN')
  let primary = costText
  let unit = ''
  if (metric === 'tokens') {
    primary = tokenText
    unit = 'tokens'
  } else if (metric === 'requests') {
    primary = requestText
    unit = '次请求'
  }
  const secondary: string[] = []
  if (metric !== 'cost') {
    secondary.push(costText)
  }
  if (metric !== 'tokens') {
    secondary.push(`${tokenText} tokens`)
  }
  if (metric !== 'requests') {
    secondary.push(formatRequests(requests))
  }
  return (
    <div className="usage-summary__card" data-metric={metric}>
      <div className="usage-summary__label">
        <span>
          {label}
          <em>{metricShortLabel(metric)}</em>
        </span>
        {hint !== undefined ? <small>{hint}</small> : null}
      </div>
      <strong className="usage-summary__value">
        {primary}
        {unit !== '' ? <small>{unit}</small> : null}
      </strong>
      <div className="usage-summary__meta">
        {secondary.map((text) => (
          <span key={text}>{text}</span>
        ))}
      </div>
    </div>
  )
}

function DayStat({ label, value, active }: { label: string; value: string; active?: boolean }) {
  return (
    <div className="usage-day__stat" data-active={active === true}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ProviderCard({
  title,
  subtitle,
  enabled,
  mainLabel,
  mainValue,
  rows,
  extra
}: {
  title: string
  subtitle: string
  enabled: boolean
  mainLabel: string
  mainValue: string
  rows: Array<{ label: string; value: string }>
  extra: ReactNode
}) {
  return (
    <div className="usage-provider" data-enabled={enabled}>
      <div className="usage-provider__head">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <span className="usage-badge" data-on={enabled}>
          {enabled ? '已启用' : '未启用'}
        </span>
      </div>
      <div className="usage-provider__main">
        <span>{mainLabel}</span>
        <strong>{mainValue}</strong>
      </div>
      <div className="usage-provider__rows">
        {rows.map((row) => (
          <div key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
      {extra}
    </div>
  )
}
