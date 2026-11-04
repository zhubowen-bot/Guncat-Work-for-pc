import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ApiConfigDto,
  AppSettingsDto,
  CredentialStateDto,
  MultimodalConfigDto,
  SearchEngineDto
} from '@ipc/contract'
// 多模态默认地址/模型与主进程 MultimodalConfig.default() 用的是同一份常量。
// 面板保存时若把这两个字段存成空串，会把默认的智谱地址与 glm-4.6v-flash 冲掉，
// 「先行解析附件」随即失效 —— 所以规整时要能拿到这里的默认值（见 normalizeMultimodal）。
import { Constants } from '@core/common/Constants'
import { useStore } from '../store'
import { useSpeech } from '../speech/speechStore'
import {
  IconBrain,
  IconClose,
  IconFilter,
  IconGlobe,
  IconImage,
  IconMic,
  IconSettings,
  IconSpeaker
} from '../icons'

/**
 * 接入方式的文案表。三条占位符/提示逐字对齐原版 SettingsPanel.ets 的
 * getBaseUrlPlaceholder() / getModelPlaceholder() / getHint()（802-839 行）：
 * 这些字串是用户判断「这个接入方式该填什么」的唯一线索，抄漏一句就等于没对齐。
 */
export interface ProviderCopy {
  id: string
  label: string
  baseUrlPlaceholder: string
  modelPlaceholder: string
  hint: string
  /** 自动补全开关打开时拼在 Base URL 后面的协议路径后缀示例 */
  suffix: string
}

const PROVIDERS: ProviderCopy[] = [
  {
    id: 'openai-completions',
    label: 'OpenAI Completions（/chat/completions）',
    baseUrlPlaceholder: 'https://api.openai.com/v1 或 https://api.deepseek.com',
    modelPlaceholder: 'deepseek-chat / deepseek-reasoner / gpt-...',
    hint:
      '当前接入方式：OpenAI Completions，通用API接入方式，兼容大部分模型。若需要原生图片直传、' +
      '联网搜索等能力，建议切换 Responses API 或 Anthropic API 选项（需查询模型支持的方式）',
    suffix: '/chat/completions'
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses（/responses）',
    baseUrlPlaceholder: 'https://api.deepseek.com 或 https://ark.cn-beijing.volces.com/api/v3',
    modelPlaceholder: 'deepseek-v4-flash / deepseek-v4-pro / ep-xxx',
    hint:
      '当前接入方式：OpenAI Responses， 建议支持 Responses API 的模型优先选择此选项，' +
      '以获得原生图片直传、联网搜索等能力',
    suffix: '/responses'
  },
  {
    id: 'anthropic-messages',
    label: 'Anthropic Messages（/messages）',
    baseUrlPlaceholder: 'https://api.anthropic.com/v1 或 https://api.deepseek.com',
    modelPlaceholder: 'deepseek-v4-pro / deepseek-v4-flash / claude-...',
    hint:
      '当前接入方式：Anthropic Messages，建议支持 Anthropic API 的模型优先选择此选项，' +
      '以获得原生图片直传、联网搜索等能力',
    suffix: '/v1/messages 或 /anthropic/v1/messages'
  }
]

