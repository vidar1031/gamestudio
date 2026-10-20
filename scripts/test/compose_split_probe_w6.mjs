#!/usr/bin/env node
// ComposeStudio 拆分画布行为探针（W6 验证用，一次性脚本，验完即删）
// 步骤：克隆真实项目 → 打开合成工作室 → 节点切换/画布点选/拖动摆放落盘回读/撤销恢复/缩放平移
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import puppeteer from 'puppeteer-core'

const SRC_ID = '19dee7e7-c044-41ce-bcd4-915dd1f8a3f9' // 司马光砸缸
const ROOT = process.cwd()
const PROJECTS = path.join(ROOT, 'storage', 'projects')
const EDITOR = process.env.PROBE_EDITOR || 'http://localhost:8868'
const TARGET_NODE = 'bn_sc_1791953252372_5s0klr' // 庭院嬉戏（起始节点）
const TARGET_PL = 'pl_ssym8dz3'

const probeId = crypto.randomUUID()
const srcDir = path.join(PROJECTS, SRC_ID)
const dstDir = path.join(PROJECTS, probeId)

const results = []
function log(name, ok, detail) {
  results.push({ name, ok, detail: String(detail || '') })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function readStory() {
  return JSON.parse(fs.readFileSync(path.join(dstDir, 'story.json'), 'utf8'))
}
function placementOf(story, nodeId, plId) {
  const n = (story.nodes || []).find((x) => x.id === nodeId)
  const pls = (n && n.visuals && n.visuals.placements) || []
  return pls.find((p) => p.id === plId) || null
}

let ok = false
try {
  // 1. 克隆项目目录，改 id/标题
  fs.cpSync(srcDir, dstDir, { recursive: true })
  const pjPath = path.join(dstDir, 'project.json')
  const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
  pj.id = probeId
  pj.title = '探针副本'
  fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2))
  const mjPath = path.join(dstDir, 'meta.json')
  if (fs.existsSync(mjPath)) {
    const mj = JSON.parse(fs.readFileSync(mjPath, 'utf8'))
    if (mj && typeof mj === 'object') {
      if ('id' in mj) mj.id = probeId
      if ('title' in mj) mj.title = '探针副本'
      fs.writeFileSync(mjPath, JSON.stringify(mj, null, 2))
    }
  }
  log('克隆探针副本', true, probeId)

  const before = readStory()
  const beforePl = placementOf(before, TARGET_NODE, TARGET_PL)
  if (!beforePl) throw new Error('目标摆放不存在')
  const origX = beforePl.transform.x
  const origY = beforePl.transform.y
  log('探针基线摆放', true, `x=${origX} y=${origY}`)

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1440,900']
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
    // 预设 stage/projectId 让 App 直接恢复进合成工作室
    await page.evaluateOnNewDocument((id) => {
      try {
        localStorage.setItem('talkscene.stage', 'compose')
        localStorage.setItem('talkscene.projectId', id)
      } catch {}
    }, probeId)
    await page.goto(EDITOR, { waitUntil: 'networkidle2', timeout: 30000 })

    // 等画布挂载
    await page.waitForSelector('.canvas-wrap canvas', { timeout: 20000 })
    await page.waitForSelector('.stage-toolbar', { timeout: 20000 })
    await new Promise((r) => setTimeout(r, 3000)) // 等纹理加载/首轮 renderStage
    log('工作室打开（画布挂载）', true)

    // 2. 节点切换：左栏点「意外落水」
    const switched = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.panel .list .item'))
      const hit = items.find((n) => (n.textContent || '').includes('意外落水'))
      if (!hit) return false
      hit.click()
      return true
    })
    await new Promise((r) => setTimeout(r, 800))
    const rightShows = await page.evaluate(() => {
      const txt = document.querySelector('.panel.right')?.textContent || ''
      const nameInput = document.querySelector('.panel.right input.input')
      return { hasNodeProps: txt.includes('场景节点属性'), nameValue: nameInput ? nameInput.value : '' }
    })
    log('节点切换（右栏跟随）', switched && rightShows.hasNodeProps && rightShows.nameValue.includes('意外落水'), JSON.stringify(rightShows))

    // 切回起始节点
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.panel .list .item'))
      const hit = items.find((n) => (n.textContent || '').includes('庭院嬉戏'))
      if (hit) hit.click()
    })
    await new Promise((r) => setTimeout(r, 1200))

    // 3. 画布点选：按 stage-ui 矩形 + 摆放归一化坐标计算屏幕点
    const rect = await page.evaluate(() => {
      const el = document.querySelector('.stage-ui')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    })
    if (!rect) throw new Error('stage-ui 不存在')
    // anchor 底中：点在锚点上方一点取 sprite 实体区
    const clickPts = [0.04, 0.08, 0.12].map((off) => ({
      x: rect.left + (origX) * rect.width,
      y: rect.top + (origY - off) * rect.height
    }))
    let selected = false
    for (const pt of clickPts) {
      await page.mouse.click(pt.x, pt.y)
      await new Promise((r) => setTimeout(r, 500))
      selected = await page.evaluate(() => !!document.querySelector('.stage-toolbar-selection'))
      if (selected) break
    }
    log('画布点选（工具栏选择簇出现）', selected)
    if (!selected) throw new Error('点选失败，中止后续拖动/撤销')

    // 4. 拖动摆放：从摆放点向上左拖 (-60, -40) 屏px
    const dragFrom = { x: rect.left + origX * rect.width, y: rect.top + (origY - 0.06) * rect.height }
    await page.mouse.move(dragFrom.x, dragFrom.y)
    await page.mouse.down()
    await page.mouse.move(dragFrom.x - 30, dragFrom.y - 20, { steps: 5 })
    await page.mouse.move(dragFrom.x - 60, dragFrom.y - 40, { steps: 5 })
    await page.mouse.up()
    await new Promise((r) => setTimeout(r, 3500)) // 1.2s 防抖自动保存 + 写盘
    const afterDrag = readStory()
    const dragPl = placementOf(afterDrag, TARGET_NODE, TARGET_PL)
    const expX = Math.max(0, Math.min(1, origX - 60 / rect.width))
    const expY = Math.max(0, Math.min(1, origY - 40 / rect.height))
    const dragOk = dragPl && Math.abs(dragPl.transform.x - expX) < 0.03 && Math.abs(dragPl.transform.y - expY) < 0.03
    log('拖动摆放→落盘回读一致', !!dragOk, `期望≈(${expX.toFixed(3)},${expY.toFixed(3)}) 实际=(${dragPl ? dragPl.transform.x.toFixed(3) + ',' + dragPl.transform.y.toFixed(3) : 'null'})`)

    // 5. 撤销恢复
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.stage-toolbar .stage-tool-btn'))
      const hit = btns.find((b) => (b.textContent || '').trim() === '撤销')
      if (hit) hit.click()
    })
    await new Promise((r) => setTimeout(r, 3500))
    const afterUndo = readStory()
    const undoPl = placementOf(afterUndo, TARGET_NODE, TARGET_PL)
    const undoOk = undoPl && Math.abs(undoPl.transform.x - origX) < 0.001 && Math.abs(undoPl.transform.y - origY) < 0.001
    log('撤销恢复（落盘回到原值）', !!undoOk, `x=${undoPl?.transform.x} y=${undoPl?.transform.y}`)

    // 6. 缩放：点放大 → 100% → 120%
    const zoomBefore = await page.evaluate(() => document.querySelector('.stage-toolbar-zoom')?.textContent || '')
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.stage-toolbar .stage-tool-btn'))
      const hit = btns.find((b) => (b.textContent || '').trim() === '＋')
      if (hit) hit.click()
    })
    await new Promise((r) => setTimeout(r, 600))
    const zoomAfter = await page.evaluate(() => document.querySelector('.stage-toolbar-zoom')?.textContent || '')
    log('缩放（放大 100%→120%）', zoomBefore.includes('100') && zoomAfter.includes('120'), `${zoomBefore}→${zoomAfter}`)

    // 7. 平移：开平移工具拖画布 → stage-ui transform 变化
    const tfBefore = await page.evaluate(() => document.querySelector('.stage-ui')?.style.transform || '')
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.stage-toolbar .stage-tool-btn'))
      const hit = btns.find((b) => (b.textContent || '').trim() === '平移')
      if (hit) hit.click()
    })
    await new Promise((r) => setTimeout(r, 300))
    await page.mouse.move(rect.left + rect.width * 0.3, rect.top + rect.height * 0.3)
    await page.mouse.down()
    await page.mouse.move(rect.left + rect.width * 0.3 + 50, rect.top + rect.height * 0.3 + 30, { steps: 6 })
    await page.mouse.up()
    await new Promise((r) => setTimeout(r, 800))
    const tfAfter = await page.evaluate(() => document.querySelector('.stage-ui')?.style.transform || '')
    log('平移（stage-ui transform 变化）', tfBefore !== tfAfter, `${tfBefore.slice(0, 60)} → ${tfAfter.slice(0, 60)}`)

    ok = results.every((r) => r.ok)
  } finally {
    await browser.close()
  }
} catch (e) {
  log('探针异常中止', false, e instanceof Error ? e.message : String(e))
} finally {
  // 清理探针副本
  try { fs.rmSync(dstDir, { recursive: true, force: true }) } catch {}
  console.log(`探针副本已删除: ${!fs.existsSync(dstDir)}`)
}
console.log(ok ? 'PROBE_PASS' : 'PROBE_FAIL')
process.exit(ok ? 0 : 1)
