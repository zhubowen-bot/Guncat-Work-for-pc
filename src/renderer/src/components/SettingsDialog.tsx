import { useEffect, useState } from 'react'
import type { ApiConfigDto } from '@ipc/contract'
import { useStore } from '../store'

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

const EMPTY: ApiConfigDto = {
  provider: 'openai-completions',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: ''
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
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    setDraft(settings?.apiConfig ?? EMPTY)
    setMmBaseUrl(settings?.multimodalConfig.baseUrl ?? '')
    setMmApiKey(settings?.multimodalConfig.apiKey ?? '')
    setMmModel(settings?.multimodalConfig.model ?? '')
  }, [open, settings])

  if (!open) {
    return null
  }

  function update<K extends keyof ApiConfigDto>(key: K, value: ApiConfigDto[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await window.guncat.settings.saveApiConfig(draft)
      await window.guncat.settings.saveMultimodalConfig({
        baseUrl: mmBaseUrl,
        apiKey: mmApiKey,
        model: mmModel,
        preparseEnabled: settings?.multimodalConfig.preparseEnabled ?? true
      })
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

  return (
    <div className="overlay" onClick={() => openSettings(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <span>设置</span>
          <button className="btn btn--ghost" onClick={() => openSettings(false)}>
            ✕
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
