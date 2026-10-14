// 智能体标识 —— 逐条对齐鸿蒙原版 DswSidebar.buildAgentItem / AgentDrawerView 的三条分支：
//
//   · 虚拟引擎（work / interactive）→ 原版 entry/src/main/resources/base/media/ic_work.svg、
//     ic_interactive.svg 的形态图标；
//   · 真实智能体 → agents.json 的 `icon`（原版 rawfile/icons/*.png 原图，1024² PNG 十张，
//     已随包在 resources/icons 下，经 app:// 的 /res/ 根暴露，见 src/main/protocol.ts）；
//   · 两者都取不到 → 名字首字兜底（头像不该成为界面起不来的原因）。
//
// 应用自身的图标是原版的 app.media.cat_avatar —— AppScope/resources/base/media/layered_image.json
// 里 background 与 foreground **都**指向 cat_avatar.png，所以它就是真正的应用图标。
// 这里统一走 APP_ICON_SRC，而不是再自绘一个「大猫」：自绘的那只既不是原版形态，
// 也无法表达品牌色渐变与细节，是最容易被一眼看穿「不对齐」的地方。
import { useState } from 'react'
import type { AgentDto } from '@ipc/contract'
import { IconInteractive, IconWork, type IconProps } from '../icons'
import { INTERACTIVE_AGENT_ID, WORK_AGENT_ID } from '../conversations'

/** 随包资源在 app:// 下的根前缀 */
export const RESOURCE_BASE = 'app://guncat/res/'

/** 应用图标（= 原版 app.media.cat_avatar） */
export const APP_ICON_SRC = `${RESOURCE_BASE}cat_avatar.png`

/** 虚拟引擎 id → 原版形态图标 */
const VIRTUAL_ICON: Record<string, (props: IconProps) => React.ReactElement> = {
  [WORK_AGENT_ID]: IconWork,
  [INTERACTIVE_AGENT_ID]: IconInteractive
}

export interface AgentGlyphProps {
  /** 目标智能体；为空时退回应用图标 */
  agent?: AgentDto | null
  /** 边长（px），默认 20 */
  size?: number
  className?: string
  /** 圆角头像（真实智能体的 PNG 需要裁圆；形态图标不需要） */
  rounded?: boolean
  title?: string
}

/**
 * 渲染一个智能体标识。
 * 虚拟引擎是描边 SVG（跟随 currentColor，主题自适应）；真实智能体是原图圆形头像。
 */
export function AgentGlyph({
  agent,
  size = 20,
  className,
  rounded = true,
  title
}: AgentGlyphProps): React.ReactElement {
  const [broken, setBroken] = useState(false)

  if (agent !== undefined && agent !== null) {
    const Virtual = VIRTUAL_ICON[agent.id]
    if (Virtual !== undefined) {
      return <Virtual size={size} className={className} />
    }
    if (agent.icon !== '' && !broken) {
      return (
        <img
          className={className !== undefined ? className : rounded ? 'agent-avatar agent-avatar--img' : undefined}
          src={RESOURCE_BASE + agent.icon}
          alt=""
          title={title ?? agent.name}
          width={size}
          height={size}
          style={rounded ? { borderRadius: size / 2 } : undefined}
          onError={() => setBroken(true)}
        />
      )
    }
    return (
      <span
        className={className !== undefined ? className : 'agent-avatar'}
        title={title ?? agent.name}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      >
        {agent.name.slice(0, 1)}
      </span>
    )
  }

  return (
    <img
      className={className !== undefined ? className : 'agent-avatar agent-avatar--img'}
      src={APP_ICON_SRC}
      alt=""
      title={title ?? 'Guncat Work'}
      width={size}
      height={size}
      style={rounded ? { borderRadius: size / 2 } : undefined}
    />
  )
}
