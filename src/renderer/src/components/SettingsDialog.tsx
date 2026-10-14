import { useEffect, useState } from 'react'
import type { ApiConfigDto, SearchEngineDto } from '@ipc/contract'
import { useStore } from '../store'
import { IconClose } from '../icons'

const PROVIDERS: Array<{ id: string; label: string; baseUrl: string; hint: string }> = [
  {
    id: 'openai-completions',
    label: 'OpenAI Completions（/chat/completions）',
    baseUrl: 'https://api.deepseek.com',
    hint: '最通用的兼容协议'
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses（/responses）',
    baseUrl: 'https://api.deepseek.com',
    hint: 'DeepSeek / 火山方舟等，支持原生联网搜索'
  },
  {
    id: 'anthropic-messages',
    label: 'Anthropic Messages（/messages）',
    baseUrl: 'https://api.deepseek.com/anthropic',
    hint: 'Anthropic 官方或 DeepSeek 的 Anthropic 兼容入口'
  }
]

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
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
}

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen)
  const openSettings = useStore((s) => s.openSettings)
  const settings = useStore((s) => s.settings)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const pushNotice = useStore((s) => s.pushNotice)

  const [draft, setDraft] = useState<ApiConfigDto>(EMPTY)
  const [mmBaseUrl, setMmBaseUrl] = useState('')
  const [mmApiKey, setMmApiKey] = useState('')
  const [mmModel, setMmModel] = useState('')
  const [mmPreparse, setMmPreparse] = useState(true)
  const [asrBaseUrl, setAsrBaseUrl] = useState('')
  const [asrApiKey, setAsrApiKey] = useState('')
  const [asrModel, setAsrModel] = useState('')
  const [search, setSearch] = useState<SearchDraft>(EMPTY_SEARCH)
  const [engines, setEngines] = useState<SearchEngineDto[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    setDraft(settings?.apiConfig ?? EMPTY)
    setMmBaseUrl(settings?.multimodalConfig.baseUrl ?? '')
    setMmApiKey(settings?.multimodalConfig.apiKey ?? '')
    setMmModel(settings?.multimodalConfig.model ?? '')
    setMmPreparse(settings?.multimodalConfig.preparseEnabled ?? true)
    setAsrBaseUrl(settings?.prefs?.asr_baseUrl ?? '')
    setAsrApiKey(settings?.prefs?.asr_apiKey ?? '')
    setAsrModel(settings?.prefs?.asr_model ?? '')
    setSearch(parseSearchDraft(settings?.prefs?.[LOCAL_SEARCH_PREF_KEY]))
    // 引擎目录来自主进程（单一事实来源在 core 的 LocalWebSearch）
    void window.guncat.settings
      .searchEngines()
      .then(setEngines)
      .catch(() => setEngines([]))
  }, [open, settings])

  if (!open) {
    return null
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

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await window.guncat.settings.saveApiConfig(draft)
      await window.guncat.settings.saveMultimodalConfig({
        baseUrl: mmBaseUrl,
        apiKey: mmApiKey,
        model: mmModel,
        preparseEnabled: mmPreparse
      })
      await window.guncat.settings.saveString('asr_baseUrl', asrBaseUrl)
      await window.guncat.settings.saveString('asr_apiKey', asrApiKey)
      await window.guncat.settings.saveString('asr_model', asrModel)
      await window.guncat.settings.saveString(
        LOCAL_SEARCH_PREF_KEY,
        JSON.stringify(search)
      )
      await reloadSettings()
      pushNotice('info', '设置已保存')
      openSettings(false)
    } catch (e) {
      pushNotice('error', `保存失败：${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const provider = PROVIDERS.find((p) => p.id === draft.provider)
  const engineInfo = engines.find((e) => e.id === search.engine)
  const keyField = searchKeyField(search.engine)
  const baseUrlField = searchBaseUrlField(search.engine)

  return (
    <div className="overlay" onClick={() => openSettings(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <span>设置</span>
          <button className="icon-btn" title="关闭" onClick={() => openSettings(false)}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="dialog__body">
          <div className="field">
            <label>接入方式</label>
            <select value={draft.provider} onChange={(e) => update('provider', e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {provider !== undefined ? (
              <div className="field__hint">{provider.hint}</div>
            ) : null}
          </div>

          <div className="field">
            <label>Base URL</label>
            <input
              value={draft.baseUrl}
              placeholder={provider?.baseUrl ?? 'https://…'}
              onChange={(e) => update('baseUrl', e.target.value)}
            />
            <div className="field__hint">
              协议路径后缀会自动补全（如 /chat/completions、/v1/messages）
            </div>
          </div>

          {/* 协议路径后缀补全开关（对齐原版 SettingsPanel）：自建网关/代理常需要关掉它 */}
          <label className="check">
            <input
              type="checkbox"
              checked={draft.autoSuffix}
              onChange={(e) => update('autoSuffix', e.target.checked)}
            />
            <span>
              自动补全协议路径后缀
              <em>
                {draft.autoSuffix
                  ? `开启后按接入方式自动拼接路径后缀（如 ${provider?.id === 'anthropic-messages' ? '/v1/messages' : provider?.id === 'openai-responses' ? '/responses' : '/chat/completions'}）`
                  : '关闭后严格按上面填写的 Base URL 发起请求，适合非标准路径的自建网关/代理'}
              </em>
            </span>
          </label>

          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              value={draft.apiKey}
              placeholder="sk-…"
              onChange={(e) => update('apiKey', e.target.value)}
            />
            <div className="field__hint">仅保存在本机应用数据目录，不会上传</div>
          </div>

          <div className="field">
            <label>模型</label>
            <input
              value={draft.model}
              placeholder="deepseek-chat / claude-sonnet-4-5 …"
              onChange={(e) => update('model', e.target.value)}
            />
          </div>

          <div className="field field--row">
            <div>
              <label>Temperature（0 = 用服务端默认）</label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={draft.temperature}
                onChange={(e) => update('temperature', Number(e.target.value))}
              />
            </div>
            <div>
              <label>Top P（0 = 用服务端默认）</label>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={draft.topP}
                onChange={(e) => update('topP', Number(e.target.value))}
              />
            </div>
          </div>

          <div className="field">
            <label>最大输出 Token（0 = 用服务端默认）</label>
            <input
              type="number"
              min="0"
              value={draft.maxTokens}
              onChange={(e) => update('maxTokens', Number(e.target.value))}
            />
          </div>

          <div className="field">
            <label>额外请求参数（JSON）</label>
            <textarea
              rows={2}
              value={draft.extraParams}
              placeholder='{"enable_search": true}'
              onChange={(e) => update('extraParams', e.target.value)}
            />
          </div>

          <div
            style={{
              borderTop: '1px solid var(--border)',
              margin: '18px 0 14px',
              paddingTop: 14,
              fontSize: 12,
              color: 'var(--text-muted)'
            }}
          >
            多模态预解析（可选，用于解析图片/文档）
          </div>

          <div className="field">
            <label>预解析 Base URL</label>
            <input value={mmBaseUrl} onChange={(e) => setMmBaseUrl(e.target.value)} />
          </div>
          <div className="field">
            <label>预解析 API Key</label>
            <input
              type="password"
              value={mmApiKey}
              onChange={(e) => setMmApiKey(e.target.value)}
            />
          </div>
          <div className="field">
            <label>预解析模型</label>
            <input value={mmModel} onChange={(e) => setMmModel(e.target.value)} />
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={mmPreparse}
              onChange={(e) => setMmPreparse(e.target.checked)}
            />
            <span>
              先行解析附件
              <em>
                开启后，上传的图片/文档会先用上面的服务商解析成文字再进对话；
                关闭则只把图片作为多模态内容直接发给主模型
              </em>
            </span>
          </label>

          <div
            style={{
              borderTop: '1px solid var(--border)',
              margin: '18px 0 14px',
              paddingTop: 14,
              fontSize: 12,
              color: 'var(--text-muted)'
            }}
          >
            本地联网搜索（本机直连搜索引擎，不经过模型服务商）
          </div>
          <div className="field__hint" style={{ marginBottom: 10, marginTop: -6 }}>
            模型调用 local_web_search 时用这里的配置。默认引擎不需要 Key。
          </div>

          <div className="field field--row">
            <div>
              <label>搜索引擎</label>
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
            </div>
            <div>
              <label>单次结果条数</label>
              <input
                type="number"
                min="1"
                max="20"
                value={search.maxResults}
                onChange={(e) => updateSearch('maxResults', Number(e.target.value))}
              />
            </div>
          </div>

          {keyField !== '' ? (
            <div className="field">
              <label>搜索 API Key</label>
              <input
                type="password"
                value={String(search[keyField])}
                placeholder="sk-…"
                onChange={(e) => updateSearch(keyField, e.target.value)}
              />
            </div>
          ) : (
            <div className="field__hint" style={{ marginTop: -4 }}>
              {engineInfo !== undefined ? `${engineInfo.label} 不需要 API Key` : '当前引擎不需要 API Key'}
            </div>
          )}

          {baseUrlField !== '' ? (
            <div className="field">
              <label>搜索 Base URL（可选）</label>
              <input
                value={String(search[baseUrlField])}
                onChange={(e) => updateSearch(baseUrlField, e.target.value)}
              />
            </div>
          ) : null}

          <div
            style={{
              borderTop: '1px solid var(--border)',
              margin: '18px 0 14px',
              paddingTop: 14,
              fontSize: 12,
              color: 'var(--text-muted)'
            }}
          >
            语音输入（录音转文字）
          </div>
          <div className="field__hint" style={{ marginBottom: 10, marginTop: -6 }}>
            桌面端没有端侧识别可用，走 OpenAI 兼容的 /audio/transcriptions 接口。
            留空则复用上面的「多模态预解析」地址与 Key。
          </div>

          <div className="field">
            <label>转写 Base URL（可选）</label>
            <input
              value={asrBaseUrl}
              placeholder={mmBaseUrl !== '' ? `默认复用：${mmBaseUrl}` : 'https://api.openai.com/v1'}
              onChange={(e) => setAsrBaseUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label>转写 API Key（可选）</label>
            <input
              type="password"
              value={asrApiKey}
              placeholder={mmApiKey !== '' ? '默认复用多模态预解析的 Key' : 'sk-…'}
              onChange={(e) => setAsrApiKey(e.target.value)}
            />
          </div>
          <div className="field">
            <label>转写模型</label>
            <input
              value={asrModel}
              placeholder="whisper-1"
              onChange={(e) => setAsrModel(e.target.value)}
            />
          </div>
        </div>

        <div className="dialog__foot">
          <button className="btn" onClick={() => openSettings(false)}>
            取消
          </button>
          <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
