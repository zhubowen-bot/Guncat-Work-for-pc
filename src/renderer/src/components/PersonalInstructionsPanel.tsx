// 个性化指令面板：设置 →「模型与能力」→「个性化指令」的列表 + 编辑视图。
//
// 形态按电脑版设置页来：不新增独立路由，整块落在右侧内容区里 ——
// 列表态是空态卡片 / 条目列表，编辑态在同一位置换成「名称 + 指令内容 + 生效范围」三张卡。
// 交互口径对齐鸿蒙版 PersonalInstructionEditPage.ets：
//   · 保存的始终是用户原文，Markdown 渲染只切换本编辑视图的预览（落盘内容不变）；
//   · 新建默认勾选「交互模式 + 工作模式」；
//   · 删除、以及「有未保存修改时返回」都用页内两步确认，不弹系统对话框；
//   · 名称可选（40 字上限），正文 8000 字上限；
//   · 生效范围 = 两个模式 + agents.json 里全部聊天引擎（store.agents 不含 work/interactive 虚拟项）。
//
// 数据来源与落盘：
//   · 初始条目从 settings.prefs[Constants.LS_KEY_PERSONAL_INSTRUCTIONS] 用 parseList 解析；
//   · 保存走 window.guncat.settings.saveString(... JSON ...)，主进程会同步运行态，
//     随后 reloadSettings() 把最新设置读回 store，列表与其它页面立即更新。
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentDto } from '@ipc/contract'
import { Constants } from '@core/common/Constants'
import { PersonalInstruction } from '@core/model/PersonalInstruction'
import { PersonalInstructionPrompt } from '@core/common/PersonalInstructionPrompt'
import { useStore } from '../store'
import { Markdown } from './Markdown'
import {
  IconArrowLeft,
  IconCheckCircle,
  IconChevronRight,
  IconCircle,
  IconFile,
  IconPersonalInstructions,
  IconPlus,
  IconTrash
} from '../icons'

/** 两个固定模式范围：文案对齐鸿蒙版编辑页的副标题 */
const MODE_SCOPES: Array<{ scope: string; title: string; subtitle: string }> = [
  {
    scope: PersonalInstructionPrompt.SCOPE_INTERACTIVE,
    title: '交互模式',
    subtitle: '每轮回答直接交付可操作界面'
  },
  {
    scope: PersonalInstructionPrompt.SCOPE_WORK,
    title: '工作模式',
    subtitle: '多轮工具循环，完成长程任务'
  }
]

/** 编辑视图的草稿；id 为空串表示新建 */
interface EditorDraft {
  id: string
  name: string
  content: string
  scopes: string[]
}

/** 打开编辑视图时的原始快照，用于判断「有没有未保存的修改」 */
interface OriginalSnapshot {
  name: string
  content: string
  scopesKey: string
}

/**
 * 生效范围的稳定顺序：交互模式 → 工作模式 → 聊天引擎（agents.json 顺序）。
 * 展示与保存都用这个顺序，避免「先勾引擎再勾模式」导致落盘顺序随点击变化。
 */
function scopeOrderOf(agents: AgentDto[]): string[] {
  const order: string[] = [
    PersonalInstructionPrompt.SCOPE_INTERACTIVE,
    PersonalInstructionPrompt.SCOPE_WORK
  ]
  for (const agent of agents) {
    order.push(agent.id)
  }
  return order
}

/** 范围的可读名：两个模式有固定中文名；聊天引擎取 agents 里的显示名；找不到原样显示 id */
function scopeLabel(scope: string, agents: AgentDto[]): string {
  const fixed = PersonalInstructionPrompt.fixedScopeLabel(scope)
  if (fixed !== '') {
    return fixed
  }
  const agent = agents.find((item) => item.id === scope)
  return agent !== undefined ? agent.name : scope
}

function sortedScopes(scopes: string[], order: string[]): string[] {
  return PersonalInstruction.sortScopesByOrder(scopes, order)
}

/** 用集合语义比较范围，避免「取消又勾上」这类顺序变化被误判成有未保存修改 */
function scopesKey(scopes: string[]): string {
  return [...scopes].sort().join('|')
}

