// 守护台状态机验收·批量计算（2026-11-09 用户指令）：
// 10 秒内并发发起 6 个计算任务（1+1、2+2 … 6+6），检验守护台并发调度与 §13 状态反馈是否正常。
// 每题独立经 openai.js 内部租约（ts:llm:<model>）；答错/出错该题记失败但不阻断他题。
// 收尾读取 state/events/inbound-task-status.jsonl 本次窗口内记录，核对每请求状态序列。
import { loadEnv } from '../../apps/server/src/env.js'
import { controlClientHeaders } from '../../apps/server/src/ai/resourceLease.js'
import { openaiResponsesJsonForTools, extractResponseOutputText } from '../../apps/server/src/ai/openai.js'
import { readFileSync } from 'node:fs'

loadEnv()

const MODEL = 'Qwen3.6-27B-4bit'
const CONTROL = 'http://127.0.0.1:2099'
const LOG_PREFIX = '[batch-test]'
const STATUS_FILE = 'state/events/inbound-task-status.jsonl'

function log(...args) { console.log(new Date().toISOString().slice(11, 19), LOG_PREFIX, ...args) }

async function sendNote(title, detail) {
  try {
    const res = await fetch(`${CONTROL}/api/control/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...controlClientHeaders() },
      body: JSON.stringify({ kind: 'note', title, detail, refTraceId: `batch-test-${Date.now()}` })
    })
    log('交互消息:', title, '| 回执:', res.status)
  } catch (e) { log('交互消息失败:', String(e)) }
}

async function askCalc(n) {
  const t0 = Date.now()
  try {
    const { json } = await openaiResponsesJsonForTools({
      body: { model: MODEL, input: `计算 ${n}+${n} 等于多少？只回复一个阿拉伯数字。`, max_output_tokens: 32 },
      provider: 'localoxml',
      timeoutMs: 120_000
    })
    const text = String(extractResponseOutputText(json) || '').trim()
    const num = Number((text.match(/\d+/) || [])[0])
    return { n, ok: num === n + n, num, costMs: Date.now() - t0, error: '' }
  } catch (e) {
    return { n, ok: false, num: NaN, costMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) }
  }
}

async function main() {
  log('批量验收：10 秒窗口内并发 6 题（1+1 … 6+6）')
  await sendNote('TalkScene 批量验收开始', '10 秒窗口并发 6 个计算任务（1+1…6+6），检验守护台并发调度与 task.status 状态反馈。')
  const startedAt = new Date()
  const t0 = Date.now()
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => askCalc(n)))
  const wallMs = Date.now() - t0
  for (const r of results.sort((a, b) => a.n - b.n)) {
    log(r.ok ? `  ${r.n}+${r.n}=${r.num} ✓ 耗时 ${(r.costMs / 1000).toFixed(1)}s` : `  ${r.n}+${r.n} ✗ ${r.error.slice(0, 80) || `回答=${r.num}`}`)
  }
  const okCount = results.filter((r) => r.ok).length
  log(`结果：${okCount}/6 正确，总墙钟 ${(wallMs / 1000).toFixed(1)}s`)

  // 状态反馈核对：本次窗口内守护台 task.status 推送
  await new Promise((r) => setTimeout(r, 3000)) // 等终态推送落盘
  const windowStart = startedAt.getTime() - 5000
  const perReq = new Map()
  try {
    for (const line of readFileSync(STATUS_FILE, 'utf8').trim().split('\n')) {
      let r
      try { r = JSON.parse(line) } catch { continue }
      const ts = Date.parse(String(r.updatedAt || r.ts || ''))
      if (!Number.isFinite(ts) || ts < windowStart) continue
      const rid = String(r.requestId || '')
      if (!rid) continue
      if (!perReq.has(rid)) perReq.set(rid, [])
      perReq.get(rid).push(`${r.state}${r.reason ? `(${r.reason})` : ''}@v${r.version}`)
    }
  } catch (e) { log('状态文件读取失败:', String(e)) }
  log(`task.status 推送：本窗口共 ${perReq.size} 个请求`)
  for (const [rid, seq] of perReq) log(`  ${rid}: ${seq.join(' → ')}`)

  await sendNote('TalkScene 批量验收结果', `6 题并发：${okCount}/6 正确，墙钟 ${(wallMs / 1000).toFixed(1)}s；task.status 推送覆盖 ${perReq.size} 个请求。`)
  if (okCount < 6) process.exitCode = 2
}
main().catch((e) => { log('异常终止:', e instanceof Error ? e.message : String(e)); process.exit(1) })
