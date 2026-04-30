#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

const CONTROL_BASE_URL = process.env.CONTROL_BASE_URL || 'http://127.0.0.1:2099'
const CONTROL_CONSOLE_URL = process.env.CONTROL_CONSOLE_URL || 'http://127.0.0.1:8870'
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://127.0.0.1:1999'
const OMLX_BASE_URL = process.env.OMLX_BASE_URL || 'http://127.0.0.1:18888/v1'
const AGENT_ID = 'hermes-manager'
const CLI_ARGV = process.argv.slice(2)
const CLI_ARGS = new Set(CLI_ARGV)
const REVIEW_VIA = CLI_ARGV.includes('--review-via=auto') ? 'auto' : CLI_ARGV.includes('--review-via=cli') ? 'cli' : 'control-ui'
const AUTO_VERDICT = !CLI_ARGS.has('--manual-verdict')
const USE_RUNNING_CONTROL = CLI_ARGS.has('--use-running-control')
const CONTINUE_ON_FAIL = !CLI_ARGS.has('--stop-on-fail')
const FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.CONTROL_PRODUCTION_FETCH_TIMEOUT_MS || 30000))
const CASE_TIMEOUT_MS = Math.max(60000, Number(process.env.CONTROL_PRODUCTION_CASE_TIMEOUT_MS || 20 * 60 * 1000))
const REVIEW_TIMEOUT_MS = Math.max(60000, Number(process.env.CONTROL_PRODUCTION_REVIEW_TIMEOUT_MS || 15 * 60 * 1000))
const POLL_INTERVAL_MS = Math.max(500, Number(process.env.CONTROL_PRODUCTION_POLL_INTERVAL_MS || 1500))
const LOCK_FILE = path.join(REPO_ROOT, 'state', 'control-production-test.lock')

let currentProductionSessionId = null
let shuttingDown = false

const rl = readline.createInterface({ input, output })

