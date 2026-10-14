// 语音输入：录音 + 转写。
//
// 与鸿蒙版的差异见 main/asr.ts 的说明：桌面端没有端侧识别可用，
// 走「MediaRecorder 录音 → 主进程转写接口」这条路。
import { useCallback, useRef, useState } from 'react'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

interface VoiceInput {
  state: VoiceState
  supported: boolean
  error: string
  toggle(): void
}

export function useVoiceInput(onText: (text: string) => void): VoiceInput {
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const supported =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'

  const cleanup = useCallback((): void => {
    if (streamRef.current !== null) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
      streamRef.current = null
    }
    recorderRef.current = null
    chunksRef.current = []
  }, [])

  const stop = useCallback((): void => {
    const recorder = recorderRef.current
    if (recorder !== null && recorder.state !== 'inactive') {
      recorder.stop()
    }
  }, [])

  const toggle = useCallback((): void => {
    setError('')

    if (state === 'recording') {
      stop()
      return
    }
    if (state !== 'idle') {
      return
    }
    if (!supported) {
      setError('当前环境不支持录音')
      return
    }

    void (async (): Promise<void> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
        chunksRef.current = []

        const recorder = new MediaRecorder(stream)
        recorderRef.current = recorder

        recorder.ondataavailable = (e: BlobEvent): void => {
          if (e.data.size > 0) {
            chunksRef.current.push(e.data)
          }
        }

        recorder.onstop = (): void => {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          cleanup()
          setState('transcribing')
          void (async (): Promise<void> => {
            try {
              if (blob.size === 0) {
                setState('idle')
                setError('没有录到音频')
                return
              }
              const buffer = new Uint8Array(await blob.arrayBuffer())
              const result = await window.guncat.asr.transcribe(buffer, blob.type)
              if (result.ok) {
                onText(result.text)
              } else {
                setError(result.error)
              }
            } catch (e) {
              setError(`语音识别失败：${String(e)}`)
            } finally {
              setState('idle')
            }
          })()
        }

        recorder.start()
        setState('recording')
      } catch (e) {
        cleanup()
        setState('idle')
        // 麦克风权限被拒是最常见的原因，给出可操作提示
        setError(`无法开始录音（请确认已授予麦克风权限）：${String(e)}`)
      }
    })()
  }, [state, supported, stop, cleanup, onText])

  return { state, supported, error, toggle }
}
