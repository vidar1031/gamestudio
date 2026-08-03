#!/usr/bin/env node
/**
 * 端到端真实生产验证：以真实用户 prompt（非 productionTest）从 Control 发起互动故事生产，
 * 驱动 session 至完成，并基于磁盘与 API 事实做取证断言。
 *
 * 用法：
 *   node scripts/test/e2e_story_production.mjs [--prompt="..."] [--manual-review] [--timeout-ms=2400000]
 *
 * 前置条件：
 *   - 全栈已启动（bash scripts/lifecycle/start_full_stack.sh）
 *   - Hermes runtime running 且左脑配置/预检已通过（脚本会检查，不代绕过）
 *
 * 退出码：0 = 全部断言通过；1 = 任一断言失败或链路错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CONTROL_BASE_URL = process.env.CONTROL_BASE_URL || 'http://127.0.0.1:2099'
const AGENT_ID = 'hermes-manager'

const DEFAULT_PROMPT = '一口气生产一个少年冒险互动故事：主角在古老灯塔中发现了一个秘密，包含 2 个分支选择点和 2 个不同结局。'

const args = process.argv.slice(2)
const getArg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/test/e2e_story_production.mjs [--prompt="..."] [--manual-review] [--timeout-ms=N]')
  process.exit(0)
}
const PROMPT = getArg('prompt') || DEFAULT_PROMPT
const MANUAL_REVIEW = args.includes('--manual-review')
const TIMEOUT_MS = Math.max(120000, Number(getArg('timeout-ms') || 40 * 60 * 1000))
const POLL_INTERVAL_MS = 5000

const STORAGE_ROOT = process.env.STUDIO_STORAGE_ROOT || path.join(ROOT, 'storage')

const failures = []
const evidences = []
const assert = (ok, label, detail = '') => {
  if (ok) {
    evidences.push(`✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* keep raw */ }
  if (!res.ok) {
    const detail = data ? JSON.stringify(data) : text.slice(0, 400)
    throw new Error(`HTTP ${res.status} ${url}: ${detail}`)
  }
  return data
}