const STAGES = [
  {
    id: 'bootstrap',
    title: '初级阶段起步',
    description: '先启动并进入 control 控制器，打开控制器页面，完成人工确认后再运行 control 自检。',
    kind: 'bootstrap'
  },
  {
    id: 'l1',
    title: '中级阶段一',
    description: '通过 control 可观测交互入口执行 L1 项目事实理解测试。',
    kind: 'reasoning',
    cases: [
      // PASS 2026-04-29: reasoning_1777457704284_6d139a19
      // casePrompt('L1-01', 'apps/control-server 的职责是什么？'),
      // PASS 2026-04-29: reasoning_1777459658237_7e3c3086
      // casePrompt('L1-02', 'apps/server 的职责是什么？'),
      // PASS 2026-04-29: reasoning_1777459900787_c2ee31b6
      // casePrompt('L1-03', 'apps/editor 的职责是什么？'),
      // PASS 2026-04-29: reasoning_1777460041268_4f56c77b
      // casePrompt('L1-04', 'apps/control-console 的职责是什么？'),
      // PASS 2026-04-30: reasoning_1777512519780_bfe4722c
      // casePrompt('L1-05', '为什么模型输出不能直接等同于执行结果？'),
      // PASS 2026-04-30: reasoning_1777512781855_717ab3b0
      // casePrompt('L1-06', 'read_file_content 和 list_directory_contents 的参数边界分别是什么？'),
      // PASS 2026-04-30: reasoning_1777512908389_f570a332
      // casePrompt('L1-07', 'storage/demo_library 的职责是什么？'),
      //casePrompt('L1-08', 'config/hermes/intents 的定位是什么？'),
      //casePrompt('L1-09', 'config/hermes/skills 的定位是什么？'),
      //casePrompt('L1-10', '当前完整 workflow registry 是否已经建立？'),
      // casePrompt('L1-11', '当前 deterministic evaluator 是否已经覆盖所有故事 workflow？'),
      casePrompt('L1-12', '当前 Control Server 是否已经是完整项目自动化状态机？'),
      casePrompt('L1-13', '当前 Hermes 是否已经承担候选计划和候选解释生成？'),
      casePrompt('L1-14', '当前 GameStudio Server 是否已经具备项目读写和导出能力？'),
      casePrompt('L1-15', '为什么关键词打标签不能作为可靠性的主体？'),
      casePrompt('L1-16', '项目列表问题为什么应先列目录，而不是先读 scripts.json？'),
      casePrompt('L1-17', '当用户只问当前有哪些项目时，最终回答至少要包含哪几类证据？'),
      casePrompt('L1-18', '当前故事生成的目标能力链条包含哪些 workflow？'),
      casePrompt('L1-19', '当前生产放行前最关键的短期缺口是什么？'),
      casePrompt('L1-20', '当前中期最大的结构性缺口是什么？')
    ]
  },
  {
    id: 'l2',
    title: '中级阶段二',
    description: '通过 control 执行 L2 只读任务测试。',
    kind: 'reasoning',
    cases: [
      casePrompt('L2-01', '列出 storage/projects 当前已有项目。必须先列目录，不允许先读 scripts.json。'),
      casePrompt('L2-02', '列出 ai 目录下当前有哪些直接子项。'),
      casePrompt('L2-03', '找出 control 中负责 Hermes 对话和 reasoning 的主要后端文件。'),
      casePrompt('L2-04', '找出 editor 中主应用入口文件。'),
      casePrompt('L2-05', '找出业务后端中图片生成相关的主要服务端入口文件。'),
      casePrompt('L2-06', '说明 ai/memory/TASK_QUEUE.md 和 ai/memory/LONG_TASKS.md 的职责区别。'),
      casePrompt('L2-07', '分析 apps/editor 和 apps/server 的职责差异。'),
      casePrompt('L2-08', '找出当前项目中用于控制 Hermes 左脑配置的关键文件。'),
      casePrompt('L2-09', '找出当前 control 平面下用于 skill 或 intent 提案的相关后端文件。'),
      casePrompt('L2-10', '如果用户要求查看 storage/projects 内容，系统应返回什么层级的结果？'),
      casePrompt('L2-11', '如果用户要求读取 storage/projects 文件内容，系统应如何处理？'),
      casePrompt('L2-12', '如果用户要求查看不存在的目录，最终回答至少要包含什么？'),
      casePrompt('L2-13', '如果用户要求查看一个存在目录中的某个不存在文件，最终回答至少要包含什么？'),
      casePrompt('L2-14', '对 GameStudio 的编辑器前端目录在哪里 这类问题，回答为什么不能沿用上一轮 control 问题的目录结果？'),
      casePrompt('L2-15', '对 当前已有项目 类问题，回答中哪些内容属于编造风险？')
    ]
  },
  {
    id: 'l3',
    title: '中级阶段三',
    description: '通过 control 执行 L3 计划、审核与可观测执行测试。',
    kind: 'reasoning',
    cases: [
      casePrompt('L3-01', '列出当前已有项目。请先生成 reasoning plan，并验证是否固定为两步链。'),
      casePrompt('L3-02', '分析 apps/editor 与 apps/server 职责。请先生成 reasoning plan，并检查是否先列目录、再读 package.json 或入口文件、最后回答。'),
      casePrompt('L3-03', '创建一个新互动故事项目。只生成 plan，不执行。检查计划中是否出现高风险写入动作并需要审核。'),
      casePrompt('L3-04', '运行脚本重启 control。只生成 plan，不执行。检查是否使用白名单脚本动作。'),
      casePrompt('L3-05', '检查一个已完成只读任务的 runtime session，确认是否存在 plan、step events、tool_result、artifacts、final answer。'),
      casePrompt('L3-06', '检查一个需要人工审核的写入任务，确认是否会进入 waiting_review。'),
      casePrompt('L3-07', '对一个明确错误答案触发 quality gate，确认系统是否会记录评分、给出修正条件，并在低分时重新规划或进入人工确认。'),
      casePrompt('L3-08', '验证目录当文件读的错误场景，确认系统是否返回 read_file_content_not_file，而不是直接崩溃。'),
      casePrompt('L3-09', '检查 artifacts 是否包含真实路径、计数、摘要和错误详情。'),
      casePrompt('L3-10', '检查任务失败后是否能给出 recoverable 和 non-recoverable 的边界。'),
      casePrompt('L3-11', '检查一个人工驳回后的 session，确认是否会只重做被驳回目标，而不是整轮乱跳。'),
      casePrompt('L3-12', '检查一个人工确认质量覆盖的 session，确认是否会记录 quality calibration。')
    ]
  },
  {
    id: 'l4',
    title: '终级阶段一',
    description: '通过 control 执行 L4 故事 workflow 闭环测试。',
    kind: 'reasoning',
    cases: [
      casePrompt('L4-01', '创建一个新的互动故事项目，题目为 雨夜咖啡馆的时间循环。验证是否创建到 storage/projects，并给出项目目录证据。'),
      casePrompt('L4-02', '创建项目后，列出该项目目录下的直接子项。'),
      casePrompt('L4-03', '如果创建失败，说明尝试写入的目标路径以及未通过的审核点或 contract 缺口。'),
      casePrompt('L4-04', '为该项目写入生成配置：题材、风格、目标受众、输出语言。'),
      casePrompt('L4-05', '读取项目配置，确认写入结果与用户输入一致。'),
      casePrompt('L4-06', '如果配置还不能落盘，明确说明缺的 contract 或 API。'),
      casePrompt('L4-07', '基于一句 brief 生成故事大纲。'),
      casePrompt('L4-08', '将故事大纲转换成最小 story 或 scripts 结构。'),
      casePrompt('L4-09', '验证生成结果是否回到项目目录，而不是只停留在聊天回答。'),
      casePrompt('L4-10', '验证生成失败时，是否明确说明失败阶段在 大纲、脚本、写回 中的哪一层。'),
      casePrompt('L4-11', '为项目生成一张背景图候选。'),
      casePrompt('L4-12', '为项目生成一个角色立绘候选。'),
      casePrompt('L4-13', '验证图片生成结果是否在项目结构或资产引用层可定位。'),
      casePrompt('L4-14', '如果图片生成失败，区分 prompt 生成失败、模型服务失败、图片写回失败、引用回填失败。'),
      casePrompt('L4-15', '对项目执行结构校验。'),
      casePrompt('L4-16', '对项目执行资源引用校验。'),
      casePrompt('L4-17', '对项目执行导出。'),
      casePrompt('L4-18', '导出成功后，必须返回导出产物路径、导出时间、项目标识、校验摘要。'),
      casePrompt('L4-19', '导出失败后，必须返回已执行步骤、失败步骤、原因分类、是否可重试。'),
      casePrompt('L4-20', '最终说明哪些部分已经形成闭环，哪些部分仍依赖人工或缺口。')
    ]
  },
  {
    id: 'l5',
    title: '终级阶段二',
    description: '通过 control 执行 L5 稳定性、恢复与安全边界测试。',
    kind: 'reasoning',
    cases: [
      casePrompt('L5-01', '连续 3 次执行 列出当前已有项目，并验证结果必须一致。'),
      casePrompt('L5-02', '连续 3 次执行 分析 apps/editor 与 apps/server 职责，不得把上一轮问题带到下一轮。'),
      casePrompt('L5-03', '连续 2 次执行 生成同一项目的大纲，必须能区分覆盖、重写、生成新版本或需审核，而不是静默乱写。'),
      casePrompt('L5-04', '人工驳回某一步后重新执行，确认不会跳过前置依赖。'),
      casePrompt('L5-05', '对不存在目录执行 list_directory_contents，必须显式返回 not_found 边界。'),
      casePrompt('L5-06', '对文件执行目录列举，必须显式返回 not_directory 边界。'),
      casePrompt('L5-07', '对目录执行文件读取，必须显式返回 not_file 边界。'),
      casePrompt('L5-08', '对 workspace 外路径执行读写，必须显式拒绝。'),
      casePrompt('L5-09', '对未在白名单中的脚本执行请求，必须显式拒绝。'),
      casePrompt('L5-10', '对需要审核的写入任务，在未审核前不得执行。'),
      casePrompt('L5-11', '检查 state/agent-runtime-sessions 中的 session 是否能追溯一次完整任务链。'),
      casePrompt('L5-12', '检查 state/agent-runtime-events.jsonl 是否记录了关键事件。'),
      casePrompt('L5-13', '检查 reasoning-review-records.jsonl 是否能支撑失败样本复盘。'),
      casePrompt('L5-14', '检查 skill 或 intent proposal pipeline 是否不会直接执行未审核提案。'),
      casePrompt('L5-15', '检查质量评分失败后是否会进入明确的修正或人工确认分支。'),
      casePrompt('L5-16', '检查项目类失败问题是否会继续编造不存在的成功结果。'),
      casePrompt('L5-17', '检查控制台是否仍保留生命周期控制，不因新增能力而破坏启动、暂停、恢复、退出。'),
      casePrompt('L5-18', '检查在同一会话连续做 问答、小任务、长任务 时，是否还能保持边界清晰。')
    ]
  },
  {
    id: 'manual-gate',
    title: '生产结论阶段',
    description: '人工直接基于脚本结果与 artifacts 给出生产结论。',
    kind: 'manual'
  }
]

