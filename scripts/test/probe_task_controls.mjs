import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const outputDir = new URL('../../state/evidence-packs/task-controls-2026-11-03/', import.meta.url)
await mkdir(outputDir, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox']
})
const results = { rerunConfirm: {}, taskStop: {}, errors: [] }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function clickText(page, selector, text, marker) {
  const found = await page.evaluate(({ selector, text, marker }) => {
    const element = [...document.querySelectorAll(selector)].find((node) => node.textContent?.trim() === text)
    if (!element) return false
    element.setAttribute('data-probe-target', marker)
    return true
  }, { selector, text, marker })
  if (!found) throw new Error(`找不到按钮：${text}`)
  await page.click(`[data-probe-target="${marker}"]`)
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  page.on('pageerror', (error) => results.errors.push(error.message))
  const aiRequests = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/ai\/(?:story|background|storyboard|review|character)/.test(new URL(request.url()).pathname)) {
      aiRequests.push(request.url())
    }
  })
  await page.goto('http://localhost:8868', { waitUntil: 'networkidle0' })
  await page.click('article.hub-proj')
  await page.waitForFunction(() => localStorage.getItem('talkscene.stage') !== 'hub', { timeout: 15_000 })
  await sleep(1000)
  const stage = await page.evaluate(() => localStorage.getItem('talkscene.stage'))
  results.rerunConfirm.stage = stage
  const pageText = await page.evaluate(() => document.body.innerText)
  if (pageText.includes('分析全部场景')) {
    await clickText(page, 'button', '分析全部场景', 'rerun-analysis')
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })
    const dialogText = await page.$eval('[role="dialog"]', (node) => node.textContent || '')
    if (!dialogText.includes('重新执行')) throw new Error(`未出现重复执行确认：${dialogText}`)
    results.rerunConfirm.dialog = dialogText
    const beforeCancel = aiRequests.length
    const dialog = await page.$('[role="dialog"]')
    const buttons = await dialog.$$('button')
    for (const button of buttons) {
      if ((await button.evaluate((node) => node.textContent?.trim())) === '取消') {
        await button.click()
        break
      }
    }
    await sleep(500)
    results.rerunConfirm.cancelClosedDialog = !(await page.$('[role="dialog"]'))
    results.rerunConfirm.requestsAfterCancel = aiRequests.length - beforeCancel
    if (!results.rerunConfirm.cancelClosedDialog || results.rerunConfirm.requestsAfterCancel !== 0) throw new Error('取消确认后仍关闭失败或发起了 AI 请求')
    await page.screenshot({ path: new URL('rerun-confirm-cancelled.png', outputDir).pathname, fullPage: true })
  } else {
    results.rerunConfirm.skipped = `当前 ${stage} 页没有“分析全部场景”入口`
    await page.screenshot({ path: new URL('project-current-stage.png', outputDir).pathname, fullPage: true })
  }
  await page.close()

  const mock = await browser.newPage()
  await mock.setViewport({ width: 1440, height: 900 })
  let stopped = false
  let stopCalls = 0
  const baseTask = {
    taskId: 'ui_mock_slow_task', projectId: 'ui-mock', kind: 'story.scene.analyze_elements',
    stage: 'running', current: 1, total: 3, message: '模拟慢任务：等待停止',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), done: false, error: ''
  }
  await mock.setRequestInterception(true)
  mock.on('request', async (request) => {
    const url = new URL(request.url())
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }
    if (request.method() === 'OPTIONS') {
      await request.respond({ status: 204, headers: cors, body: '' })
      return
    }
    if (url.pathname === '/api/ai/tasks') {
      const task = stopped ? { ...baseTask, stage: 'cancelled', done: true, error: 'task_cancelled_by_user', message: '已由用户停止；已完成内容保留' } : baseTask
      await request.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ success: true, tasks: [task] }) })
      return
    }
    if (url.pathname === `/api/ai/tasks/${baseTask.taskId}/cancel`) {
      stopCalls += 1
      stopped = true
      await request.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ success: true, task: { ...baseTask, stage: 'cancelled', done: true } }) })
      return
    }
    await request.continue()
  })
  await mock.goto('http://localhost:8868', { waitUntil: 'networkidle0' })
  await mock.waitForSelector('button[aria-label="任务进度"]', { timeout: 8000 })
  await mock.click('button[aria-label="任务进度"]')
  await mock.waitForSelector('button[aria-label="停止场景元素分析"]')
  await mock.screenshot({ path: new URL('task-stop-before.png', outputDir).pathname, fullPage: true })
  await Promise.all([
    mock.click('button[aria-label="停止场景元素分析"]'),
    mock.click('button[aria-label="停止场景元素分析"]').catch(() => {})
  ])
  await mock.waitForFunction(() => document.body.innerText.includes('已停止'), { timeout: 5000 })
  results.taskStop.stopCalls = stopCalls
  results.taskStop.finalText = await mock.$eval('.task-panel-body', (node) => node.textContent || '')
  if (stopCalls !== 1) throw new Error(`重复点击导致 ${stopCalls} 次取消请求`)
  await mock.screenshot({ path: new URL('task-stopped.png', outputDir).pathname, fullPage: true })
  await mock.close()
} finally {
  await writeFile(new URL('results.json', outputDir), JSON.stringify(results, null, 2))
  await browser.close()
}
console.log(JSON.stringify(results, null, 2))