async function waitForManualReview(sessionId, review) {
  console.log(`\n⏸  session 等待人工审核: ${review.title || ''}`)
  console.log('   请前往 http://127.0.0.1:8870 完成审核，脚本将持续轮询...')
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const data = await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions/${sessionId}`)
    if (data?.session?.status !== 'waiting_review') return
  }
}

async function main() {
  console.log('==========================================')
  console.log('  E2E 真实故事生产验证（非 productionTest）')
  console.log('==========================================')
  console.log(`prompt: ${PROMPT}`)
  console.log(`review: ${MANUAL_REVIEW ? '人工（console 审核）' : '脚本代为 approve（充当审核员，不绕过 review gate）'}`)

  // 1. 前置：control-server 健康 + Hermes runtime running
  await fetchJson(`${CONTROL_BASE_URL}/api/health`)
  const runtime = await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/runtime-status`)
  const runtimeState = runtime?.runtimeStatus?.state || runtime?.state || null
  if (runtimeState !== 'running') {
    console.error(`❌ Hermes runtime 未运行（state=${runtimeState}）。请先在 console 完成左脑配置 -> 预检 -> 启动。`)
    process.exit(1)
  }
  console.log('✅ Hermes runtime running')

  // 2. 创建 session（真实模式：不传 productionTest）
  const created = await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: PROMPT, title: PROMPT.slice(0, 40) })
  })
  const sessionId = created?.session?.sessionId
  if (!sessionId) throw new Error(`session_not_created: ${JSON.stringify(created).slice(0, 400)}`)
  console.log(`✅ session 已创建: ${sessionId}（plan 异步生成中）`)

  // 3. 驱动 session 至终态
  const deadline = Date.now() + TIMEOUT_MS
  let session = null
  let approvedCount = 0
  let planVerified = false
  while (Date.now() < deadline) {
    const data = await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions/${sessionId}`)
    session = data?.session
    if (!session) throw new Error(`session_lost: ${sessionId}`)

    // fail-fast：plan 就绪后确认确实是 story 生产工作流，避免误分类空跑
    if (!planVerified) {
      const planActions = (session.plan?.steps || []).map((s) => s?.action).filter(Boolean)
      if (planActions.length > 0) {
        planVerified = true
        console.log(`plan 步骤: ${planActions.join(' -> ')}`)
        if (!planActions.some((a) => String(a).startsWith('story_'))) {
          await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions/${sessionId}/cancel`, { method: 'POST' }).catch(() => null)
          console.error('❌ prompt 未触发 story 生产工作流（plan 中无 story_* 步骤），已取消 session。请调整 prompt 后重试。')
          process.exit(1)
        }
      }
    }

    if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') break

    if (session.status === 'waiting_review' && session.review) {
      if (MANUAL_REVIEW) {
        await waitForManualReview(sessionId, session.review)
      } else {
        approvedCount += 1
        console.log(`📝 审核点 ${approvedCount}: ${session.review.title || session.review.action || ''} -> approve`)
        await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions/${sessionId}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approve', correctionPrompt: '' })
        })
      }
      continue
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  if (!session || (session.status !== 'completed' && session.status !== 'failed' && session.status !== 'cancelled')) {
    throw new Error(`session_timeout: 超过 ${TIMEOUT_MS}ms 未到终态（当前 status=${session?.status}）`)
  }

  console.log(`\nsession 终态: ${session.status}（审核点 approve 数: ${approvedCount}）`)

  // 4. 取证断言
  const storyArtifacts = session.artifacts?.storyProduction || {}
  const steps = storyArtifacts.steps || {}

  assert(session.status === 'completed', 'session 完成', `status=${session.status}`)

  const failedSteps = Object.entries(steps).filter(([, s]) => s && s.ok === false)
  assert(failedSteps.length === 0, '无失败步骤', failedSteps.length ? failedSteps.map(([k]) => k).join(', ') : `${Object.keys(steps).length} 步全部 ok`)

  const scriptsMeta = storyArtifacts.scriptsCandidateMeta || {}
  assert(scriptsMeta.fallback === false, '脚本候选为真实模型生成（非兜底）', `fallback=${scriptsMeta.fallback}`)

  const reviewStep = steps['step_story_review_blueprint_agent']
  const hermesReview = reviewStep?.data?.hermesReview || null
  assert(Boolean(hermesReview) && !reviewStep?.data?.hermesError, '蓝图评审经 Hermes 真实完成', hermesReview ? `provider=${hermesReview.provider || 'unknown'} verdict=${hermesReview.verdict || ''}` : `hermesError=${reviewStep?.data?.hermesError || 'missing_review'}`)

  // 定位 projectId
  let projectId = storyArtifacts.projectId || null
  if (!projectId) {
    for (const s of Object.values(steps)) {
      if (s?.projectId) { projectId = s.projectId; break }
    }
  }
  assert(Boolean(projectId), '定位到生产项目 ID', projectId || 'not found')

  if (projectId) {
    const projectDir = path.join(STORAGE_ROOT, 'projects', projectId)
    const readJson = (rel) => {
      try { return JSON.parse(fs.readFileSync(path.join(projectDir, rel), 'utf8')) } catch { return null }
    }
    const scripts = readJson('scripts.json')
    const blueprint = readJson('blueprint.json')
    const story = readJson('story.json')
    const distIndex = path.join(projectDir, 'builds', 'latest', 'dist', 'index.html')

    assert(Boolean(scripts) && Array.isArray(scripts?.cards) && scripts.cards.length >= 4, 'scripts.json 卡片数 >= 4', `cards=${scripts?.cards?.length ?? 'missing'}`)
    assert(Boolean(blueprint) && Array.isArray(blueprint?.nodes) && blueprint.nodes.length >= 2, 'blueprint.json 节点数 >= 2', `nodes=${blueprint?.nodes?.length ?? 'missing'}`)
    assert(Boolean(story) && story.nodes && Object.keys(story.nodes).length >= 2, 'story.json 已合成', `nodes=${story?.nodes ? Object.keys(story.nodes).length : 'missing'}`)
    assert(fs.existsSync(distIndex) && fs.statSync(distIndex).size > 0, 'dist/index.html 已导出', fs.existsSync(distIndex) ? `${fs.statSync(distIndex).size} bytes` : 'missing')

    console.log(`\n项目目录: ${projectDir}`)
    console.log(`可玩地址: http://127.0.0.1:1999/demos/${projectId}/latest/dist/index.html`)
  }

  // 5. 证据报告
  console.log('\n========== 证据报告 ==========')
  for (const line of evidences) console.log(line)
  if (failures.length > 0) {
    console.log('\n========== 失败项 ==========')
    for (const line of failures) console.log(line)
    process.exit(1)
  }
  console.log('\n✅ E2E 真实生产验证通过：全链路为真实模型产出，无静默兜底。')
}

main().catch((error) => {
  console.error(`\n❌ E2E 验证中断: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
