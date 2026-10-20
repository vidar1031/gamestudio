#!/usr/bin/env node
// 拆分修复：把迁移波误吸入 routes/*.routes.js 的 index 本地辅助定义回收进 index.js。
// 规则：routes 文件里 ctx.<name> 的"定义"（函数/常量）抽回为裸名定义插回 index.js（import 区之后）；
// 定义体内部的 ctx. 前缀全部还原为裸名（回到 index 作用域）。routes 文件中的调用侧保持 ctx.<name>(...)。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const INDEX = path.join(ROOT, 'apps/server/src/index.js')
const ROUTES_DIR = path.join(ROOT, 'apps/server/src/routes')

const DEF_START = /^(async function|function|const|let|var)\s+ctx\.([A-Za-z_][\w]*)/
const recovered = new Map() // name -> bare definition text

function braceEnd(lines, start) {
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth-- }
    if (i > start && depth === 0) return i + 1
  }
  throw new Error(`brace unbalanced at line ${start + 1}`)
}
function stmtEnd(lines, start) {
  for (let i = start; i < lines.length; i++) {
    if (/;\s*$/.test(lines[i])) return i + 1
    // ASI 容错：本行不以续行符结尾，且下一行是新语句/注释/空行/块尾
    const cur = lines[i].trimEnd()
    const nxt = (lines[i + 1] || '').trim()
    if (!/[,(|+?:&]$/.test(cur) && (nxt === '' || /^(const|let|var|function|async|export|app\.|\/\/|\/\*|\}|export)/.test(nxt))) return i + 1
  }
  throw new Error(`statement end not found at line ${start + 1}`)
}

for (const f of fs.readdirSync(ROUTES_DIR).filter((x) => x.endsWith('.routes.js'))) {
  const p = path.join(ROUTES_DIR, f)
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  const cuts = []
  lines.forEach((l, i) => {
    const m = l.match(DEF_START)
    if (!m) return
    const kind = m[1]
    const name = m[2]
    const end = kind === 'async function' || kind === 'function' ? braceEnd(lines, i) : stmtEnd(lines, i)
    const text = lines.slice(i, end).join('\n')
      .replace(/^((?:async function|function|const|let|var)\s+)ctx\./, '$1')
      .replace(/(?<![.\w'"])ctx\./g, '') // 定义体内 ctx. 还原裸名
    if (!recovered.has(name)) recovered.set(name, text)
    cuts.push([i, end])
  })
  if (cuts.length) {
    for (const [s, e] of cuts.reverse()) lines.splice(s, e - s, `// [拆分回收] 辅助定义 ${''}已回 index.js`)
    fs.writeFileSync(p, lines.join('\n'))
    console.log(`[recover] ${f}: ${cuts.length} 个定义回收`)
  }
}

// 插回 index.js（import 区之后、装配区之前）
const idxLines = fs.readFileSync(INDEX, 'utf8').split('\n')
let lastImport = 0
idxLines.forEach((l, i) => { if (l.startsWith('import ')) lastImport = i })
const block = [
  '',
  '// ---------------------------------------------------------------------------',
  '// [拆分回收] 迁移波误吸入 routes 的共享辅助定义（函数/常量），回到本文件作为 ctx 装配的真相源。',
  '// ---------------------------------------------------------------------------',
  ...[...recovered.values()]
]
idxLines.splice(lastImport + 1, 0, ...block)
fs.writeFileSync(INDEX, idxLines.join('\n'))
console.log(`[done] 回收 ${recovered.size} 个定义进 index.js`)
