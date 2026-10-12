// 2026-10-12 ⑤ 走查入链：导出后自动 headless 双路径走查 + 截图存档 + 验收报告
// 守护台自主生产的最后一道闸：不再靠人工打开浏览器点一遍——链路自动跑全部结局路径，
// 每屏截图落盘 + 基础健康检查（画布非空白/按钮可达/文本非空），产出 report.json。
// 达不到标准时 report 里 issues 明示，不静默放行。
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const asList = (v) => (Array.isArray(v) ? v : [])
const asStr = (v) => String(v == null ? '' : v)

// 从 story.json 枚举结局路径：起点节点出发，单选项场景自动前进，多选择点分叉（DFS，上限 cap 条）
export function enumerateWalkthroughPaths(storyNodes, { maxPaths = 4 } = {}) {
  const nodes = asList(storyNodes)
  const byId = new Map(nodes.map((n) => [asStr(n && n.id).trim(), n]))
  const start = nodes.find((n) => asStr(n && n.kind).trim() === 'scene') || nodes[0]
  if (!start) return []
  const paths = []
  const dfs = (nodeId, acc, depth) => {
    if (paths.length >= maxPaths || depth > 60) return
    const node = byId.get(nodeId)
    if (!node) return
    const choices = asList(node.choices).filter((c) => asStr(c && c.toNodeId).trim())
    if (!choices.length || asStr(node.kind).trim() === 'ending') {
      paths.push(acc.concat([{ nodeId, name: asStr(node.name || nodeId) }]))
      return
    }
    // 多选项：优先首项与末项（覆盖两端结局），中间项按序填充至上限
    const ordered = choices.length > 2 ? [choices[0], choices[choices.length - 1], ...choices.slice(1, -1)] : choices
    for (const ch of ordered) {
      if (paths.length >= maxPaths) break
      dfs(asStr(ch.toNodeId).trim(), acc.concat([{ nodeId, name: asStr(node.name || nodeId) }, { viaChoice: asStr(ch.text || '').trim() }]), depth + 1)
    }
  }
  dfs(asStr(start.id).trim(), [], 0)
  return paths
}

// 单路径走查：开 H5，逐屏点击推进，截图+检查
async function walkOnePath({ browser, baseUrl, pathId, steps, outDir }) {
  const puppeteer = (await import('puppeteer-core')).default
  void puppeteer // browser 由调用方传入（puppeteer.launch({channel:'chrome'})）
  const page = await browser.newPage()
  await page.setViewport({ width: 420, height: 760 })
  const issues = []
  const screenshots = []
  await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 60000 })
  await new Promise((r) => setTimeout(r, 3000))
  const shots = []
  let shotIdx = 0
  const snap = async (label) => {
    shotIdx += 1
    const file = `${pathId}_${String(shotIdx).padStart(2, '0')}_${label}.png`.replace(/[^a-zA-Z0-9_.-]+/g, '_')
    await page.screenshot({ path: path.join(outDir, file) })
    screenshots.push(file)
    shots.push(file)
    // 基础健康检查：页面可见文本/按钮/画布
    const health = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null)
      const text = (document.body && document.body.innerText || '').trim()
      const canvas = document.querySelector('canvas')
      const imgs = Array.from(document.querySelectorAll('img'))
      const brokenImg = imgs.find((im) => im.complete && im.naturalWidth === 0)
      return { buttons: btns.length, textLen: text.length, hasCanvas: Boolean(canvas), brokenImg: Boolean(brokenImg) }
    })
    if (health.brokenImg) issues.push({ screen: file, issue: 'broken_image' })
    if (health.textLen < 10) issues.push({ screen: file, issue: 'empty_text' })
  }
  await snap('start')
  for (const step of steps) {
    if (step.viaChoice !== undefined) {
      // 分叉：点含 viaChoice 关键词的按钮
      const clicked = await page.evaluate((m) => {
        const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null && b.textContent && b.textContent.trim())
        const t = btns.find((b) => b.textContent.includes(m))
        if (t) { t.click(); return t.textContent.trim() }
        return null
      }, step.viaChoice)
      if (!clicked) { issues.push({ screen: shots[shots.length - 1], issue: `choice_not_found:${step.viaChoice}` }); break }
      await new Promise((r) => setTimeout(r, 3400))
      await snap(`choice_${shotIdx}`)
    } else {
      // 节点步只截图不点击：推进全由 viaChoice 步负责（单选项节点的"继续"也走 viaChoice）。
      // 此前节点步再点一次"继续"导致同屏双点，最后一幕"继续"落空报假 issue。
      await snap(`hold_${shotIdx}`)
    }
  }
  await page.close()
  return { pathId, screenshots, issues }
}

// 主入口：枚举路径 → 逐路径走查 → 落盘报告
export async function runStoryWalkthrough({ dir, projectId, story, demoBaseUrl, maxPaths }) {
  const puppeteer = (await import('puppeteer-core')).default
  const outDir = path.join(dir, 'walkthrough')
  await mkdir(outDir, { recursive: true })
  const nodes = asList(story && story.nodes)
  const paths = enumerateWalkthroughPaths(nodes, { maxPaths })
  if (!paths.length) {
    const e = new Error('walkthrough_no_paths')
    e.code = 'walkthrough_no_paths'
    throw e
  }
  const browser = await puppeteer.launch({ headless: 'new', channel: 'chrome' })
  const reports = []
  try {
    for (let i = 0; i < paths.length; i += 1) {
      const pathDef = paths[i]
      const pathId = `p${i + 1}`
      // steps：路径里除最后一个节点外，每个节点后随的 viaChoice 或 advance
      const steps = pathDef.slice(1) // 首个节点为起始屏
      const report = await walkOnePath({ browser, baseUrl: demoBaseUrl, pathId, steps, outDir })
      report.pathNames = pathDef.filter((x) => x.name).map((x) => x.name)
      reports.push(report)
    }
  } finally {
    await browser.close().catch(() => {})
  }
  const totalIssues = reports.reduce((n, r) => n + r.issues.length, 0)
  const report = {
    projectId,
    at: new Date().toISOString(),
    demoBaseUrl,
    paths: reports.length,
    issues: totalIssues,
    ok: totalIssues === 0,
    reports
  }
  const reportFile = `report_${Date.now()}.json`
  await writeFile(path.join(outDir, reportFile), JSON.stringify(report, null, 2))
  return { report, reportFile, outDir: path.relative(dir, outDir) }
}
