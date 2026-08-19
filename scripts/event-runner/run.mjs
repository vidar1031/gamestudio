#!/usr/bin/env node
/**
 * 外挂事件测试运行器（不进入 apps 业务代码）。
 *
 * 用法：
 *   node scripts/event-runner/run.mjs testcases/gamestudio/story-create.case.json
 *   node scripts/event-runner/run.mjs --all            # 跑 testcases/gamestudio/ 下全部用例
 *
 * 行为：
 *   1. 读取用例 JSON，逐 step 调 Control 的 POST /api/control/events/dispatch（caller=testcase, confirmed=true）
 *   2. 支持 ${vars.*} / ${capture.*} 插值；capture 从每步响应 JSON 中提取
 *   3. 断言类型：http.ok / json.path.exists / json.path.equals / fs.exists
 *   4. 逐事件输出 PASS/FAIL + 证据，报告写入 state/event-runs/<caseId>/<timestamp>.json
 *   5. 全部用例 PASS 退出码 0，否则 1
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const CONTROL_BASE_URL = process.env.CONTROL_BASE_URL || 'http://127.0.0.1:2099'
const CASES_DIR = path.join(REPO_ROOT, 'testcases', 'gamestudio')
const RUNS_ROOT = path.join(REPO_ROOT, 'state', 'event-runs')

function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function getPath(obj, jsonPath) {
  if (!jsonPath || jsonPath === '$') return obj
  const parts = String(jsonPath).replace(/^\$\.?/, '').split('.').filter(Boolean)
  let current = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    const match = part.match(/^([^[\]]+)(?:\[(\d+)\])?$/)
    if (!match) return undefined
    current = current[match[1]]
    if (match[2] !== undefined) {
      if (!Array.isArray(current)) return undefined
      current = current[Number(match[2])]
    }
  }
  return current
}

function resolveValue(value, vars, capture) {
  if (typeof value === 'string') {
    const whole = value.match(/^\$\{([^}]+)\}$/)
    if (whole) {
      const [scope, key] = whole[1].split('.')
      if (scope === 'vars') return vars[key]
      if (scope === 'capture') return capture[key]
      return value
    }
    return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const [scope, key] = expr.split('.')
      const resolved = scope === 'vars' ? vars[key] : scope === 'capture' ? capture[key] : undefined
      return resolved === undefined || resolved === null ? '' : String(resolved)
    })
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, vars, capture))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, vars, capture)]))
  }
  return value
}

async function dispatchStep({ caseId, step, payload }) {
  const res = await fetch(`${CONTROL_BASE_URL}/api/control/events/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: step.event,
      payload,
      caller: 'testcase',
      confirmed: true,
      caseId
    })
  })
  const body = await res.json().catch(() => null)
  return { httpStatus: res.status, body }
}

function getEventPath(ctx, jsonPath) {
  // 断言与 capture 面向事件业务结果书写：优先对 envelope.result 求值，回退到 envelope 本体
  if (ctx.body && typeof ctx.body === 'object' && 'result' in ctx.body) {
    const fromResult = getPath(ctx.body.result, jsonPath)
    if (fromResult !== undefined) return fromResult
  }
  return getPath(ctx.body, jsonPath)
}

function evaluateAssert(assertion, ctx) {
  const type = assertion.type
  if (type === 'http.ok') {
    return { pass: ctx.ok === true, detail: `ok=${ctx.ok} traceId=${ctx.traceId || '-'}` }
  }
  if (type === 'json.path.exists') {
    const value = getEventPath(ctx, assertion.path)
    return { pass: value !== undefined && value !== null, detail: `${assertion.path}=${value === undefined ? 'undefined' : 'exists'}` }
  }
  if (type === 'json.path.equals') {
    const actual = getEventPath(ctx, assertion.path)
    const expected = resolveValue(assertion.value, ctx.vars, ctx.capture)
    const pass = String(actual) === String(expected)
    return { pass, detail: `${assertion.path} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}` }
  }
  if (type === 'fs.exists') {
    const target = path.join(REPO_ROOT, resolveValue(assertion.path, ctx.vars, ctx.capture))
    const exists = fs.existsSync(target)
    return { pass: exists, detail: `${target} ${exists ? 'exists' : 'missing'}` }
  }
  return { pass: false, detail: `unknown_assert_type: ${type}` }
}

async function runCase(caseFile) {
  const caseDef = readJson(caseFile)
  const caseId = String(caseDef.caseId || path.basename(caseFile, '.case.json'))
  const vars = { ...(caseDef.vars || {}) }
  const capture = {}
  const report = {
    caseId,
    title: caseDef.title || caseId,
    caseFile: path.relative(REPO_ROOT, caseFile),
    startedAt: new Date().toISOString(),
    steps: [],
    verdict: 'PASS'
  }

  console.log(`\n▶ 用例 ${caseId}: ${report.title}`)

  for (const precondition of caseDef.preconditions || []) {
    if (precondition.type === 'service.reachable') {
      try {
        const res = await fetch(precondition.ref, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) throw new Error(`http_${res.status}`)
        console.log(`  前置 ${precondition.target}: 可达`)
      } catch (error) {
        console.log(`  前置 ${precondition.target}: 不可达 (${error.message})`)
        report.verdict = 'FAIL'
        report.steps.push({ stepId: 'precondition', event: null, ok: false, asserts: [{ type: 'service.reachable', pass: false, detail: error.message }] })
        writeReport(caseId, report)
        return false
      }
    }
  }

  for (const step of caseDef.steps || []) {
    const stepReport = { stepId: step.stepId, event: step.event, title: step.title || '', ok: true, asserts: [], traceId: null }
    const payload = resolveValue(step.payload || {}, vars, capture)
    let response
    try {
      response = await dispatchStep({ caseId, step, payload })
    } catch (error) {
      stepReport.ok = false
      stepReport.asserts.push({ type: 'dispatch', pass: false, detail: error.message })
      report.steps.push(stepReport)
      report.verdict = 'FAIL'
      console.log(`  ✗ ${step.stepId} ${step.event}: dispatch 异常 ${error.message}`)
      break
    }

    const body = response.body && typeof response.body === 'object' ? response.body : {}
    stepReport.traceId = body.traceId || null
    const ctx = { vars, capture, body, ok: Boolean(body.ok), traceId: body.traceId || null, httpStatus: response.httpStatus }

    for (const assertion of step.assert || []) {
      const evaluated = evaluateAssert(assertion, ctx)
      stepReport.asserts.push({ type: assertion.type, pass: evaluated.pass, detail: evaluated.detail })
      if (!evaluated.pass) stepReport.ok = false
    }

    if (step.capture && body.ok) {
      for (const [key, jsonPath] of Object.entries(step.capture)) {
        capture[key] = getEventPath(ctx, jsonPath)
      }
    }

    report.steps.push(stepReport)
    const mark = stepReport.ok ? '✓' : '✗'
    const failedDetail = stepReport.asserts.filter((a) => !a.pass).map((a) => a.detail).join('; ')
    console.log(`  ${mark} ${step.stepId} ${step.event}${stepReport.traceId ? ` trace=${stepReport.traceId.slice(0, 8)}` : ''}${failedDetail ? ` — ${failedDetail}` : ''}`)
    if (!stepReport.ok) {
      report.verdict = 'FAIL'
      break
    }
  }

  report.endedAt = new Date().toISOString()
  writeReport(caseId, report)
  console.log(`  结果: ${report.verdict}（报告 state/event-runs/${caseId}/）`)
  return report.verdict === 'PASS'
}

function writeReport(caseId, report) {
  const dir = path.join(RUNS_ROOT, caseId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) fail('请指定用例文件或 --all')

  let caseFiles = []
  if (args.includes('--all')) {
    if (!fs.existsSync(CASES_DIR)) fail(`用例目录不存在: ${CASES_DIR}`)
    caseFiles = fs.readdirSync(CASES_DIR).filter((name) => name.endsWith('.case.json')).map((name) => path.join(CASES_DIR, name)).sort()
  } else {
    caseFiles = args.map((arg) => path.resolve(REPO_ROOT, arg))
  }
  if (caseFiles.length === 0) fail('没有可执行的用例')

  let passCount = 0
  let failCount = 0
  for (const caseFile of caseFiles) {
    if (!fs.existsSync(caseFile)) {
      console.error(`❌ 用例文件不存在: ${caseFile}`)
      failCount += 1
      continue
    }
    const pass = await runCase(caseFile)
    if (pass) passCount += 1
    else failCount += 1
  }

  console.log(`\n====================`)
  console.log(`用例执行完成: PASS=${passCount} FAIL=${failCount}`)
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