const results = {
  startedAt: new Date().toISOString(),
  controlBaseUrl: CONTROL_BASE_URL,
  controlConsoleUrl: CONTROL_CONSOLE_URL,
  serverBaseUrl: SERVER_BASE_URL,
  omlxBaseUrl: OMLX_BASE_URL,
  stages: []
}

async function main() {
  if (CLI_ARGS.has('--help') || CLI_ARGS.has('-h')) {
    printHelp()
    rl.close()
    return
  }

  acquireScriptLock()
  installSignalHandlers()

  printBanner()
  console.log('脚本会先检查 control 控制器，并要求通过 Control Console UI 审核推进后续测试。')

  for (const stage of STAGES) {
    const stageRecord = {
      id: stage.id,
      title: stage.title,
      description: stage.description,
      startedAt: new Date().toISOString(),
      status: 'running',
      cases: []
    }
    results.stages.push(stageRecord)

    console.log(`\n阶段 ${stage.title}: ${stage.description}`)

    let stagePassed = true
    if (stage.kind === 'bootstrap') {
      stagePassed = await runBootstrapStage(stageRecord)
    } else if (stage.kind === 'manual') {
      stagePassed = await runManualGate(stageRecord)
    } else {
      stagePassed = await runReasoningStage(stage, stageRecord)
    }

    stageRecord.status = stagePassed ? 'passed' : 'failed'
    stageRecord.endedAt = new Date().toISOString()

    if (!stagePassed) {
      if (CONTINUE_ON_FAIL) {
        console.log(`阶段 ${stage.title} 未全部达成，已记录失败项并继续后续覆盖。`)
        continue
      }
      console.log(`阶段 ${stage.title} 未达成，脚本停止。`)
      finalize('failed')
      return
    }
  }

  finalize('completed')
}

