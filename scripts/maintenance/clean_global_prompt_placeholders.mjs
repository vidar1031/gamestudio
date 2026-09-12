#!/usr/bin/env node
// 一次性存量清洗（2026-09-10 占位垃圾治理 D 层）：
// 扫描 storage/projects/*/project.json，把全局提示词字段里的占位垃圾
// （"故事名：《…》"/"story title: …"）置空——这些值是早期 sbReq 种子链写入的脚本模板复述，
// 不是出图提示词，留着会被误当有效英文稿并随翻译/保存链扩散。
// 默认干跑（只报告），--apply 才写回；写回前在同目录留 project.json.bak-globalprompt 备份（已存在则不覆盖）。
import fs from 'node:fs'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const ROOT = process.env.STUDIO_STORAGE_ROOT || path.resolve(process.cwd(), 'storage')
const PROJECTS_DIR = path.join(ROOT, 'projects')

const JUNK_PATTERNS = [/^story title\s*:/i, /^故事名：《.*》$/]
const isJunk = (v) => {
  const s = String(v || '').trim()
  return !!s && JUNK_PATTERNS.some((re) => re.test(s))
}

const FIELDS = ['globalPrompt', 'globalNegativePrompt', 'storyboardGlobalPromptZh', 'storyboardGlobalNegativePromptZh']

function cleanProject(filePath) {
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const aiBg = doc?.state?.aiBackground
  if (!aiBg || typeof aiBg !== 'object') return null
  const hits = []
  for (const key of FIELDS) {
    if (isJunk(aiBg[key])) {
      hits.push({ field: key, before: String(aiBg[key]).slice(0, 60) })
      aiBg[key] = ''
    }
  }
  const g = aiBg.global && typeof aiBg.global === 'object' ? aiBg.global : null
  if (g) {
    for (const key of ['prompt', 'negativePrompt']) {
      if (isJunk(g[key])) {
        hits.push({ field: `global.${key}`, before: String(g[key]).slice(0, 60) })
        g[key] = ''
      }
    }
  }
  if (!hits.length) return null
  if (APPLY) {
    const backup = filePath.replace(/project\.json$/, 'project.json.bak-globalprompt')
    if (!fs.existsSync(backup)) fs.copyFileSync(filePath, backup)
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf-8')
  }
  return hits
}

function main() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`项目目录不存在：${PROJECTS_DIR}`)
    process.exit(1)
  }
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  let scanned = 0
  let affected = 0
  for (const id of dirs) {
    const filePath = path.join(PROJECTS_DIR, id, 'project.json')
    if (!fs.existsSync(filePath)) continue
    scanned += 1
    let hits = null
    try {
      hits = cleanProject(filePath)
    } catch (e) {
      console.log(`× ${id} 读取失败：${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (hits) {
      affected += 1
      const title = (() => { try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')).title || '' } catch { return '' } })()
      console.log(`● ${id}（${title}）`)
      for (const h of hits) console.log(`    ${h.field}: "${h.before}" → （置空）`)
    }
  }
  console.log('---')
  console.log(`已扫描项目：${scanned}；命中占位垃圾：${affected}`)
  console.log(APPLY ? '已写回（备份：project.json.bak-globalprompt）' : '干跑模式，未改写任何文件；加 --apply 实际清洗')
}

main()
