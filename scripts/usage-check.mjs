// 把 scripts/usage-smoke.ts 用与 run-smoke 相同的别名规则打包后执行。
// 纯逻辑测试不需要 Electron / 文件系统。
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { root, alias } from './esbuild-aliases.mjs'

const outfile = path.join(root, '.smoke', 'usage-smoke.mjs')
fs.mkdirSync(path.dirname(outfile), { recursive: true })

await build({
  entryPoints: [path.join(root, 'scripts/usage-smoke.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas'],
  alias,
  logLevel: 'error'
})

console.log(`已打包用量测试 → ${path.relative(root, outfile)}\n`)
await import(pathToFileURL(outfile).href)