async function runBootstrapStage(stageRecord) {
  const checks = []
  stageRecord.cases = checks

  checks.push(await runBootstrapCheck('BOOT-01', '检查或启动 control', async () => {
    const controlRunning = await isControlStackRunning()

    if (!controlRunning) {
      await runCommand('bash', ['./restart_control.sh'], { cwd: REPO_ROOT })
      return { ok: true, detail: 'control 未运行，已执行 restart_control.sh 启动' }
    }

    const action = USE_RUNNING_CONTROL ? 'continue' : await chooseFromList('检测到 control 已在运行。请选择是否重启', [
      { value: 'continue', label: 'continue - 继续使用当前 control 实例' },
      { value: 'restart', label: 'restart - 重启 control 实例' },
      { value: 'stop', label: 'stop - 停止本次测试脚本' }
    ])

    if (action === 'restart') {
      await runCommand('bash', ['./restart_control.sh'], { cwd: REPO_ROOT })
      return { ok: true, detail: '检测到已有 control，按人工选择执行重启' }
    }

    if (action === 'stop') {
      throw new Error('user_stopped_before_bootstrap_start')
    }

    return { ok: true, detail: USE_RUNNING_CONTROL ? '检测到已有 control，自动继续使用当前实例' : '检测到已有 control，继续使用当前实例' }
  }))

  checks.push(await runBootstrapCheck('BOOT-02', '检查 control health', async () => {
    const data = await fetchJson(`${CONTROL_BASE_URL}/api/health`)
    const ok = Boolean(data?.ok)
    return { ok, detail: ok ? `service=${data.service}` : JSON.stringify(data) }
  }))

  checks.push(await runBootstrapCheck('BOOT-03', '检查 control console 可访问', async () => {
    const response = await fetch(CONTROL_CONSOLE_URL, { redirect: 'manual' })
    return { ok: response.status >= 200 && response.status < 500, detail: `http=${response.status}` }
  }))

  checks.push(await runBootstrapCheck('BOOT-03A', '保留当前 control 页面，不自动打开新标签', async () => {
    return { ok: true, detail: `请继续使用当前已打开的 control 页面: ${CONTROL_CONSOLE_URL}` }
  }))

  checks.push(await runBootstrapCheck('BOOT-03B', '检测到 control 页面后自动继续', async () => {
    return { ok: true, detail: '脚本不再自动打开新标签，直接继续后续检查' }
  }))

  checks.push(await runBootstrapCheck('BOOT-04', '检查 Hermes runtime 状态并按需恢复', async () => {
    let data = await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/runtime-status`)
    if (data?.runtimeStatus?.state !== 'running') {
      data = await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/runtime-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resume', brainSide: 'left', config: {} })
      })
    }
    const ok = data?.runtimeStatus?.state === 'running'
    return { ok, detail: ok ? `runtime=${data.runtimeStatus.state}` : JSON.stringify(data) }
  }))

  checks.push(await runBootstrapCheck('BOOT-05', '执行 control 自检', async () => {
    const data = await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/self-check`)
    const ok = Boolean(data?.ok && data?.selfCheck)
    return { ok, detail: ok ? 'self-check 返回成功' : JSON.stringify(data) }
  }))

  checks.push(await runBootstrapCheck('BOOT-06', '检查 OMLX 模型目录', async () => {
    const url = new URL(`${CONTROL_BASE_URL}/api/control/local-models`)
    url.searchParams.set('provider', 'omlx')
    url.searchParams.set('baseUrl', OMLX_BASE_URL)
    const data = await fetchJson(url.toString())
    const ok = Array.isArray(data?.models) && data.models.length > 0
    return { ok, detail: ok ? `models=${data.models.length}` : JSON.stringify(data) }
  }))

  const failed = checks.filter((item) => item.result !== 'PASS')
  if (failed.length === 0) {
    console.log('\ncontrol + 智能体运行正常。这是初级测试起步阶段。')
    return true
  }
  return false
}