/** 未知接入方式时退回第一项：面板不能因为一个脏 provider 值就没有占位符与提示 */
export function providerCopy(id: string): ProviderCopy {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/**
 * 各引擎的搜索提示（原版 getSearchEngineHint() 757-774 行，逐字对齐）。
 * 按引擎 id 分支：引擎目录由主进程 settings:searchEngines 下发（权威表在 core 的 LocalWebSearch）。
 */
export function searchEngineHint(engine: string): string {
  switch (engine) {
    case 'bing':
      return 'Bing 无需 API Key, 直接爬取搜索结果页; 请求失败自动回落 cn.bing.com。'
    case 'tavily':
      return '默认 Base URL: https://api.tavily.com'
    case 'exa':
      return '默认 Base URL: https://api.exa.ai'
    case 'firecrawl':
      return '默认 Base URL: https://api.firecrawl.dev'
    case 'metaso':
      return '密钥在 metaso.cn 开放平台获取, 端点固定为 metaso.cn/api/v1/search。'
    default:
      return '在对应平台获取 API Key 后填入。'
  }
}

/**
 * API Key 的存储说明。措辞必须跟着主进程报上来的真实状态走：
 * 「仅保存在本机」不等于「加密保存」—— 系统没有凭据保险库时它就是明文躺在配置文件里，
 * 这时候写一句漂亮话等于替用户做了一个错的安全假设。解不开的项（换过机器、钥匙串被清空）
 * 也要点名，否则用户只会看到「Key 无效」却不知道该重新填。
 */
export function credentialHint(state: CredentialStateDto | undefined): string {
  if (state === undefined) {
    return '仅保存在本机应用数据目录，不会上传'
  }
  const lost: string =
    state.undecryptable.length > 0
      ? `有几项配置在这台机器上解不开（换过机器或系统钥匙串被清空）：${state.undecryptable.join(
          '、'
        )}，需要重新填写。`
      : ''
  if (!state.available) {
    return (
      lost +
      '注意：本机系统没有可用的凭据保险库，密钥目前明文存在配置文件里（只有这台机器能读到）。' +
      '配好系统的钥匙串/凭据管理器后会自动改为加密保存。'
    )
  }
  return (
    lost +
    '用本机系统的凭据保险库加密保存（与这台机器的登录账户绑定），配置文件里不含明文密钥，也不会上传；换到新机器需要重新填写密钥。'
  )
}

/**
 * 本地联网搜索的说明（对齐原版 SettingsPanel 592-618 的口径，改成桌面端措辞：
 * 原版写「手机直连」，桌面端就是本机直连）。
 */
const SEARCH_INTRO =
  '内置 local_web_search 工具（本机兜底搜索）：本机直连搜索引擎/搜索 API，' +
  '与服务端联网搜索开关互不影响、可同时存在。默认会优先走服务端搜索，' +
  '本机通道只在服务端搜索不可用/无结果或你明确要求时才被调用。'

/**
 * 本地联网搜索配置在偏好里的键名（存在 Preferences 里的一段 JSON）。
 * 与主进程 Constants.LS_KEY_LOCAL_SEARCH_CONFIG 必须是同一个字符串 ——
 * ipc-check 有一条断言按这个键名往返读写，改名漏改一边会被立刻抓到。
 */
const LOCAL_SEARCH_PREF_KEY = 'guncat_local_search_config'

/**
 * 本地联网搜索的可编辑字段。
 * 字段名与 core 的 SearchEngineSettings 一一对应（那份配置由它 parse/toJson），
 * 这里刻意不 import 那个模块：它依赖 `@kit.NetworkKit`，而渲染层的构建里没有 `@kit.*` 别名。
 */
interface SearchDraft {
  engine: string
  maxResults: number
  braveApiKey: string
  tavilyApiKey: string
  tavilyBaseUrl: string
  exaApiKey: string
  exaBaseUrl: string
  metasoApiKey: string
  firecrawlApiKey: string
  firecrawlBaseUrl: string
}

const EMPTY_SEARCH: SearchDraft = {
  engine: 'bing',
  maxResults: 8,
  braveApiKey: '',
  tavilyApiKey: '',
  tavilyBaseUrl: 'https://api.tavily.com',
  exaApiKey: '',
  exaBaseUrl: 'https://api.exa.ai',
  metasoApiKey: '',
  firecrawlApiKey: '',
  firecrawlBaseUrl: 'https://api.firecrawl.dev'
}

function parseSearchDraft(json: string | undefined): SearchDraft {
  if (json === undefined || json.trim() === '') {
    return { ...EMPTY_SEARCH }
  }
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...EMPTY_SEARCH }
    }
    return { ...EMPTY_SEARCH, ...(parsed as Partial<SearchDraft>) }
  } catch {
    // JSON 坏了就用默认值 —— 不能让一段坏配置卡住整个设置面板
    return { ...EMPTY_SEARCH }
  }
}

const EMPTY: ApiConfigDto = {
  provider: 'openai-completions',
  baseUrl: '',
  apiKey: '',
  model: '',
  models: [],
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
}

/** 把「每行/逗号分隔」的模型输入拆成去重后的列表 */
export function parseModelNames(text: string): string[] {
  const result: string[] = []
  for (const part of text.split(/[\n,，;；]+/)) {
    const name = part.trim()
    if (name !== '' && !result.includes(name)) {
      result.push(name)
    }
  }
  return result
}

/**
 * 保存前的规整（对齐原版 buildConfig() 854-866）：所有字符串 trim 后再落盘。
 * 用户从别处复制粘贴地址/密钥时经常带上首尾空格与换行，直接存下去会让请求
 * 以「看似填了其实无效」的方式失败（URL 带空格、Authorization 头带换行）。
 */
export function normalizeApiConfig(draft: ApiConfigDto): ApiConfigDto {
  const model = draft.model.trim()
  const models: string[] = []
  for (const raw of draft.models ?? []) {
    const name = raw.trim()
    if (name !== '' && !models.includes(name)) {
      models.push(name)
    }
  }
  // 当前生效的模型必须留在列表里：老数据只有 model、没有 models 时也能原样保存
  if (model !== '' && !models.includes(model)) {
    models.unshift(model)
  }
  return {
    ...draft,
    provider: draft.provider.trim(),
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey.trim(),
    model,
    models,
    extraParams: draft.extraParams.trim()
  }
}

/**
 * 多模态配置的规整（对齐原版 buildMmConfig() 868-879）。
 * 关键差异：Base URL / 模型名**为空时保留默认值**，而不是存空串 ——
 * 主进程 fromMultimodalDto 是直接赋值，空串会盖掉 MultimodalConfig.default() 的
 * 智谱地址与 glm-4.6v-flash，于是「先行解析附件」开启也解析不出任何东西。
 */
export function normalizeMultimodal(draft: MultimodalConfigDto): MultimodalConfigDto {
  const baseUrl = draft.baseUrl.trim()
  const model = draft.model.trim()
  return {
    baseUrl: baseUrl === '' ? Constants.DEFAULT_MM_BASE_URL : baseUrl,
    apiKey: draft.apiKey.trim(),
    model: model === '' ? Constants.DEFAULT_MM_MODEL : model,
    preparseEnabled: draft.preparseEnabled
  }
}

/**
 * 搜索配置的规整：字符串 trim 后整体落盘。
 * Base URL 留空是**允许**的语义（占位符就写着「留空使用默认地址」，
 * core 的 LocalWebSearch.normalizeBaseUrl 会把空串回落到各引擎默认端点），
 * 所以这里只 trim，不替用户填回默认值 —— 填回去反而会覆盖掉引擎侧将来的默认变更。
 */
