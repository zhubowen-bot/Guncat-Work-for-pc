// 与 electron.vite.config.ts 保持一致的别名表，供无头脚本复用。
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const kit = (name) => path.join(root, 'src/core/platform/kit', name)

export const alias = {
  '@kit.ArkTS': kit('ArkTS.ts'),
  '@kit.CoreFileKit': kit('CoreFileKit.ts'),
  '@kit.NetworkKit': kit('NetworkKit.ts'),
  '@kit.BasicServicesKit': kit('BasicServicesKit.ts'),
  '@kit.AbilityKit': kit('AbilityKit.ts'),
  '@kit.ArkData': kit('ArkData.ts'),
  '@kit.PerformanceAnalysisKit': kit('PerformanceAnalysisKit.ts'),
  '@kit.ImageKit': kit('ImageKit.ts'),
  '@kit.PDFKit': kit('PDFKit.ts'),
  'libguncatjs.so': path.join(root, 'src/core/platform/native/libguncatjs.ts'),
  '@core': path.join(root, 'src/core'),
  '@ipc': path.join(root, 'src/ipc')
}