async function runReasoningStage(stage, stageRecord) {
  for (const item of stage.cases) {
    const caseRecord = {
      id: item.id,
      title: item.title,
      prompt: item.prompt,
      startedAt: new Date().toISOString(),
      sessionId: null,
      status: 'running',
      notes: ''
    }
    stageRecord.cases.push(caseRecord)

    console.log(`\n${item.id} ${item.title}`)

    try {
      const session = await createReasoningSession(item.prompt, {
        stageId: stage.id,
        caseId: item.id,
        title: item.title
      })
      caseRecord.sessionId = session.session?.sessionId || null
      currentProductionSessionId = caseRecord.sessionId
      if (!caseRecord.sessionId) {
        throw new Error(`session_not_created: ${JSON.stringify(session)}`)
      }
      console.log(`创建 session: ${caseRecord.sessionId}`)
      await publishProductionTestSession({
        sessionId: caseRecord.sessionId,
        stageId: stage.id,
        caseId: item.id,
        title: item.title
      })

      const finalSession = await driveReasoningSession(caseRecord.sessionId)
      currentProductionSessionId = null
      await publishProductionTestSession({ sessionId: '' }).catch(() => null)
      caseRecord.session = summarizeSession(finalSession)
      caseRecord.controlStatus = finalSession.status
      caseRecord.finalAnswer = finalSession?.artifacts?.finalAnswer || ''

      const verdict = AUTO_VERDICT ? autoVerdict(item.id, finalSession) : await promptVerdict(item.id, finalSession)
      caseRecord.result = verdict.result
      caseRecord.notes = verdict.notes
      caseRecord.status = verdict.result === 'PASS' ? 'passed' : 'needs-review'
      caseRecord.endedAt = new Date().toISOString()

      if (verdict.result !== 'PASS' && !CONTINUE_ON_FAIL) {
        return false
      }
    } catch (error) {
      await cleanupActiveProductionSession().catch(() => null)
      caseRecord.status = 'failed'
      caseRecord.error = toErrorString(error)
      caseRecord.endedAt = new Date().toISOString()
      console.error(`案例失败: ${caseRecord.error}`)
      if (!CONTINUE_ON_FAIL) return false
    }
  }

  return stageRecord.cases.every((item) => item.result === 'PASS' || item.status === 'passed')
}