export function normalizeSearch(search: SearchDraft): SearchDraft {
  return {
    ...search,
    engine: search.engine.trim(),
    braveApiKey: search.braveApiKey.trim(),
    tavilyApiKey: search.tavilyApiKey.trim(),
    tavilyBaseUrl: search.tavilyBaseUrl.trim(),
    exaApiKey: search.exaApiKey.trim(),
    exaBaseUrl: search.exaBaseUrl.trim(),
    metasoApiKey: search.metasoApiKey.trim(),
    firecrawlApiKey: search.firecrawlApiKey.trim(),
    firecrawlBaseUrl: search.firecrawlBaseUrl.trim()
  }
}

/**
 * 本地草稿的签名：任一字段变化（含对象里的 provider / temperature 等）都会产生新值。
 * 自动保存用它判断「这次渲染是用户改的还是刚回填的」，避免回填后又立刻写一遍。
 */
interface SettingsDraftValues {
  profileName: string
  draft: ApiConfigDto
  modelText: string
  mmBaseUrl: string
  mmApiKey: string
  mmModel: string
  mmPreparse: boolean
  asrBaseUrl: string
  asrApiKey: string
  asrModel: string
  search: SearchDraft
}

function settingsDraftSignature(values: SettingsDraftValues): string {
  return JSON.stringify([
    values.profileName,
    values.draft,
    values.modelText,
    values.mmBaseUrl,
    values.mmApiKey,
    values.mmModel,
    values.mmPreparse,
    values.asrBaseUrl,
    values.asrApiKey,
    values.asrModel,
    values.search
  ])
}

/** 输入停顿多久后自动保存。太短会在连续输入时写很多次，太长会让「改了就保存」显得迟钝。 */
const AUTO_SAVE_DELAY = 450

/** 从全局设置里读出整页草稿。首次挂载与切方案后回填共用同一套口径。 */
function readSettingsDraft(settings: AppSettingsDto | null): SettingsDraftValues {
  const api = settings?.apiConfig ?? EMPTY
  const list =
    (api.models ?? []).length > 0 ? (api.models ?? []) : api.model !== '' ? [api.model] : []
  const current = (settings?.apiProfiles ?? []).find(
    (p) => p.id === settings?.currentApiProfileId
  )
  return {
    profileName: current?.name ?? '',
    draft: api,
    modelText: list.join('\n'),
    mmBaseUrl: settings?.multimodalConfig.baseUrl ?? '',
    mmApiKey: settings?.multimodalConfig.apiKey ?? '',
    mmModel: settings?.multimodalConfig.model ?? '',
    mmPreparse: settings?.multimodalConfig.preparseEnabled ?? false,
    asrBaseUrl: settings?.prefs?.asr_baseUrl ?? '',
    asrApiKey: settings?.prefs?.asr_apiKey ?? '',
    asrModel: settings?.prefs?.asr_model ?? '',
    search: parseSearchDraft(settings?.prefs?.[LOCAL_SEARCH_PREF_KEY])
  }
}

/** 设置页的导航分类。每个分类对应右侧一块独立内容，不再用折叠栏把内容堆在一页。 */
type SettingsTabId = 'model' | 'advanced' | 'search' | 'multimodal' | 'auto-read' | 'voice-input'

interface SettingsTab {
  id: SettingsTabId
  /** 左侧导航里的短标题 */
  label: string
  /** 右侧内容区的完整标题 */
  title: string
  description: string
  icon: ReactNode
}

const SETTINGS_NAV: Array<{ label: string; items: SettingsTab[] }> = [
  {
    label: '模型与能力',
    items: [
      {
        id: 'model',
        label: '模型配置',
        title: '模型配置',
        description: '管理配置方案、接入方式与当前可切换的模型。',
        icon: <IconBrain size={16} />
      },
      {
        id: 'advanced',
        label: '高级模型参数',
        title: '高级模型参数',
        description: '调整采样参数，或为自定义服务商追加请求参数。',
        icon: <IconFilter size={16} />
      },
      {
        id: 'search',
        label: '本地联网搜索',
        title: '本地联网搜索',
        description: '设置内置 local_web_search 使用的搜索引擎与凭据。',
        icon: <IconGlobe size={16} />
      },
      {
        id: 'multimodal',
        label: '多模态解析',
        title: '多模态解析 API',
        description: '在发送前用独立的视觉模型解析图片与文档。',
        icon: <IconImage size={16} />
      }
    ]
  },
  {
    label: '语音',
    items: [
      {
        id: 'auto-read',
        label: '自动朗读',
        title: '自动朗读',
        description: '回答生成完成后自动播报，音色与语速在朗读控制条里调整。',
        icon: <IconSpeaker size={16} />
      },
      {
        id: 'voice-input',
        label: '语音输入',
        title: '语音输入（录音转文字）',
        description: '配置录音转写使用的接口、密钥与模型。',
        icon: <IconMic size={16} />
      }
    ]
  }
]

const SETTINGS_TABS: SettingsTab[] = SETTINGS_NAV.flatMap((group) => group.items)

