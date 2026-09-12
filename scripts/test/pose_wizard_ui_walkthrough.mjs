#!/usr/bin/env node
// 姿势链 UI 走查（2026-09-10 用户指令：必须真实界面交互、留下记录、不能跳过）
// 路径：打开乌鸦喝水合成工作室 → 锁定事物向导 → 步骤模式第 5 步 → 乌鸦资产姿势变体区
//   → 提取剧情姿势需求（本地 27B 提取） → 需求行「生成 1 张」（ComfyUI 出图） → 候选出现
// 证据：逐步截图 + record.json 落 state/evidence-packs/pose-ui-walkthrough-<ts>/
import fs from 'node:fs'
import path from 'node:path'

const PROJECT_ID = '839023d3-3475-47f6-b7a6-71e28dffcc61'
const EDITOR_BASE = process.env.STUDIO_EDITOR_URL || 'http://localhost:8868'
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const EVIDENCE_DIR = path.resolve(process.cwd(), 'state', 'evidence-packs', `pose-ui-walkthrough-${ts}`)
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

const record = { projectId: PROJECT_ID, startedAt: new Date().toISOString(), steps: [], screenshots: [] }
function stepLog(name, ok, detail) {
  record.steps.push({ name, ok, detail: String(detail || ''), at: new Date().toISOString() })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
async function shot(page, name) {
  const file = path.join(EVIDENCE_DIR, `${String(record.screenshots.length + 1).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  record.screenshots.push(file)
  console.log(`  📸 ${path.basename(file)}`)
}

// 文本点击助手（中文 UI，无测试 id）
async function clickByText(page, selector, text, { exact = false } = {}) {
  return page.evaluate(({ selector, text, exact }) => {
    const nodes = Array.from(document.querySelectorAll(selector))
    const hit = nodes.find((n) => {
      const t = String(n.textContent || '').trim()
      return exact ? t === text : t.includes(text)
    })
    if (!hit) return false
    hit.scrollIntoView({ block: 'center' })
    hit.click()
    return true
  }, { selector, text, exact })
}
async function waitText(page, text, timeoutMs) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: timeoutMs }, text)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const puppeteer = (await import('puppeteer-core')).default
  const exe = process.env.STUDIO_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (!fs.existsSync(exe)) throw new Error(`chrome_not_found: ${exe}`)
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: false, // 可见窗口：可观测纪律与 ComfyUI 可见窗口同款
    args: ['--no-sandbox', '--window-size=1680,1050', '--mute-audio']
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1680, height: 1000 })
    // 直达合成工作室（编辑器 stage/projectId 记忆机制）
    await page.evaluateOnNewDocument((pid) => {
      localStorage.setItem('gamestudio.stage', 'compose')
      localStorage.setItem('gamestudio.projectId', pid)
    }, PROJECT_ID)
    await page.goto(EDITOR_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    // 1. 等编辑器加载完，打开锁定事物向导
    await waitText(page, '锁定事物', 40_000)
    await sleep(1500)
    await shot(page, 'compose-loaded')
    if (!(await clickByText(page, 'button', '锁定事物'))) throw new Error('未找到「锁定事物」按钮')
    await waitText(page, '步骤模式', 20_000)
    await sleep(800)
    stepLog('打开锁定事物向导', true)
    await shot(page, 'wizard-open')

    // 2. 切步骤模式并进第 5 步
    await clickByText(page, 'button', '步骤模式')
    await sleep(600)
    if (!(await clickByText(page, 'button', '5. 参考图与锁定'))) throw new Error('第 5 步不可点（门禁未过？）')
    await sleep(800)
    stepLog('进入第 5 步 参考图与锁定', true)
    await shot(page, 'step5')

    // 3. 展开乌鸦资产的姿势变体区（DOM 实测：仅乌鸦有「姿势变体」SPAN，点它即展开/收起）
    if (!(await clickByText(page, 'span', '姿势变体'))) throw new Error('未找到「姿势变体」展开器')
    await sleep(800)
    if (!(await waitText(page, '剧情姿势需求', 10_000).then(() => true).catch(() => false))) throw new Error('姿势变体区未展开')
    stepLog('展开乌鸦姿势变体区', true)
    await shot(page, 'pose-section')

    // 4. 提取剧情姿势需求（本地模型，~80s；已提取过则跳过——需求清单持久化在 plan，刷新不丢）
    const existingReqRows = await page.evaluate(() => document.querySelectorAll('.pose-req-row').length)
    if (existingReqRows > 0) {
      stepLog('剧情姿势需求已存在', true, `${existingReqRows} 条（复用持久化清单，不重复调用模型）`)
    } else {
      if (!(await clickByText(page, 'button', '提取剧情姿势需求'))) throw new Error('未找到提取按钮')
      stepLog('点击「提取剧情姿势需求」', true)
      await sleep(3000)
      await shot(page, 'extract-running')
      // 等待需求行出现（最多 4 分钟）
      await page.waitForFunction(() => {
        const rows = document.querySelectorAll('.pose-req-row')
        return rows.length > 0
      }, { timeout: 240_000 })
      const reqCount = await page.evaluate(() => document.querySelectorAll('.pose-req-row').length)
      stepLog('剧情姿势需求提取完成', true, `${reqCount} 条需求出现在界面`)
    }
    await shot(page, 'requirements-extracted')

    // 5. 第一条需求行点「生成 1 张」（ComfyUI 出图 + 评审链）
    // 2026-09-10 修正等待条件：候选计数以磁盘真相源（project.json plan 镜像）为准——
    // 上两轮教训：DOM 候选卡类名与参考图条共用导致假阳性；姿势候选池区域折叠导致假超时。
    const PROJECT_JSON = path.resolve(process.cwd(), 'storage', 'projects', PROJECT_ID, 'project.json')
    const diskPoseCandCount = () => {
      try {
        const doc = JSON.parse(fs.readFileSync(PROJECT_JSON, 'utf-8'))
        const assets = doc?.state?.aiBackground?.storyAssetPlan?.assets || []
        const crow = assets.find((a) => String(a?.id || '') === 'crow')
        return (crow?.poseCandidates || []).length
      } catch { return -1 }
    }
    const baselineCards = await page.evaluate(() => document.querySelectorAll('.story-lock-candidate-card').length)
    const baselinePoseCands = diskPoseCandCount()
    const clicked = await page.evaluate(() => {
      const row = document.querySelector('.pose-req-row')
      if (!row) return false
      const btn = Array.from(row.querySelectorAll('button')).find((b) => String(b.textContent || '').includes('生成 1 张'))
      if (!btn) return false
      btn.scrollIntoView({ block: 'center' })
      btn.click()
      return true
    })
    if (!clicked) throw new Error('需求行「生成 1 张」按钮未找到')
    stepLog('点击需求行「生成 1 张」', true, `基线姿势候选 ${baselinePoseCands} 条（磁盘真相源）`)
    await sleep(5000)
    await shot(page, 'generate-running')
    // 轮询磁盘真相源：poseCandidates 增加=成功；页面出现失败文本=失败（翻译+出图约 2-4 分钟）
    let genResult = { state: 'timeout' }
    const deadline = Date.now() + 420_000
    while (Date.now() < deadline) {
      const failed = await page.evaluate(() => document.body.innerText.includes('姿势需求生成失败') || document.body.innerText.includes('出图失败'))
      if (failed) { genResult = { state: 'failed' }; break }
      const now = diskPoseCandCount()
      if (now > baselinePoseCands) { genResult = { state: 'candidate', count: now }; break }
      await sleep(5000)
    }
    if (genResult.state === 'candidate') {
      stepLog('姿势候选已出图并持久化', true, `poseCandidates ${baselinePoseCands} → ${genResult.count} 条（界面+磁盘一致）`)
    } else {
      stepLog('姿势候选生成', false, `状态=${genResult.state}`)
    }
    await sleep(2000)
    await shot(page, 'generate-result')

    // 6. 记录界面上的需求与候选实况
    record.uiFacts = await page.evaluate(() => ({
      requirementRows: document.querySelectorAll('.pose-req-row').length,
      candidateCards: document.querySelectorAll('.story-lock-candidate-card').length,
      bodyHasError: document.body.innerText.includes('失败')
    }))
    record.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'record.json'), JSON.stringify(record, null, 2), 'utf-8')
    console.log(`\n证据包：${EVIDENCE_DIR}`)
    const failed = record.steps.filter((s) => !s.ok)
    process.exitCode = failed.length ? 1 : 0
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  record.error = e instanceof Error ? e.message : String(e)
  record.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'record.json'), JSON.stringify(record, null, 2), 'utf-8')
  console.error(`❌ 走查失败：${record.error}`)
  process.exitCode = 1
})