async function runManualGate(stageRecord) {
  const summary = buildSummary(results)
  console.log(`\n当前阶段摘要:\n${summary}`)
  if (AUTO_VERDICT) {
    const hasFailure = results.stages.some((stage) => (stage.cases || []).some((item) => item.result === 'FAIL' || item.result === 'BLOCKED' || item.status === 'failed'))
    const verdict = hasFailure ? 'FAIL' : 'PASS'
    stageRecord.manualConclusion = verdict
    stageRecord.notes = hasFailure ? '自动结论：存在失败或阻塞项，未达到生产放行条件。' : '自动结论：所有自动覆盖项通过。'
    stageRecord.cases = [{ id: 'manual-conclusion', result: verdict, notes: stageRecord.notes }]
    console.log(`自动生产结论: ${verdict} - ${stageRecord.notes}`)
    return verdict === 'PASS'
  }

  const verdict = await chooseFromList('请输入最终人工结论', [
    { value: 'PASS', label: 'PASS - 达到生产放行条件' },
    { value: 'FAIL', label: 'FAIL - 未达到生产放行条件' },
    { value: 'BLOCKED', label: 'BLOCKED - 仍有明确缺口' }
  ])
  const notes = await rl.question('请输入人工结论备注: ')
  stageRecord.manualConclusion = verdict
  stageRecord.notes = notes.trim()
  stageRecord.cases = [{ id: 'manual-conclusion', result: verdict, notes: stageRecord.notes }]
  return verdict === 'PASS'
}

async function runBootstrapCheck(id, title, fn) {
  const record = { id, title, startedAt: new Date().toISOString() }
  try {
    const result = await fn()
    record.result = result.ok ? 'PASS' : 'FAIL'
    record.detail = result.detail
    record.endedAt = new Date().toISOString()
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${id} ${title}: ${result.detail}`)
  } catch (error) {
    record.result = 'FAIL'
    record.detail = toErrorString(error)
    record.endedAt = new Date().toISOString()
    console.log(`FAIL ${id} ${title}: ${record.detail}`)
  }
  return record
}

async function createReasoningSession(prompt, testContext = {}) {
  return fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      productionTest: true,
      disableMemorySync: true,
      disableQualityAutoRetry: true,
      stageId: testContext.stageId || null,
      caseId: testContext.caseId || null,
      title: testContext.title || prompt
    })
  })
}

async function publishProductionTestSession(payload) {
  return fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/production-test-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

async function driveReasoningSession(sessionId) {
  const deadline = Date.now() + CASE_TIMEOUT_MS
  while (true) {
    if (Date.now() >= deadline) {
      await cancelSessionBestEffort(sessionId, 'control_production_case_timeout')
      throw new Error(`case_timeout:${sessionId}:${CASE_TIMEOUT_MS}ms`)
    }
    const data = await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions/${sessionId}`)
    const session = data?.session
    if (!session) {
      throw new Error(`session_not_found: ${sessionId}`)
    }

    printSessionSnapshot(session)

    if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
      return session
    }

    if (session.status === 'waiting_review' && session.review) {
      if (REVIEW_VIA === 'auto') {
        console.log(`自动审核通过: ${session.review.title}`)
        await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions/${sessionId}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approve', correctionPrompt: '' })
        })
        continue
      }

      if (REVIEW_VIA === 'control-ui') {
        await waitForControlConsoleReview(sessionId, session.review)
        continue
      }

      const decision = await promptReviewDecision(session.review)
      if (decision.action === 'pause') {
        await waitForManual(`session ${sessionId} 已暂停在 review。按回车继续。`)
        continue
      }
      if (decision.action === 'stop') {
        throw new Error(`session_stopped_by_user: ${sessionId}`)
      }
      await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions/${sessionId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision.payload)
      })
      continue
    }

    await delay(POLL_INTERVAL_MS)
  }
}