/** 内容区里的白底卡片。带标题时标题与说明单独占一行，字段再落进 body。 */
function SettingsCard(props: {
  title?: string
  description?: string
  children: ReactNode
}): ReactNode {
  return (
    <section className="settings-card">
      {props.title !== undefined ? (
        <div className="settings-card__head">
          <h3 className="settings-card__title">{props.title}</h3>
          {props.description !== undefined ? (
            <p className="settings-card__desc">{props.description}</p>
          ) : null}
        </div>
      ) : null}
      <div
        className={
          props.title === undefined
            ? 'settings-card__body settings-card__body--plain'
            : 'settings-card__body'
        }
      >
        {props.children}
      </div>
    </section>
  )
}

/** 表单字段：标签 + 控件 + 可选说明。样式由 .settings-form 作用域收紧。 */
function SettingsField(props: {
  label: string
  hint?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <div className="field">
      <label>{props.label}</label>
      {props.children}
      {props.hint !== undefined ? <div className="field__hint">{props.hint}</div> : null}
    </div>
  )
}

/** 段落级说明，用于开关下方或一组字段之前。 */
function SettingsNote(props: { children: ReactNode }): ReactNode {
  return <div className="settings-note">{props.children}</div>
}

/** 现代开关行：整行可点，右侧是轨道 + 滑块。 */
function SettingsToggle(props: {
  checked: boolean
  title: string
  description: string
  divider?: boolean
  onChange: (checked: boolean) => void
}): ReactNode {
  return (
    <label className="settings-toggle" data-divider={props.divider === true ? 'true' : 'false'}>
      <span className="settings-toggle__copy">
        <span className="settings-toggle__title">{props.title}</span>
        <span className="settings-toggle__desc">{props.description}</span>
      </span>
      <span className="settings-toggle__switch">
        <input
          type="checkbox"
          role="switch"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        <span className="settings-toggle__track" aria-hidden="true">
          <span className="settings-toggle__thumb" />
        </span>
      </span>
    </label>
  )
}

export interface SettingsPageProps {
  /**
   * 覆盖「是否打开」。平时不传，由 store 的 settingsOpen 决定。
   * 之所以提成 props：SSR 断言里 zustand 只会读到初始状态（settingsOpen=false），
   * 整块不渲染，无头环境就钉不住「首屏默认落在模型配置」这类首帧口径。
   */
  open?: boolean
}

