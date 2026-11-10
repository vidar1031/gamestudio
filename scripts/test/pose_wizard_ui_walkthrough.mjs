#!/usr/bin/env node
// 2026-11-01 姿态链路走查（定义/执行分工版）：
//   A 蓝图预演：选元素块 → 预览图候选点选（写编排草稿 imageAssetId）→ 保存 → plan.json 落盘核对 + 占位块真实图渲染
//   B 管理回跳：「管理（出图）」→ 合成层消费 poseFocus → 锁定事物向导第 5 步聚焦 资产+场景+需求（只读摘要）
//   C 执行台：按蓝图需求生成候选 → （APPLY=1）锁定并应用到目标场景 → 摆位引用核对
//   D 修改需求：执行台「修改需求」回跳蓝图层
// 用法：node scripts/test/pose_wizard_ui_walkthrough.mjs [APPLY=1]
import fs from 'node:fs'
import path from 'node:path'

const PROJECT_ID = process.env.POSE_PROJECT_ID || '88401a99-d5f1-4902-8de0-e74684c08c48'
const ASSET_ID = process.env.POSE_ASSET_ID || 'big-wolf'
const SCENE_ID = process.env.POSE_SCENE_ID || 'bn_sc_1792917439823_u6blvl'
const SCENE_TEXT = process.env.POSE_SCENE_TEXT || '结局二'
const GENERATE = process.env.POSE_GENERATE !== '0'
const APPLY = process.env.POSE_APPLY !== '0'
const EDITOR_BASE = process.env.STUDIO_EDITOR_URL || 'http://localhost:8868'
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const EVIDENCE_DIR = path.resolve(process.cwd(), 'state', 'evidence-packs', `pose-ui-walkthrough-${ts}`)
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
const PLAN_JSON = path.resolve(process.cwd(), 'storage', 'projects', PROJECT_ID, 'story-assets', 'plan.json')
const STORY_JSON = path.resolve(process.cwd(), 'storage', 'projects', PROJECT_ID, 'story.json')
const record = { projectId: PROJECT_ID, assetId: ASSET_ID, sceneId: SCENE_ID, apply: APPLY, startedAt: new Date().toISOString(), steps: [], screenshots: [] }