async function waitForControlConsoleReview(sessionId, review) {
  console.log(`\nsession ${sessionId} 正在等待 control 界面审核。`)
  console.log(`请在 ${CONTROL_CONSOLE_URL} 的“可观测推理链”面板处理中执行以下动作之一：`)
  console.log('  - approve: 通过并继续')
  console.log('  - reject: 驳回并填写修正条件')
  console.log('  - back: 后退一步')
  console.log('  - stop: 在 control 界面停止当前 session')
  console.log(`当前审核标题: ${review.title}`)

  const deadline = Date.now() + REVIEW_TIMEOUT_MS
  while (true) {
    if (Date.now() >= deadline) {
      await cancelSessionBestEffort(sessionId, 'control_production_review_timeout')
      throw new Error(`review_timeout:${sessionId}:${REVIEW_TIMEOUT_MS}ms`)
    }
    await delay(POLL_INTERVAL_MS)
    const data = await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions/${sessionId}`)
    const session = data?.session
    if (!session) {
      throw new Error(`session_not_found: ${sessionId}`)
    }
    if (session.status !== 'waiting_review') {
      return
    }
  }
}

async function promptReviewDecision(review) {
  console.log(`\n等待人工审核: ${review.title}`)
  console.log(`阶段: ${review.reviewPhase || 'unknown'}`)
  console.log(`摘要: ${review.summary || ''}`)
  const action = await chooseFromList('请选择审核动作', [
    { value: 'approve', label: 'approve - 通过，继续执行' },
    { value: 'reject', label: 'reject - 驳回并按修正条件重做' },
    { value: 'back', label: 'back - 回退一步重来' },
    { value: 'pause', label: 'pause - 暂停，人工稍后再继续' },
    { value: 'stop', label: 'stop - 结束脚本' }
  ])

  if (action === 'pause' || action === 'stop') {
    return { action }
  }

  const correctionPrompt = action === 'approve' ? '' : await rl.question('请输入修正说明（可留空）: ')
  return {
    action,
    payload: {
      decision: action,
      correctionPrompt: correctionPrompt.trim()
    }
  }
}

async function promptVerdict(caseId, session) {
  console.log(`\n${caseId} control 最终状态: ${session.status}`)
  if (session?.artifacts?.finalAnswer) {
    console.log('最终回答摘要:')
    console.log(truncate(session.artifacts.finalAnswer, 1200))
  }
  const result = await chooseFromList('请输入该题人工判定', [
    { value: 'PASS', label: 'PASS - 结果正确且证据完整' },
    { value: 'SOFT PASS', label: 'SOFT PASS - 结论基本正确，但证据或格式不完整' },
    { value: 'FAIL', label: 'FAIL - 结果错误或缺关键步骤/证据' },
    { value: 'BLOCKED', label: 'BLOCKED - 当前系统还不具备该能力' }
  ])
  const notes = await rl.question('请输入该题判定备注（可留空）: ')
  return { result, notes: notes.trim() }
}

function autoVerdict(caseId, session) {
  const finalAnswer = String(session?.artifacts?.finalAnswer || '').trim()
  if (session.status === 'completed' && finalAnswer.length > 0) {
    console.log(`${caseId} 自动判定: PASS`)
    return { result: 'PASS', notes: '自动判定：session completed 且存在最终回答。' }
  }
  if (session.status === 'completed') {
    console.log(`${caseId} 自动判定: SOFT PASS`)
    return { result: 'SOFT PASS', notes: '自动判定：session completed，但最终回答为空或缺失。' }
  }
  console.log(`${caseId} 自动判定: FAIL`)
  return { result: 'FAIL', notes: `自动判定：session 状态为 ${session.status}。` }
}

function summarizeSession(session) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    reviewPhase: session.review?.reviewPhase || null,
    currentStepId: session.currentStepId || null,
    planStepCount: Array.isArray(session.plan?.steps) ? session.plan.steps.length : 0,
    finalAnswerPreview: truncate(session?.artifacts?.finalAnswer || '', 500)
  }
}

function printSessionSnapshot(session) {
  const title = session.review?.title || session.currentStepId || 'no-active-step'
  console.log(`\n[session ${session.sessionId}] status=${session.status} focus=${title}`)
}

async function fetchJson(url, init = {}) {
  const externalSignal = init.signal
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal
  const response = await fetch(url, {
    ...init,
    signal,
    headers: {
      Accept: 'application/json',
      ...(init.headers || {})
    }
  })

  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  }
  return data
}

function acquireScriptLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true })
  if (fs.existsSync(LOCK_FILE)) {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim()
    const existingPid = Number(raw.split(/\s+/)[0])
    if (Number.isInteger(existingPid) && existingPid > 0) {
      try {
        process.kill(existingPid, 0)
        throw new Error(`control_production_test_already_running:pid=${existingPid}`)
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, `${process.pid} ${new Date().toISOString()}\n`, 'utf8')
}

function releaseScriptLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim()
    if (raw.startsWith(`${process.pid} `)) fs.unlinkSync(LOCK_FILE)
  } catch {}
}

function installSignalHandlers() {
  const handleSignal = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n收到 ${signal}，正在清理当前 production test session...`)
    cleanupActiveProductionSession()
      .catch((error) => console.error(`清理失败: ${toErrorString(error)}`))
      .finally(() => {
        releaseScriptLock()
        rl.close()
        process.exit(130)
      })
  }
  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)
}