export function SettingsPage({ open: openOverride }: SettingsPageProps = {}) {
  const storeOpen = useStore((s) => s.settingsOpen)
  const open = openOverride ?? storeOpen
  const openSettings = useStore((s) => s.openSettings)
  const settings = useStore((s) => s.settings)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const pushNotice = useStore((s) => s.pushNotice)
  // 自动朗读的状态与开关都在 speechStore 里（持久化到 reader_enabled），
  // 这里只是把它接到设置页上，避免两处各存一份偏好。
  const autoRead = useSpeech((s) => s.autoRead)
  const setAutoRead = useSpeech((s) => s.setAutoRead)

  const [initialForm] = useState(() => readSettingsDraft(useStore.getState().settings))
  const [activeTab, setActiveTab] = useState<SettingsTabId>('model')
  const [draft, setDraft] = useState<ApiConfigDto>(initialForm.draft)
  /** 模型名称输入框：每行一个（也接受逗号分隔），保存时拆成 models 列表 */
  const [modelText, setModelText] = useState(initialForm.modelText)
  const [mmBaseUrl, setMmBaseUrl] = useState(initialForm.mmBaseUrl)
  const [mmApiKey, setMmApiKey] = useState(initialForm.mmApiKey)
  const [mmModel, setMmModel] = useState(initialForm.mmModel)
  const [mmPreparse, setMmPreparse] = useState(initialForm.mmPreparse)
  const [asrBaseUrl, setAsrBaseUrl] = useState(initialForm.asrBaseUrl)
  const [asrApiKey, setAsrApiKey] = useState(initialForm.asrApiKey)
  const [asrModel, setAsrModel] = useState(initialForm.asrModel)
  const [search, setSearch] = useState<SearchDraft>(initialForm.search)
  const [engines, setEngines] = useState<SearchEngineDto[]>([])
  const [profileName, setProfileName] = useState(initialForm.profileName)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [saveError, setSaveError] = useState('')

  const autoSaveTimerRef = useRef<number | null>(null)
  const lastSyncedSignatureRef = useRef(settingsDraftSignature(initialForm))
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const saveGenerationRef = useRef(0)
  const closingRef = useRef(false)
  const closePageRef = useRef<() => void>(() => {})

  const form: SettingsDraftValues = {
    profileName,
    draft,
    modelText,
    mmBaseUrl,
    mmApiKey,
    mmModel,
    mmPreparse,
    asrBaseUrl,
    asrApiKey,
    asrModel,
    search
  }
  const signature = settingsDraftSignature(form)

  // 每次打开都回到「模型配置」：设置页像独立页面一样，从最常用的一块进入。
  useEffect(() => {
    if (open) {
      setActiveTab('model')
    }
  }, [open])

  // 引擎目录来自主进程（单一事实来源在 core 的 LocalWebSearch）。
  // 只在打开时拉一次，切配置方案导致 settings 更新时不必重复请求。
  useEffect(() => {
    if (!open) {
      return
    }
    void window.guncat.settings
      .searchEngines()
      .then(setEngines)
      .catch(() => setEngines([]))
  }, [open])

  // 自动保存：任何字段变化后先等一小段输入停顿，再落盘。
  // 这里刻意不 reloadSettings —— 设置页是整页覆盖，顶栏此刻不可见；
  // 若每次按键都刷新全局设置，会让输入框反复重渲染，正是「顿挫」的来源。
  // 关闭设置页时再统一刷新一次，顶栏的模型胶囊就能拿到最新配置。
  useEffect(() => {
    if (!open) {
      return
    }
    if (signature === lastSyncedSignatureRef.current) {
      // 改了又改回原值：已排队的定时器会被 cleanup 清掉，状态也要回到「已保存」
      if (saveState === 'saving') {
        setSaveState('saved')
      }
      return
    }
    setSaveState('saving')
    setSaveError('')
    const timer = window.setTimeout(() => {
      autoSaveTimerRef.current = null
      lastSyncedSignatureRef.current = signature
      void enqueuePersist(form)
    }, AUTO_SAVE_DELAY)
    autoSaveTimerRef.current = timer
    return () => {
      window.clearTimeout(timer)
      if (autoSaveTimerRef.current === timer) {
        autoSaveTimerRef.current = null
      }
    }
  }, [open, signature])

  // Esc 关闭设置页，和常见桌面应用的设置页一致。
  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closePageRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!open) {
    return null
  }

  const profiles = settings?.apiProfiles ?? []
  const parsedModels = parseModelNames(modelText)
  /** 当前生效模型：列表里还留着就用它，删掉了就退回第一个（和落盘口径一致） */
  const effectiveModel = parsedModels.includes(draft.model.trim())
    ? draft.model.trim()
    : (parsedModels[0] ?? '')

  /** 用最新设置回填整页草稿。切方案 / 新建 / 删除后调用，避免旧方案的内容串到新方案。 */
  function hydrateFrom(next: AppSettingsDto | null): void {
    const nextForm = readSettingsDraft(next)
    setDraft(nextForm.draft)
    setModelText(nextForm.modelText)
    setProfileName(nextForm.profileName)
    setMmBaseUrl(nextForm.mmBaseUrl)
    setMmApiKey(nextForm.mmApiKey)
    setMmModel(nextForm.mmModel)
    setMmPreparse(nextForm.mmPreparse)
    setAsrBaseUrl(nextForm.asrBaseUrl)
    setAsrApiKey(nextForm.asrApiKey)
    setAsrModel(nextForm.asrModel)
    setSearch(nextForm.search)
    setSaveState('saved')
    setSaveError('')
    lastSyncedSignatureRef.current = settingsDraftSignature(nextForm)
  }

  /** 把当前草稿排进保存队列。队列保证两次保存不会同时写盘。 */
  function enqueuePersist(values: SettingsDraftValues): Promise<void> {
    const generation = ++saveGenerationRef.current
    const task = async (): Promise<void> => {
      setSaveState('saving')
      try {
        const models = parseModelNames(values.modelText)
        const activeModel = models.includes(values.draft.model.trim())
          ? values.draft.model.trim()
          : (models[0] ?? '')
        // 一次性保存当前配置方案（名称 + API 配置 + 多模态配置）。
        // 走这条而不是分开调 saveApiConfig / saveMultimodalConfig：
        // 方案才是这几项配置的归属，分开调会让「名称改了但没落到方案上」这类半更新出现。
        await window.guncat.settings.saveCurrentApiProfile(
          values.profileName.trim(),
          normalizeApiConfig({ ...values.draft, model: activeModel, models }),
          normalizeMultimodal({
            baseUrl: values.mmBaseUrl,
            apiKey: values.mmApiKey,
            model: values.mmModel,
            preparseEnabled: values.mmPreparse
          })
        )
        await window.guncat.settings.saveString('asr_baseUrl', values.asrBaseUrl.trim())
        await window.guncat.settings.saveString('asr_apiKey', values.asrApiKey.trim())
        await window.guncat.settings.saveString('asr_model', values.asrModel.trim())
        await window.guncat.settings.saveString(
          LOCAL_SEARCH_PREF_KEY,
          JSON.stringify(normalizeSearch(values.search))
        )
        if (generation === saveGenerationRef.current) {
          setSaveState('saved')
          setSaveError('')
        }
      } catch (e) {
        if (generation === saveGenerationRef.current) {
          setSaveState('error')
          setSaveError(String(e))
        }
      }
    }
    const next = saveChainRef.current.then(task, task)
    saveChainRef.current = next
    return next
  }

  function cancelScheduledSave(): void {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
  }

  /** 立即落盘当前草稿（关闭页面、切换方案前调用）。 */
  function flushPending(): Promise<void> {
    cancelScheduledSave()
    if (signature === lastSyncedSignatureRef.current && saveState !== 'error') {
      return saveChainRef.current
    }
    lastSyncedSignatureRef.current = signature
    return enqueuePersist(form)
  }

  /** 关闭设置页：先保存并刷新全局设置，再收起页面。 */
  async function closePage(): Promise<void> {
    if (closingRef.current) {
      return
    }
    closingRef.current = true
    try {
      await flushPending()
    } catch {
      // 具体错误已由状态栏展示；关闭动作不能被一次写盘失败卡住
    }
    try {
      await reloadSettings()
    } catch {
      // 刷新失败不影响关闭，下次打开设置页会重新读取
    }
    openSettings(false)
    closingRef.current = false
  }

  closePageRef.current = () => {
    void closePage()
  }

  /** 切换配置方案：先把当前方案存好，再让主进程把目标方案写回运行时配置 */
  async function switchProfile(profileId: string): Promise<void> {
    if (profileId === settings?.currentApiProfileId) {
      return
    }
    try {
      await flushPending()
      await window.guncat.settings.selectApiProfile(profileId)
      const next = await window.guncat.settings.load()
      useStore.setState({ settings: next })
      hydrateFrom(next)
    } catch (e) {
      pushNotice('error', `切换配置方案失败：${String(e)}`)
    }
  }

  async function addProfile(): Promise<void> {
    try {
      await flushPending()
      await window.guncat.settings.addApiProfile()
      const next = await window.guncat.settings.load()
      useStore.setState({ settings: next })
      hydrateFrom(next)
      pushNotice('info', '已新建配置方案（内容复制自当前方案，改名会自动保存）')
    } catch (e) {
      pushNotice('error', `新建配置方案失败：${String(e)}`)
    }
  }

  async function removeProfile(): Promise<void> {
    if (profiles.length <= 1) {
      pushNotice('warn', '至少要保留一个配置方案')
      return
    }
    const currentId = settings?.currentApiProfileId ?? ''
    if (currentId === '') {
      return
    }
    try {
      // 正在保存的请求必须先落定，避免旧方案的内容在删除后写进新方案
      cancelScheduledSave()
      await saveChainRef.current
      await window.guncat.settings.deleteApiProfile(currentId)
      const next = await window.guncat.settings.load()
      useStore.setState({ settings: next })
      hydrateFrom(next)
      pushNotice('info', '已删除当前配置方案')
    } catch (e) {
      pushNotice('error', `删除配置方案失败：${String(e)}`)
    }
  }

  function update<K extends keyof ApiConfigDto>(key: K, value: ApiConfigDto[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function updateSearch<K extends keyof SearchDraft>(key: K, value: SearchDraft[K]): void {
    setSearch((s) => ({ ...s, [key]: value }))
  }

  /** 当前引擎的 Key 落在哪个字段上（与原版 SettingsPanel 的 apiKeyForEngine 同口径） */
  function searchKeyField(engine: string): keyof SearchDraft | '' {
    switch (engine) {
      case 'brave':
        return 'braveApiKey'
      case 'tavily':
        return 'tavilyApiKey'
      case 'exa':
        return 'exaApiKey'
      case 'metaso':
        return 'metasoApiKey'
      case 'firecrawl':
        return 'firecrawlApiKey'
      default:
        return ''
    }
  }

  function searchBaseUrlField(engine: string): keyof SearchDraft | '' {
    switch (engine) {
      case 'tavily':
        return 'tavilyBaseUrl'
      case 'exa':
        return 'exaBaseUrl'
      case 'firecrawl':
        return 'firecrawlBaseUrl'
      default:
        return ''
    }
  }

  const provider = providerCopy(draft.provider)
  const keyField = searchKeyField(search.engine)
  const baseUrlField = searchBaseUrlField(search.engine)
  const active = SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0]

  return (
    <div className="settings-page" role="dialog" aria-modal="true" aria-label="设置">
      <header className="settings-page__head">
        <div className="settings-page__brand">
          <span className="settings-page__icon" aria-hidden="true">
            <IconSettings size={20} />
          </span>
          <div className="settings-page__brandcopy">
            <h1>设置</h1>
            <p>模型接入、联网搜索与语音偏好</p>
          </div>
        </div>
        <button className="icon-btn" title="关闭设置" onClick={() => void closePage()}>
          <IconClose size={16} />
        </button>
      </header>

      <div className="settings-page__body">
        <nav className="settings-nav" aria-label="设置分类">
          {SETTINGS_NAV.map((group) => (
            <div className="settings-nav__group" key={group.label}>
              <div className="settings-nav__label">{group.label}</div>
              {group.items.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className="settings-nav__item"
                  data-active={tab.id === activeTab}
                  aria-current={tab.id === activeTab ? 'page' : undefined}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="settings-nav__icon">{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="settings-page__content">
          <div className="settings-content">
            <div className="settings-content__head">
              <h2>{active.title}</h2>
              <p>{active.description}</p>
            </div>

            <div className="settings-form">
              {activeTab === 'model' ? (
                <>
                  {/* 配置方案（对齐原版 SettingsPanel 顶部的「配置方案 / 配置名称」）：
                      可以并存多套 API 配置并在其间一键切换，出错时也能两套轮流试。 */}
                  <SettingsCard
                    title="配置方案"
                    description="多套 API 配置可以并存，随时切换，互不覆盖。"
                  >
                    <div className="field field--row">
                      <SettingsField label="配置方案">
                        <select
                          value={settings?.currentApiProfileId ?? ''}
                          onChange={(e) => void switchProfile(e.target.value)}
                        >
                          {profiles.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.id === settings?.currentApiProfileId && profileName.trim() !== ''
                                ? profileName
                                : p.name}
                            </option>
                          ))}
                        </select>
                      </SettingsField>
                      <SettingsField label="配置名称">
                        <input
                          value={profileName}
                          placeholder="未命名配置"
                          onChange={(e) => setProfileName(e.target.value)}
                        />
                      </SettingsField>
                    </div>
                    <div className="settings-actions">
                      <button className="btn btn--sm" onClick={() => void addProfile()}>
                        新建配置
                      </button>
                      <button
                        className="btn btn--sm btn--danger"
                        disabled={profiles.length <= 1}
                        title={
                          profiles.length <= 1
                            ? '至少要保留一个配置方案'
                            : '删除当前配置方案'
                        }
                        onClick={() => void removeProfile()}
                      >
                        删除当前配置
                      </button>
                    </div>
                  </SettingsCard>

                  <SettingsCard
                    title="接口与密钥"
                    description="选择协议、填写服务地址与 API Key。"
                  >
                    <SettingsField label="接入方式">
                      <select
                        value={draft.provider}
                        onChange={(e) => update('provider', e.target.value)}
                      >
                        {PROVIDERS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </SettingsField>

                    <SettingsField label="Base URL">
                      <input
                        value={draft.baseUrl}
                        placeholder={provider.baseUrlPlaceholder}
                        onChange={(e) => update('baseUrl', e.target.value)}
                      />
                    </SettingsField>

                    {/* 协议路径后缀补全开关：自建网关/代理常需要关掉它 */}
                    <SettingsToggle
                      divider
                      checked={draft.autoSuffix}
                      title="自动补全协议路径后缀"
                      description={
                        draft.autoSuffix
                          ? `开启后按接入方式自动拼接路径后缀（如 ${provider.suffix}）`
                          : '关闭后严格按上面填写的 Base URL 发起请求，适合非标准路径的自建网关/代理'
                      }
                      onChange={(checked) => update('autoSuffix', checked)}
                    />

                    <SettingsField
                      label="API Key"
                      hint={credentialHint(settings?.credentialState)}
                    >
                      <input
                        type="password"
                        value={draft.apiKey}
                        placeholder="sk-…"
                        onChange={(e) => update('apiKey', e.target.value)}
                      />
                    </SettingsField>
                  </SettingsCard>

                  <SettingsCard
                    title="可用模型"
                    description="一个方案可以填写多个模型，保存后可在顶栏的模型胶囊里切换。"
                  >
                    <SettingsField
                      label="模型（可填多个，每行一个或逗号分隔）"
                      hint={
                        effectiveModel !== ''
                          ? `当前使用：${effectiveModel}（在顶栏的模型胶囊里切换具体模型）`
                          : '填写后，当前模型会在顶栏的模型胶囊里显示并切换'
                      }
                    >
                      <textarea
                        rows={4}
                        value={modelText}
                        placeholder={provider.modelPlaceholder}
                        onChange={(e) => setModelText(e.target.value)}
                      />
                    </SettingsField>
                  </SettingsCard>

                  {/* 接入方式说明（原版 getHint() 的三段文案，随接入方式变化）。 */}
                  <SettingsNote>{provider.hint}</SettingsNote>
                </>
              ) : null}

              {activeTab === 'advanced' ? (
                <>
                  <SettingsCard
                    title="采样参数"
                    description="留空或填 0 表示使用服务端默认值。"
                  >
                    <div className="field field--row">
                      <SettingsField
                        label="Temperature（0 = 用服务端默认）"
                        hint="数值越低回答越确定, 越高越随机。"
                      >
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="2"
                          value={draft.temperature}
                          onChange={(e) => update('temperature', Number(e.target.value))}
                        />
                      </SettingsField>
                      <SettingsField label="Top P（0 = 用服务端默认）">
                        <input
                          type="number"
                          step="0.05"
                          min="0"
                          max="1"
                          value={draft.topP}
                          onChange={(e) => update('topP', Number(e.target.value))}
                        />
                      </SettingsField>
                    </div>

                    <SettingsField label="最大输出 Token（0 = 用服务端默认）">
                      <input
                        type="number"
                        min="0"
                        value={draft.maxTokens}
                        onChange={(e) => update('maxTokens', Number(e.target.value))}
                      />
                    </SettingsField>
                  </SettingsCard>

                  {/* 额外请求参数用多行 TextArea（原版 449-458）：一段 JSON 挤在单行输入框里
                      既看不全也难改，4 行高度正好容下常见的两个键。 */}
                  <SettingsCard
                    title="额外请求参数"
                    description="会合并到请求体中，适合自定义 provider 专属参数。"
                  >
                    <SettingsField label="额外请求参数（JSON）">
                      <textarea
                        rows={4}
                        value={draft.extraParams}
                        placeholder='{"presence_penalty": 0, "frequency_penalty": 0}'
                        onChange={(e) => update('extraParams', e.target.value)}
                      />
                    </SettingsField>
                  </SettingsCard>
                </>
              ) : null}

              {activeTab === 'search' ? (
                <>
                  <SettingsNote>{SEARCH_INTRO}</SettingsNote>

                  <SettingsCard
                    title="搜索引擎"
                    description="选择本机直连的搜索通道，并设置单次返回的条数。"
                  >
                    <div className="field field--row">
                      <SettingsField label="搜索引擎">
                        <select
                          value={search.engine}
                          onChange={(e) => updateSearch('engine', e.target.value)}
                        >
                          {engines.length === 0 ? (
                            <option value={search.engine}>{search.engine}</option>
                          ) : (
                            engines.map((engine) => (
                              <option key={engine.id} value={engine.id}>
                                {engine.label}
                              </option>
                            ))
                          )}
                        </select>
                      </SettingsField>
                      <SettingsField label="单次结果条数">
                        <input
                          type="number"
                          min="1"
                          max="20"
                          value={search.maxResults}
                          onChange={(e) => updateSearch('maxResults', Number(e.target.value))}
                        />
                      </SettingsField>
                    </div>

                    {keyField !== '' ? (
                      <SettingsField label="API Key">
                        <input
                          type="password"
                          value={String(search[keyField])}
                          placeholder="当前搜索引擎的 API Key"
                          onChange={(e) => updateSearch(keyField, e.target.value)}
                        />
                      </SettingsField>
                    ) : null}

                    {baseUrlField !== '' ? (
                      <SettingsField label="Base URL（可选）">
                        <input
                          value={String(search[baseUrlField])}
                          placeholder="留空使用默认地址"
                          onChange={(e) => updateSearch(baseUrlField, e.target.value)}
                        />
                      </SettingsField>
                    ) : null}

                    <div className="field__hint">{searchEngineHint(search.engine)}</div>
                  </SettingsCard>
                </>
              ) : null}

              {activeTab === 'multimodal' ? (
                <>
                  <SettingsCard
                    title="附件解析"
                    description="开启后，图片和文档会先由独立的多模态模型转成文本。"
                  >
                    <SettingsToggle
                      checked={mmPreparse}
                      title="先行解析附件"
                      description={
                        mmPreparse
                          ? '开启后先由下方独立 API 解析，再将文本交给主模型'
                          : '关闭后图片和文档将直接传给当前接入方式的主模型'
                      }
                      onChange={setMmPreparse}
                    />
                  </SettingsCard>

                  <SettingsNote>
                    默认使用 GLM-4.6V-Flash（免费API调用，请在智谱官网获取API Key），推荐使用
                    Doubao-Seed-2.0-mini 等轻量多模态模型。
                  </SettingsNote>

                  {/* 三个字段整组只在「先行解析附件」开启时显示（原版 535-578）：
                      关闭时它们不参与任何请求，露在外面只会让人以为填了就会生效。 */}
                  {mmPreparse ? (
                    <SettingsCard
                      title="解析接口"
                      description="留空时使用默认地址与默认模型。"
                    >
                      <SettingsField label="Base URL">
                        <input
                          value={mmBaseUrl}
                          placeholder="https://open.bigmodel.cn/api/paas/v4"
                          onChange={(e) => setMmBaseUrl(e.target.value)}
                        />
                      </SettingsField>
                      <SettingsField label="API Key">
                        <input
                          type="password"
                          value={mmApiKey}
                          placeholder="..."
                          onChange={(e) => setMmApiKey(e.target.value)}
                        />
                      </SettingsField>
                      <SettingsField label="模型名称">
                        <input
                          value={mmModel}
                          placeholder="glm-4.6v-flash"
                          onChange={(e) => setMmModel(e.target.value)}
                        />
                      </SettingsField>
                    </SettingsCard>
                  ) : null}
                </>
              ) : null}

              {activeTab === 'auto-read' ? (
                <>
                  <SettingsCard
                    title="自动朗读"
                    description="开关立即生效，不需要点击保存。"
                  >
                    <SettingsToggle
                      checked={autoRead}
                      title="自动朗读回答"
                      description={
                        autoRead
                          ? '开启后每轮回答生成完会自动念一遍'
                          : '关闭后不会自动朗读，仍可在消息操作行手动朗读单条回答'
                      }
                      onChange={setAutoRead}
                    />
                  </SettingsCard>

                  <SettingsNote>
                    音色与语速在应用底部的朗读控制条里调整；关闭开关时，正在朗读的内容会立刻停止。
                  </SettingsNote>
                </>
              ) : null}

              {activeTab === 'voice-input' ? (
                <>
                  <SettingsNote>
                    桌面端没有端侧识别可用，走 OpenAI 兼容的 /audio/transcriptions 接口。
                    留空则复用「多模态解析」里填写的地址与 Key。
                  </SettingsNote>

                  <SettingsCard
                    title="转写接口"
                    description="录音会发送到这里的接口转成文字。"
                  >
                    <SettingsField label="转写 Base URL（可选）">
                      <input
                        value={asrBaseUrl}
                        placeholder={
                          mmBaseUrl !== ''
                            ? `默认复用：${mmBaseUrl}`
                            : 'https://api.openai.com/v1'
                        }
                        onChange={(e) => setAsrBaseUrl(e.target.value)}
                      />
                    </SettingsField>
                    <SettingsField label="转写 API Key（可选）">
                      <input
                        type="password"
                        value={asrApiKey}
                        placeholder={mmApiKey !== '' ? '默认复用多模态解析的 Key' : 'sk-…'}
                        onChange={(e) => setAsrApiKey(e.target.value)}
                      />
                    </SettingsField>
                    <SettingsField label="转写模型">
                      <input
                        value={asrModel}
                        placeholder="whisper-1"
                        onChange={(e) => setAsrModel(e.target.value)}
                      />
                    </SettingsField>
                  </SettingsCard>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <footer className="settings-page__foot">
        <span
          className="settings-page__status"
          data-state={saveState}
          role="status"
          aria-live="polite"
          title={saveError !== '' ? saveError : undefined}
        >
          {saveState === 'saving'
            ? '正在保存…'
            : saveState === 'error'
              ? '保存失败'
              : '所有更改已自动保存'}
        </span>
        {saveState === 'error' ? (
          <button className="btn btn--ghost btn--sm" onClick={() => void flushPending()}>
            重试
          </button>
        ) : null}
        <button className="btn" onClick={() => void closePage()}>
          关闭
        </button>
      </footer>
    </div>
  )
}