function stepLog(name, ok, detail) {
  record.steps.push({ name, ok, detail: String(detail || ''), at: new Date().toISOString() })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
async function shot(page, name) {
  const file = path.join(EVIDENCE_DIR, `${String(record.screenshots.length + 1).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  record.screenshots.push(file)
}
async function clickByText(page, selector, text, { exact = false } = {}) {
  return page.evaluate(({ selector, text, exact }) => {
    const nodes = Array.from(document.querySelectorAll(selector))
    const hit = nodes.find((node) => exact ? String(node.textContent || '').trim() === text : String(node.textContent || '').includes(text))
    if (!hit) return false
    hit.scrollIntoView({ block: 'center' })
    hit.click()
    return true
  }, { selector, text, exact })
}
async function waitText(page, text, timeoutMs) {
  await page.waitForFunction((value) => document.body.innerText.includes(value), { timeout: timeoutMs }, text)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function readPlan() {
  return JSON.parse(fs.readFileSync(PLAN_JSON, 'utf-8'))
}
function readPlanAsset() {
  return (readPlan().assets || []).find((asset) => String(asset?.id || '') === ASSET_ID)
}

async function main() {
  const puppeteer = (await import('puppeteer-core')).default
  const executablePath = process.env.STUDIO_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (!fs.existsSync(executablePath)) throw new Error(`chrome_not_found: ${executablePath}`)
  const browser = await puppeteer.launch({ executablePath, headless: false, args: ['--no-sandbox', '--window-size=1680,1050', '--mute-audio'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1680, height: 1000 })
    page.on('dialog', async (dialog) => {
      record.dialogs = record.dialogs || []
      record.dialogs.push({ type: dialog.type(), message: dialog.message() })
      console.log(`[dialog:${dialog.type()}] ${dialog.message()}`)
      await dialog.accept()
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[console.error] ${msg.text()}`)
    })
    page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`))
    await page.evaluateOnNewDocument((pid) => {
      localStorage.setItem('talkscene.stage', 'blueprint')
      localStorage.setItem('talkscene.projectId', pid)
    }, PROJECT_ID)
    await page.goto(EDITOR_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await waitText(page, '蓝图', 40_000)
    await sleep(1500)

    // ============ A. 蓝图预演：占位预览图 ============
    if (!(await clickByText(page, 'button', '预演'))) throw new Error('未找到「预演」视图切换')
    await sleep(1200)
    stepLog('A1 打开预演视图', true)

    // 找到含大灰狼的占位块（不在当前幕就翻幕）
    let wolfSelected = false
    for (let i = 0; i < 8 && !wolfSelected; i += 1) {
      wolfSelected = await page.evaluate(() => {
        const blocks = Array.from(document.querySelectorAll('.bp-previz-block'))
        const hit = blocks.find((b) => String(b.textContent || '').includes('大灰狼'))
        if (!hit) return false
        hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
        hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
        return true
      })
      if (!wolfSelected) {
        if (!(await clickByText(page, 'button', '下一幕'))) throw new Error('翻幕失败')
        await sleep(800)
      }
    }
    if (!wolfSelected) throw new Error('未找到大灰狼占位块')
    await sleep(800)
    stepLog('A2 选中大灰狼占位块', true)

    const candCount = await page.evaluate(() => document.querySelectorAll('.bp-previz-imgcand-item').length)
    if (!candCount) throw new Error('预览图候选列表为空（主参考+锁定变体应至少 1 项）')
    const picked = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.bp-previz-imgcand-item'))
      const last = items[items.length - 1]
      last.scrollIntoView({ block: 'center' })
      last.click()
      return String(last.textContent || '').trim()
    })
    await sleep(600)
    stepLog('A3 点选预览图候选', true, picked)

    const imgVisible = await page.evaluate(() => Boolean(document.querySelector('.bp-previz-block-img')))
    if (!imgVisible) throw new Error('占位块未渲染预览图（.bp-previz-block-img 缺失）')
    stepLog('A4 占位块已渲染真实图', true)
    await shot(page, 'blueprint-previz-preview-image')

    if (!(await clickByText(page, 'button', '保存'))) throw new Error('未找到顶栏保存按钮')
    const draftDeadline = Date.now() + 60_000
    let draftItem = null
    while (Date.now() < draftDeadline) {
      const scenes = readPlan().scenes || []
      const all = []
      for (const s of scenes) for (const it of (s?.composition?.items || [])) all.push({ sceneId: s.sceneId, ...it })
      const hit = all.find((it) => String(it?.subjectId || '') === ASSET_ID && String(it?.imageAssetId || '').trim())
      if (hit) { draftItem = hit; break }
      await sleep(1500)
    }
    if (!draftItem) throw new Error('保存后 plan.json 构图草稿未写入 imageAssetId')
    record.previzDraftPick = draftItem
    stepLog('A5 草稿 imageAssetId 已落盘', true, `${draftItem.sceneId} → ${draftItem.imageAssetId}`)
    await shot(page, 'blueprint-previz-saved')

    // 保存后右栏回场景属性——重新选中大灰狼块，元素面板才显示「预览图/管理」
    const reselected = await page.evaluate(() => {
      const blocks = Array.from(document.querySelectorAll('.bp-previz-block'))
      const hit = blocks.find((b) => String(b.textContent || '').includes('大灰狼'))
      if (!hit) return false
      hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
      hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
      return true
    })
    if (!reselected) throw new Error('保存后重选大灰狼占位块失败')
    await sleep(800)

    // ============ B. 管理回跳：锁定出图执行台聚焦 ============
    if (!(await clickByText(page, 'button', '管理（出图）'))) throw new Error('未找到「管理（出图）」按钮')
    await sleep(4000)
    await shot(page, 'after-manage-jump')
    const payloadAfterJump = await page.evaluate(() => ({ stage: localStorage.getItem('talkscene.stage'), payload: localStorage.getItem('talkscene.lockWorkspace.poseFocus') || '' }))
    record.afterJump = payloadAfterJump
    stepLog('B0 载荷写入与消费', payloadAfterJump.stage === 'compose', `stage=${payloadAfterJump.stage} payload=${payloadAfterJump.payload ? '仍在' : '已消费'}`)
    // initStoryboardBatchFromDoc 为重量初始化（数秒级）——等执行台真实出现，不按固定 sleep 猜
    await page.waitForFunction(() => Boolean(document.querySelector('.pose-variant-section')), { timeout: 90_000 })
    await sleep(2500)
    const focusOk = await page.evaluate(({ sceneText }) => {
      const section = document.getElementById('pose-asset-big-wolf') || document.querySelector('.pose-variant-section')
      if (!section) return { ok: false, why: 'pose section missing' }
      const sel = section.querySelector('.pose-pool-field select')
      const selLabel = sel instanceof HTMLSelectElement ? sel.options[sel.selectedIndex]?.textContent || '' : ''
      const rows = section.querySelectorAll('.pose-req-row').length
      const activeRow = section.querySelector('.pose-req-row.active')
      return { ok: true, selLabel, rows, active: Boolean(activeRow), sceneMatch: selLabel.includes(sceneText) }
    }, { sceneText: SCENE_TEXT })
    if (!focusOk.ok) throw new Error(`回跳后未定位到姿态执行台：${focusOk.why || ''}`)
    record.focusState = focusOk
    stepLog('B1 管理回跳聚焦执行台', focusOk.rows > 0 && focusOk.active, `场景下拉=${focusOk.selLabel}（=预演当前幕，载荷带过来）· 需求行=${focusOk.rows} · 有选中=${focusOk.active}`)
    await shot(page, 'lock-workbench-focused')

    if (process.env.POSE_STOP_AFTER === 'B') {
      record.finishedAt = new Date().toISOString()
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'record.json'), JSON.stringify(record, null, 2), 'utf-8')
      console.log(`证据包（B 段早退）：${EVIDENCE_DIR}`)
      return
    }

    // ============ C. 执行台：选需求 → 生成 → 锁定应用 ============
    const rowPicked = await page.evaluate(({ sceneText, sceneId }) => {
      const rows = Array.from(document.querySelectorAll('.pose-req-row'))
      if (!rows.length) return false
      // 优先按场景 id 精确命中（手工需求常缺 sceneName，行内显示的是解析后的 #N 幕名），其次按场景名，最后首行
      const hit = rows.find((r) => sceneId && String(r.textContent || '').includes(sceneId))
        || rows.find((r) => String(r.textContent || '').includes(sceneText))
        || rows[0]
      hit.scrollIntoView({ block: 'center' })
      hit.click()
      return true
    }, { sceneText: SCENE_TEXT, sceneId: SCENE_ID })
    if (!rowPicked) throw new Error('未找到可点选的需求行')
    await sleep(600)
    stepLog('C1 选中目标场景需求', true, SCENE_TEXT)

    if (GENERATE) {
      const baseline = (readPlanAsset()?.poseCandidates || []).length
      await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('.pose-req-head select'))
        const sel = selects[0]
        if (!(sel instanceof HTMLSelectElement)) return
        sel.value = '1'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      })
      if (!(await clickByText(page, 'button', '生成 1 张候选'))) throw new Error('未找到生成按钮（需求未定义或提示词为空？）')
      stepLog('C2 开始生成候选', true, `基线候选 ${baseline}`)
      await sleep(4000)
      await shot(page, 'candidate-generating')
      const deadline = Date.now() + 420_000
      let generated = false
      while (Date.now() < deadline) {
        const count = (readPlanAsset()?.poseCandidates || []).length
        if (count > baseline) { generated = true; break }
        const failed = await page.evaluate(() => document.body.innerText.includes('姿势需求生成失败'))
        if (failed) throw new Error('界面报告候选生成失败')
        await sleep(5000)
      }
      if (!generated) throw new Error('候选生成超时')
      stepLog('C3 候选已生成并写入计划', true, `候选 ${baseline} → ${baseline + 1}`)
      await sleep(2000)
      await shot(page, 'candidate-generated')
    }

    const candidate = (readPlanAsset()?.poseCandidates || []).at(-1) || null
    if (!candidate?.assetPath) throw new Error('没有可审核的候选')
    record.candidate = candidate
    if (candidate.sceneId && candidate.sceneId !== SCENE_ID) throw new Error(`候选场景不符：${candidate.sceneId}`)
    stepLog('C4 候选场景与提示词已留证', true, candidate.assetPath)

    if (APPLY) {
      const baselineVariants = (readPlanAsset()?.poseVariants || []).length
      const cards = await page.$$('.pose-pool-card')
      if (!cards.length) throw new Error('界面没有候选卡片')
      const lastCard = cards[cards.length - 1]
      const applied = await lastCard.evaluate((card) => {
        const button = Array.from(card.querySelectorAll('button')).find((item) => String(item.textContent || '').includes('锁定并应用到'))
        if (!button) return false
        button.scrollIntoView({ block: 'center' })
        button.click()
        return true
      })
      if (!applied) throw new Error('未找到「锁定并应用」按钮')
      const deadline = Date.now() + 240_000
      let variant = null
      while (Date.now() < deadline) {
        const variants = readPlanAsset()?.poseVariants || []
        if (variants.length > baselineVariants) { variant = variants.at(-1); break }
        const failed = await page.evaluate(() => document.body.innerText.includes('锁定失败') || document.body.innerText.includes('摆位失败'))
        if (failed) throw new Error('界面报告锁定或摆位失败')
        await sleep(3000)
      }
      if (!variant?.projectAssetId) throw new Error('未获得锁定后的项目资产')
      const story = JSON.parse(fs.readFileSync(STORY_JSON, 'utf-8'))
      const scene = (story.nodes || []).find((node) => String(node?.id || '') === SCENE_ID)
      const placements = scene?.visuals?.placements || []
      if (!placements.some((item) => item.imageAssetId === variant.projectAssetId)) throw new Error('目标场景未引用新姿态资产')
      record.appliedVariant = variant
      stepLog('C5 候选已锁定并应用到目标场景', true, variant.projectAssetId)
      await sleep(1500)
      await shot(page, 'candidate-applied')
    }

    // ============ D. 修改需求回跳蓝图 ============
    if (!(await clickByText(page, 'button', '修改需求'))) throw new Error('未找到「修改需求」按钮')
    await waitText(page, '蓝图', 30_000)
    await sleep(1500)
    stepLog('D1 修改需求已回跳蓝图层', true)
    await shot(page, 'back-to-blueprint')

    record.uiFacts = await page.evaluate(() => ({
      bodyHasError: document.body.innerText.includes('失败')
    }))
    record.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'record.json'), JSON.stringify(record, null, 2), 'utf-8')
    console.log(`证据包：${EVIDENCE_DIR}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