function snapshotOf(draft: EditorDraft): OriginalSnapshot {
  return { name: draft.name, content: draft.content, scopesKey: scopesKey(draft.scopes) }
}

/** 由条目（或 null = 新建）生成草稿；新建默认勾选交互模式 + 工作模式 */
function draftOf(item: PersonalInstruction | null, order: string[]): EditorDraft {
  if (item === null) {
    return {
      id: '',
      name: '',
      content: '',
      scopes: [PersonalInstructionPrompt.SCOPE_INTERACTIVE, PersonalInstructionPrompt.SCOPE_WORK]
    }
  }
  return {
    id: item.id,
    name: item.name,
    content: item.content,
    scopes: sortedScopes(item.scopes, order)
  }
}

/**
 * 保存前的校验（纯函数，SSR 断言也用它）：
 * 返回空串表示可以保存，否则是提示给用户的原因。
 * 校验口径对齐鸿蒙版 save()：正文不能为空、至少勾选一个生效范围。
 */
export function personalInstructionSaveError(content: string, scopes: string[]): string {
  if (content.trim() === '') {
    return '请先输入指令内容'
  }
  if (scopes.length === 0) {
    return '请至少选择一个生效范围'
  }
  return ''
}

export interface PersonalInstructionsPanelProps {
  /**
   * 仅供 SSR 断言：首帧直接进入编辑视图（'' = 新建；其它值 = 编辑对应条目）。
   * 不传 / 传 null 时是列表视图。真实运行时由 SettingsPage 不传参调用，首帧始终是列表。
   */
  initialEditingId?: string | null
  /**
   * 仅供 SSR 断言：编辑首帧就打开 Markdown 预览。
   * 真实运行时默认关闭（和鸿蒙版编辑页一样，进页看到的是原文编辑框）。
   */
  initialPreview?: boolean
  /**
   * 真实运行时由 SettingsPage 传入的可变 ref：设置页要返回 / 切到别的分类时先问本面板。
   * 有未保存修改时返回 false，并就地弹出「继续编辑 / 放弃修改」，避免静默丢草稿。
   * （SSR 断言不传。）
   */
  leaveGuard?: { current: (() => boolean) | null }
}

/**
 * 个性化指令列表 + 编辑视图。挂载在设置页「个性化指令」分类的右侧内容区，
 * 自身不画整页浮层；样式只用 styles.css 里 .settings-personal* 前缀的类。
 */