async function cancelSessionBestEffort(sessionId, reason) {
  if (!sessionId) return
  try {
    await fetchJson(`${CONTROL_BASE_URL}/api/control/agents/${AGENT_ID}/agent-runtime-sessions/${sessionId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    })
  } catch {}
}

async function cleanupActiveProductionSession() {
  if (currentProductionSessionId) {
    await cancelSessionBestEffort(currentProductionSessionId, 'control_production_test_cleanup')
  }
  try {
    await publishProductionTestSession({ sessionId: '' })
  } catch {}
  currentProductionSessionId = null
}

async function isControlStackRunning() {
  const [serverReady, consoleReady] = await Promise.all([
    isUrlReachable(`${CONTROL_BASE_URL}/api/health`),
    isUrlReachable(CONTROL_CONSOLE_URL)
  ])
  return serverReady && consoleReady
}

async function isUrlReachable(url) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3000)
    })
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...options
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

function casePrompt(id, prompt) {
  return { id, title: prompt, prompt }
}

async function promptAction(message, actions) {
  console.log(message)
  return chooseFromList('请选择动作', actions.map((value) => ({ value, label: value })))
}

async function chooseFromList(question, options) {
  while (true) {
    console.log(question)
    options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option.label}`)
    })
    const answer = (await rl.question('输入序号: ')).trim()
    const index = Number.parseInt(answer, 10)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1].value
    }
    console.log('输入无效，请重新选择。')
  }
}

async function waitForManual(message) {
  console.log(`\n${message}`)
  await rl.question('按回车继续...')
}

function buildSummary(currentResults) {
  const lines = []
  for (const stage of currentResults.stages) {
    const counts = { PASS: 0, 'SOFT PASS': 0, FAIL: 0, BLOCKED: 0 }
    for (const item of stage.cases || []) {
      if (item.result && counts[item.result] !== undefined) {
        counts[item.result] += 1
      }
    }
    lines.push(`${stage.title}: status=${stage.status} PASS=${counts.PASS} SOFT PASS=${counts['SOFT PASS']} FAIL=${counts.FAIL} BLOCKED=${counts.BLOCKED}`)
  }
  return lines.join('\n')
}

function finalize(status) {
  results.status = status
  results.endedAt = new Date().toISOString()
  releaseScriptLock()
  console.log('\n====================')
  console.log('控制面生产测试执行结束')
  console.log(`状态: ${status}`)
  console.log(buildSummary(results))
  console.log('====================')
  console.log(JSON.stringify(results, null, 2))
  rl.close()
}

function printBanner() {
  console.log('========================================')
  console.log(' GameStudio Control Production Test CLI')
  console.log(' 以 control 反馈为基准的交互式分阶段测试脚本')
  console.log(' 先进入控制器页面，再开始题目执行')
  console.log('========================================')
  console.log(`control: ${CONTROL_BASE_URL}`)
  console.log(`console: ${CONTROL_CONSOLE_URL}`)
  console.log(`server: ${SERVER_BASE_URL}`)
  console.log(`omlx: ${OMLX_BASE_URL}`)
}

function printHelp() {
  console.log('Usage: node scripts/test/control_production_test.mjs [--help] [--review-via=ui|cli|auto] [--manual-verdict] [--use-running-control] [--stop-on-fail]')
  console.log('')
  console.log('行为:')
  console.log('1. 先检查 control 是否已运行；已运行时由人工选择继续或重启')
  console.log('2. 不再自动打开浏览器新标签，继续使用当前 control 页面')
  console.log('3. 不再要求阶段开始前输入序号确认，自动继续下一步')
  console.log('4. 运行 control 自检，确认 Hermes + OMLX')
  console.log('5. 已通过题目请直接在 STAGES 测试库中注释掉，注释后的题目不会进入测试流程')
  console.log('6. 再按 L1 -> L2 -> L3 -> L4 -> L5 -> 人工结论 继续')
  console.log('')
  console.log('审核模式:')
  console.log('默认使用 Control Console UI 审核推进 waiting_review，脚本只观察状态变化。')
  console.log('如需命令行审核，可追加 --review-via=cli；只有调试时才建议追加 --review-via=auto。')
  console.log('默认自动判定每题并继续覆盖；如需人工判定，可追加 --manual-verdict。')
  console.log('')
  console.log('说明: 在控制器前置阶段通过前，脚本不会直接进入 GameStudio editor 功能测试。')
}

function truncate(value, limit) {
  const text = String(value || '')
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}

function toErrorString(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error(`脚本异常退出: ${toErrorString(error)}`)
  finalize('crashed')
  process.exitCode = 1
})