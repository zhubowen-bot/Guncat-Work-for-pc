// 把 scripts/smoke.ts 用 esbuild 打成可直接被 Node 执行的 ESM，
// 并施加与 electron.vite.config.ts 完全相同的别名规则。
//
// 这样无头验证跑的就是「构建产物真实依赖的那套解析规则」，
// 而不是另起一套近似配置。
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const kit = (name) => path.join(root, 'src/core/platform/kit', name)

const alias = {
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

const outDir = path.join(root, '.smoke')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, 'smoke.mjs')

await build({
  entryPoints: [path.join(root, 'scripts/smoke.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  // electron 保持外部依赖：ImageKit 只在真正解码像素时才 require 它
  external: ['electron'],
  alias,
  logLevel: 'error'
})

console.log(`已打包冒烟脚本 → ${path.relative(root, outfile)}\n`)
await import(pathToFileURL(outfile).href)