export function PersonalInstructionsPanel(props: PersonalInstructionsPanelProps = {}): ReactNode {
  const settings = useStore((s) => s.settings)
  const agents = useStore((s) => s.agents)
  const reloadSettings = useStore((s) => s.reloadSettings)
  const pushNotice = useStore((s) => s.pushNotice)

  const items = useMemo(
    () =>
      PersonalInstruction.parseList(
        settings?.prefs?.[Constants.LS_KEY_PERSONAL_INSTRUCTIONS] ?? ''
      ),
    [settings]
  )
  const order = useMemo(() => scopeOrderOf(agents), [agents])

  const [draft, setDraft] = useState<EditorDraft | null>(() => {
    if (props.initialEditingId === undefined || props.initialEditingId === null) {
      return null
    }
    if (props.initialEditingId === '') {
      return draftOf(null, order)
    }
    // 原条目已被删除（或存档里根本没有这个 id）时按新建处理，和鸿蒙版编辑页一致
    return draftOf(
      items.find((item) => item.id === props.initialEditingId) ?? null,
      order
    )
  })
  const [original, setOriginal] = useState<OriginalSnapshot | null>(() =>
    draft === null ? null : snapshotOf(draft)
  )
  const [previewOn, setPreviewOn] = useState(
    Boolean(props.initialEditingId) && props.initialPreview === true
  )
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const dirty =
    draft !== null &&
    original !== null &&
    (draft.name !== original.name ||
      draft.content !== original.content ||
      scopesKey(draft.scopes) !== original.scopesKey)

  function openEditor(item: PersonalInstruction | null): void {
    const next = draftOf(item, order)
    setDraft(next)
    setOriginal(snapshotOf(next))
    setPreviewOn(false)
    setSaving(false)
    setConfirmDelete(false)
    setConfirmDiscard(false)
  }

  function closeEditor(): void {
    setDraft(null)
    setOriginal(null)
    setPreviewOn(false)
    setSaving(false)
    setConfirmDelete(false)
    setConfirmDiscard(false)
  }

  /** 返回列表：有未保存修改时先走页内两步确认 */
  function handleBack(): void {
    setConfirmDelete(false)
    if (dirty) {
      setConfirmDiscard(true)
      return
    }
    closeEditor()
  }

  // Esc：编辑视图里先关本层（确认条 → 返回列表），不要再把设置页整个关掉。
  // 用捕获阶段 + stopImmediatePropagation，抢在 SettingsPage 的关闭监听之前处理。
  useEffect(() => {
    if (draft === null) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      event.stopImmediatePropagation()
      if (confirmDelete) {
        setConfirmDelete(false)
        return
      }
      if (confirmDiscard) {
        setConfirmDiscard(false)
        return
      }
      handleBack()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [draft, dirty, confirmDelete, confirmDiscard])

  // 供设置页在「返回 / 切分类」前询问：有未保存修改就不放行，先弹页内确认条。
  // 用可变 ref 而不是把状态提到 SettingsPage：设置页只做接入，面板保持自包含。
  useEffect(() => {
    const guard = props.leaveGuard
    if (guard === undefined) {
      return
    }
    guard.current = (): boolean => {
      if (draft === null) {
        return true
      }
      if (!dirty) {
        closeEditor()
        return true
      }
      setConfirmDiscard(true)
      return false
    }
    return () => {
      guard.current = null
    }
  }, [props.leaveGuard, draft, dirty])

  function updateDraft(patch: Partial<EditorDraft>): void {
    setDraft((current) => (current === null ? current : { ...current, ...patch }))
  }

  function toggleScope(scope: string): void {
    setDraft((current) => {
      if (current === null) {
        return current
      }
      const next = current.scopes.includes(scope)
        ? current.scopes.filter((value) => value !== scope)
        : [...current.scopes, scope]
      return { ...current, scopes: next }
    })
    setConfirmDelete(false)
    setConfirmDiscard(false)
  }

  /** 写盘 + 刷新 store；成功返回 true。失败时弹提示并留在编辑视图。 */
  async function persist(next: PersonalInstruction[]): Promise<boolean> {
    try {
      await window.guncat.settings.saveString(
        Constants.LS_KEY_PERSONAL_INSTRUCTIONS,
        JSON.stringify(next.map((item) => item.toJson()))
      )
      await reloadSettings()
      return true
    } catch (e) {
      pushNotice('error', `个性化指令保存失败：${String(e)}`)
      return false
    }
  }

  async function save(): Promise<void> {
    if (draft === null || saving) {
      return
    }
    const scopes = sortedScopes(draft.scopes, order)
    const error = personalInstructionSaveError(draft.content, scopes)
    if (error !== '') {
      pushNotice('warn', error)
      return
    }
    setSaving(true)
    // 新建生成稳定 id；编辑保留原 id 与创建身份，只更新内容、范围与保存时间
    const item = PersonalInstruction.create(draft.name, draft.content, scopes)
    if (draft.id !== '') {
      item.id = draft.id
      item.updatedAt = Date.now()
    }
    const index = PersonalInstruction.indexOfId(items, item.id)
    const next = items.slice()
    if (index >= 0) {
      next[index] = item
    } else {
      next.push(item)
    }
    const saved = await persist(next)
    setSaving(false)
    if (!saved) {
      return
    }
    pushNotice('info', draft.id === '' ? '已添加个性化指令' : '已保存个性化指令')
    closeEditor()
  }

  async function removeItem(): Promise<void> {
    if (draft === null || draft.id === '' || saving) {
      return
    }
    setSaving(true)
    const next = items.filter((item) => item.id !== draft.id)
    const saved = await persist(next)
    setSaving(false)
    if (!saved) {
      return
    }
    pushNotice('info', '已删除个性化指令')
    closeEditor()
  }

  /** 列表里的生效范围摘要：没勾范围的老数据也要能看出「这条不会生效」 */
  function itemScopeSummary(item: PersonalInstruction): string {
    if (item.scopes.length === 0) {
      return '未设置生效范围'
    }
    const labels = sortedScopes(item.scopes, order).map((scope) => scopeLabel(scope, agents))
    return labels.join('、')
  }

  /** 编辑视图底部的范围摘要（与勾选状态实时同步） */
  function draftScopeSummaryText(): string {
    if (draft === null || draft.scopes.length === 0) {
      return '尚未选择生效范围，保存后不会生效。'
    }
    const labels = sortedScopes(draft.scopes, order).map((scope) => scopeLabel(scope, agents))
    return '将附加到：' + labels.join('、')
  }

  function renderScopeRow(scope: string, title: string, subtitle: string): ReactNode {
    const selected = draft !== null && draft.scopes.includes(scope)
    return (
      <button
        key={scope}
        type="button"
        className="settings-personal__scope"
        data-active={selected}
        aria-pressed={selected}
        onClick={() => toggleScope(scope)}
      >
        <span className="settings-personal__scope-check" aria-hidden="true">
          {selected ? <IconCheckCircle size={20} /> : <IconCircle size={20} />}
        </span>
        <span className="settings-personal__scope-copy">
          <span className="settings-personal__scope-name">{title}</span>
          {subtitle !== '' ? (
            <span className="settings-personal__scope-desc">{subtitle}</span>
          ) : null}
        </span>
      </button>
    )
  }

  // ===== 列表视图 =====
  if (draft === null) {
    return (
      <div className="settings-personal">
        <div className="settings-personal__toolbar">
          <p className="settings-personal__intro">
            {items.length === 0
              ? '把长期偏好（语气、格式、术语、工作习惯）写下来，保存后按所选范围自动生效。'
              : '点击条目编辑指令与生效范围。'}
          </p>
          {/* 右上入口：空态之外也要有，和鸿蒙版设置页头部的「新建」一致 */}
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => openEditor(null)}
          >
            <IconPlus size={16} />
            新建
          </button>
        </div>

        {items.length === 0 ? (
          <section className="settings-card">
            <div className="settings-personal__empty">
              <span className="settings-personal__empty-icon" aria-hidden="true">
                <IconPersonalInstructions size={40} />
              </span>
              <h3>还没有个性化指令</h3>
              <p>添加后，会在你勾选的交互模式、工作模式或聊天引擎里自动附加这些偏好。</p>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => openEditor(null)}
              >
                <IconPlus size={16} />
                新建个性化指令
              </button>
            </div>
          </section>
        ) : (
          <section className="settings-card">
            <div className="settings-personal__list">
              {items.map((item, index) => (
                <Fragment key={item.id}>
                  {index > 0 ? <div className="settings-personal__divider" /> : null}
                  <button
                    type="button"
                    className="settings-personal__row"
                    onClick={() => openEditor(item)}
                  >
                    <span className="settings-personal__row-copy">
                      <span className="settings-personal__row-name">{item.displayName()}</span>
                      <span className="settings-personal__row-scopes">
                        生效范围：{itemScopeSummary(item)}
                      </span>
                      <span className="settings-personal__row-summary">{item.summary()}</span>
                    </span>
                    <span className="settings-personal__row-chevron" aria-hidden="true">
                      <IconChevronRight size={16} />
                    </span>
                  </button>
                </Fragment>
              ))}
            </div>
          </section>
        )}
      </div>
    )
  }

  // ===== 编辑视图 =====
  const isNew = draft.id === ''
  return (
    <div className="settings-personal">
      <div className="settings-personal__editorhead">
        <button
          type="button"
          className="settings-personal__back"
          title="返回列表"
          aria-label="返回个性化指令列表"
          onClick={handleBack}
        >
          <IconArrowLeft size={18} />
        </button>
        <h3 className="settings-personal__title">
          {isNew ? '新建个性化指令' : '编辑个性化指令'}
        </h3>
        {isNew ? null : (
          <button
            type="button"
            className="settings-personal__delete"
            title="删除这条指令"
            aria-label="删除这条个性化指令"
            onClick={() => {
              setConfirmDiscard(false)
              setConfirmDelete(true)
            }}
          >
            <IconTrash size={17} />
          </button>
        )}
      </div>

      {/* 页内联两步确认：删除（取消 / 确认删除） */}
      {confirmDelete ? (
        <div className="settings-personal__confirm" role="alert">
          <p>删除后会立即从所有生效范围移除，且无法恢复。</p>
          <div className="settings-personal__confirm-actions">
            <button type="button" className="btn btn--sm" onClick={() => setConfirmDelete(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={saving}
              onClick={() => void removeItem()}
            >
              确认删除
            </button>
          </div>
        </div>
      ) : null}

      {/* 页内联两步确认：有未保存修改时返回（继续编辑 / 放弃修改） */}
      {confirmDiscard ? (
        <div className="settings-personal__confirm" role="alert">
          <p>还有未保存的修改，返回后这些修改会丢失。</p>
          <div className="settings-personal__confirm-actions">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setConfirmDiscard(false)}
            >
              继续编辑
            </button>
            <button type="button" className="btn btn--sm btn--danger" onClick={closeEditor}>
              放弃修改
            </button>
          </div>
        </div>
      ) : null}

      <section className="settings-card">
        <div className="settings-card__body settings-card__body--plain">
          <div className="field">
            <label htmlFor="settings-personal-name">名称（可选）</label>
            <input
              id="settings-personal-name"
              value={draft.name}
              maxLength={PersonalInstruction.MAX_NAME_CHARS}
              placeholder="例如：英文回答、代码风格"
              onChange={(e) => updateDraft({ name: e.target.value })}
            />
            <div className="field__hint">不填时用指令正文第一行作为列表标题。</div>
          </div>
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-personal__contenthead">
          <div>
            <h3 className="settings-card__title">指令内容</h3>
            <p className="settings-card__desc">
              支持 Markdown；渲染只影响这里的预览，保存的始终是原文。
            </p>
          </div>
          {/* 预览开关：只影响本视图展示，草稿与落盘内容始终是原文 */}
          <button
            type="button"
            className="settings-personal__preview-toggle"
            data-active={previewOn}
            aria-pressed={previewOn}
            onClick={() => setPreviewOn((on) => !on)}
          >
            <IconFile size={14} />
            {previewOn ? '返回编辑' : 'Markdown 渲染'}
          </button>
        </div>
        <div className="settings-card__body">
          {previewOn ? (
            draft.content.trim() === '' ? (
              <p className="settings-personal__preview-empty">没有可预览的内容</p>
            ) : (
              <div className="settings-personal__preview">
                <Markdown text={draft.content} />
              </div>
            )
          ) : (
            <>
              <textarea
                className="settings-personal__content-input"
                rows={10}
                maxLength={PersonalInstruction.MAX_CONTENT_CHARS}
                value={draft.content}
                placeholder="写下你的指令、偏好或约束，例如语气、输出格式、常用术语，支持 Markdown。"
                onChange={(e) => updateDraft({ content: e.target.value })}
              />
              <div className="settings-personal__counter">
                {draft.content.length} / {PersonalInstruction.MAX_CONTENT_CHARS}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card__head">
          <h3 className="settings-card__title">生效范围</h3>
          <p className="settings-card__desc">
            勾选后，这条指令会附加到所选模式 / 聊天引擎的系统提示词末尾；至少选一个。
          </p>
        </div>
        <div className="settings-card__body">
          <div className="settings-personal__scope-group-label">模式</div>
          {MODE_SCOPES.map((mode, index) => (
            <Fragment key={mode.scope}>
              {index > 0 ? <div className="settings-personal__scope-divider" /> : null}
              {renderScopeRow(mode.scope, mode.title, mode.subtitle)}
            </Fragment>
          ))}

          <div className="settings-personal__scope-group-label">聊天引擎</div>
          {agents.length === 0 ? (
            <p className="settings-personal__scope-empty">暂无可用的聊天引擎</p>
          ) : (
            agents.map((agent, index) => (
              <Fragment key={agent.id}>
                {index > 0 ? <div className="settings-personal__scope-divider" /> : null}
                {renderScopeRow(agent.id, agent.name, agent.description)}
              </Fragment>
            ))
          )}

          <p className="settings-personal__scope-summary">{draftScopeSummaryText()}</p>
        </div>
      </section>

      <div className="settings-actions settings-personal__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : isNew ? '添加' : '保存'}
        </button>
      </div>
    </div>
  )
}
