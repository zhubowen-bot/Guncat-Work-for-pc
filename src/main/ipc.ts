// IPC 注册：把渲染进程的调用路由到 SessionManager，并把事件推回去。
import { ipcMain, app, shell, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { INVOKE, EVENT } from '../ipc/contract'
import type {
  ApiConfigDto,
  ApiProfileDto,
  AppInfoDto,
  ChatSendRequest,
  ConversationDto,
  ConversationSummaryDto,
  GuncatEvent,
  MultimodalConfigDto,
  WorkRunRequest
} from '../ipc/contract'
import { SessionManager } from './session/SessionManager'
import { transcribeAudio } from './asr'
import { getMainWindow } from './window'
import { getDataRoot, resourcesDir, makeTempDir } from '@core/platform/appPaths'

function send(event: GuncatEvent): void {
  const window = getMainWindow()
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send(EVENT, event)
  }
}

export function registerIpcHandlers(session: SessionManager): void {
  // ===== 设置 =====
  ipcMain.handle(INVOKE.settingsLoad, async () => session.loadSettings())
  ipcMain.handle(INVOKE.settingsSaveApiConfig, async (_e, dto: ApiConfigDto) => {
    await session.saveApiConfig(dto)
  })
  ipcMain.handle(INVOKE.settingsSaveApiProfiles, async (_e, profiles: ApiProfileDto[]) => {
    await session.saveApiProfiles(profiles)
  })
  ipcMain.handle(INVOKE.settingsSaveMultimodalConfig, async (_e, dto: MultimodalConfigDto) => {
    await session.saveMultimodalConfig(dto)
  })
  ipcMain.handle(INVOKE.settingsSaveFlag, async (_e, key: string, value: boolean) => {
    await session.saveFlag(key, value)
  })
  ipcMain.handle(INVOKE.settingsSaveString, async (_e, key: string, value: string) => {
    await session.saveString(key, value)
  })

  // ===== 智能体 =====
  ipcMain.handle(INVOKE.agentsList, async () => session.listAgents())

  // ===== 对话 =====
  ipcMain.handle(INVOKE.conversationsLoad, async (): Promise<ConversationSummaryDto[]> => {
    await session.bootstrap()
    return session.listConversations()
  })
  ipcMain.handle(INVOKE.conversationsCreate, async (_e, agentId: string, mode: string) =>
    session.createConversation(agentId, mode)
  )
  ipcMain.handle(INVOKE.conversationsDelete, async (_e, id: string) => {
    await session.deleteConversation(id)
  })
  ipcMain.handle(INVOKE.conversationsRename, async (_e, id: string, title: string) => {
    await session.renameConversation(id, title)
  })
  ipcMain.handle('conversation:get', async (_e, id: string): Promise<ConversationDto | null> =>
    session.getConversation(id)
  )

  // ===== 聊天 / 工作模式 =====
  ipcMain.handle(INVOKE.chatSend, async (_e, request: ChatSendRequest) => {
    await session.sendChat(request)
  })
  ipcMain.handle(INVOKE.workRun, async (_e, request: WorkRunRequest) => {
    await session.runWork(request)
  })
  ipcMain.handle(INVOKE.chatAbort, async (_e, conversationId: string) => {
    session.abort(conversationId)
  })
  ipcMain.handle(INVOKE.workAbort, async (_e, conversationId: string) => {
    session.abort(conversationId)
  })
  ipcMain.handle(
    INVOKE.messagePatch,
    async (_e, conversationId: string, messageId: string, content: string) => {
      await session.patchMessageContent(conversationId, messageId, content)
    }
  )

  // ===== 工作区 =====
  ipcMain.handle(INVOKE.workspaceList, async (_e, conversationId: string) =>
    session.listWorkspace(conversationId)
  )
  ipcMain.handle(INVOKE.workspaceTreeText, async (_e, conversationId: string) =>
    session.workspaceTreeText(conversationId)
  )
  ipcMain.handle(INVOKE.workspaceRead, async (_e, conversationId: string, relPath: string) => {
    // 注意：workspaceRoot 是用 '/' 拼出来的（与鸿蒙侧一致），
    // 必须先 path.resolve 归一化再比较，否则 Windows 上 '\' 与 '/' 的差异会让合法路径被误判越界。
    const root: string = path.resolve(session.workspaceRoot(conversationId))
    const full: string = path.resolve(root, relPath)
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error('路径越界')
    }
    if (!fs.existsSync(full)) {
      throw new Error('文件不存在')
    }
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      throw new Error('该路径是目录')
    }
    if (stat.size > 2 * 1024 * 1024) {
      return { text: '(文件超过 2MB，未在预览面板加载，请在外部编辑器中打开)', truncated: true }
    }
    return { text: fs.readFileSync(full, 'utf8'), truncated: false }
  })
  ipcMain.handle(INVOKE.workspaceDelete, async (_e, conversationId: string, relPath: string) => {
    const root: string = path.resolve(session.workspaceRoot(conversationId))
    const full: string = path.resolve(root, relPath)
    if (full === root || !full.startsWith(root + path.sep)) {
      throw new Error('路径越界')
    }
    fs.rmSync(full, { recursive: true, force: true })
    send({ type: 'workspace:changed', conversationId })
  })
  ipcMain.handle(INVOKE.workspaceClear, async (_e, conversationId: string) => {
    const root: string = session.workspaceRoot(conversationId)
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    send({ type: 'workspace:changed', conversationId })
  })
  ipcMain.handle(INVOKE.workspaceOpenInFolder, async (_e, conversationId: string) => {
    const root: string = session.workspaceRoot(conversationId)
    fs.mkdirSync(root, { recursive: true })
    await shell.openPath(root)
  })
  ipcMain.handle(INVOKE.workspaceExportZip, async (_e, conversationId: string) => {
    const window = getMainWindow()
    const result = await dialog.showSaveDialog(window ?? undefined!, {
      title: '导出工作区',
      defaultPath: `guncat-workspace-${conversationId}.zip`,
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    if (result.canceled || result.filePath === undefined) {
      return { saved: false }
    }
    const { WorkFileService } = await import('@core/service/WorkFileService')
    const { appContext } = await import('@core/platform/kit/AbilityKit')
    const bytes: Uint8Array = WorkFileService.zipWorkspace(appContext(), conversationId)
    fs.writeFileSync(result.filePath, bytes)
    return { saved: true, path: result.filePath }
  })

  // ===== 端侧增强 =====

  /** 文件收件：拖拽 / 命令行 / 系统「打开方式」进来的文件导入当前会话工作区 */
  ipcMain.handle(INVOKE.intakeImport, async (_e, conversationId: string, paths: string[]) => {
    return await session.intakePaths(conversationId, paths)
  })

  /** 把一条回答导出为 Word（复用移植的 DocxBuilder，含 LaTeX → OMML） */
  ipcMain.handle(
    INVOKE.messageExportDocx,
    async (_e, conversationId: string, messageId: string, suggestedName?: string) => {
      const window = getMainWindow()
      const result = await dialog.showSaveDialog(window ?? undefined!, {
        title: '导出为 Word',
        defaultPath: suggestedName !== undefined && suggestedName !== '' ? suggestedName : 'Guncat 回答.docx',
        filters: [{ name: 'Word 文档', extensions: ['docx'] }]
      })
      if (result.canceled || result.filePath === undefined) {
        return { saved: false }
      }
      const bytes: Uint8Array = await session.exportMessageDocx(conversationId, messageId)
      fs.writeFileSync(result.filePath, bytes)
      return { saved: true, path: result.filePath }
    }
  )

  /** 语音输入：把录音字节送到转写接口 */
  ipcMain.handle(
    INVOKE.asrTranscribe,
    async (_e, audio: Uint8Array | ArrayBuffer, mime: string) => {
      const bytes: Uint8Array =
        audio instanceof Uint8Array ? audio : new Uint8Array(audio as ArrayBuffer)
      return await transcribeAudio(bytes, mime ?? '')
    }
  )

  // ===== 应用信息 =====
  ipcMain.handle(INVOKE.appInfo, async (): Promise<AppInfoDto> => {
    return {
      version: app.getVersion(),
      dataRoot: getDataRoot(),
      resourcesRoot: resourcesDir(),
      platform: process.platform,
      electron: process.versions.electron
    }
  })
}

/** 供启动阶段使用的临时目录（保留导出，便于后续调试） */
export { makeTempDir }
