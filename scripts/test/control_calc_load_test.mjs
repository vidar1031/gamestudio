// 守护台调度交互与计算负载测试（2026-11-09 用户指令）：
// - 交互消息（events/ingest kind=note）与计算任务（lease→OMLX）分离，两条通道独立。
// - 计算任务严格串行：上一个正确完成（回答 = 1+n）才发下一个；答错/出错即停，不盲目续发。
// - 任务名 talkscene；模型经租约声明 Qwen3.6-27B-4bit（守护台排队/换模由调度器处理）。
// 用法：node scripts/test/control_calc_load_test.mjs [maxN]（默认 200）
import { loadEnv } from '../../apps/server/src/env.js'
import { controlClientHeaders } from '../../apps/server/src/ai/resourceLease.js'

// 与 server 启动同款：先加载 .env/.env.local（LOCALOXML_API_KEY / STUDIO_CONTROL_CLIENT_KEY 等注入进程环境）
loadEnv()
import { openaiResponsesJsonForTools, extractResponseOutputText } from '../../apps/server/src/ai/openai.js'

const MAX_N = Math.max(1, Number(process.argv[2]) || 200)
const MODEL = 'Qwen3.6-27B-4bit'
const CONTROL = String(process.env.STUDIO_CONTROL_BASE_URL || 'http://127.0.0.1:2099').replace(/\/+$/, '')
const LOG_PREFIX = '[calc-test]'

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), LOG_PREFIX, ...args)
}

async function sendInteractiveNote(title, detail) {
  try {
    const res = await fetch(`${CONTROL}/api/control/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...controlClientHeaders() },
      body: JSON.stringify({ kind: 'note', title, detail, refTraceId: `calc-test-${Date.now()}` })
    })
    const json = await res.json().catch(() => null)
    log('交互消息已发送:', title, '| 回执:', res.status, JSON.stringify(json).slice(0, 160))
    return res.ok
  } catch (e) {
    log('交互消息发送失败:', e instanceof Error ? e.message : String(e))
    return false
  }
}

async function querySchedulerState() {
  try {
    const res = await fetch(`${CONTROL}/api/control/resources/state`, { headers: controlClientHeaders() })
    const s = await res.json()
    const queue = (s.llmQueue || []).map((w) => `#${w.position}:${String(w.holder || '').split(':').pop()}:${w.model}${w.starting ? '(换入中)' : ''}`)
    return `holders=${(s.llmHolders || []).length} queue=[${queue.join(' ')}] swap=${s.swapInFlight}`
  } catch {
    return 'state_unreachable'
  }
}

// 租约长连接会被重启/网络抖动掐断（首轮实测 resource_scheduler_unreachable）：
// 这类失败不是任务失败，按有限次数重试重排队；每次重试前报调度态。
// 注意：openai.js 本地调用已在内部持租约（openaiRequestJson → withResourceLease ts:llm:<model>），
// 本脚本不得再套外层租约——否则外层持有等内层、内层排队等外层，自我死锁（二轮实测）。
async function askCalc(n) {
  const started = Date.now()
  let lastErr = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const { json } = await openaiResponsesJsonForTools({
        body: {
          model: MODEL,
          input: `计算 1+${n} 等于多少？只回复一个阿拉伯数字，不要任何其他内容。`,
          max_output_tokens: 32
        },
        provider: 'localoxml',
        timeoutMs: 120_000
      })
      const costMs = Date.now() - started
      const text = String(extractResponseOutputText(json) || '').trim()
      const num = Number((text.match(/\d+/) || [])[0])
      return { ok: num === n + 1, num, text: text.slice(0, 40), costMs, attempts: attempt }
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      const retryable = /resource_scheduler_unreachable|resource_lease_timeout|fetch failed|socket|econnreset/i.test(msg)
      log(`[重试] n=${n} 第 ${attempt} 次失败：${msg.slice(0, 90)}（${retryable ? '可重试' : '不可重试'}）| 调度态: ${await querySchedulerState()}`)
      if (!retryable) throw e
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
  throw lastErr || new Error('askCalc_retry_exhausted')
}

async function main() {
  log(`开始：计算任务 1+n（n=1..${MAX_N}），严格串行，模型 ${MODEL} 经租约`)
  await sendInteractiveNote('TalkScene 交互测试开始', `talkscene 发起计算负载测试：1+n 串行任务（n=1..${MAX_N}），每次等正确完成再续发；用于验证守护台排队与状态回执。需配合：无需操作，正常调度即可。`)
  let done = 0
  for (let n = 1; n <= MAX_N; n += 1) {
    const stateBefore = await querySchedulerState()
    const r = await askCalc(n)
    if (!r.ok) {
      log(`[失败] n=${n} 回答=${r.text || '(空)'} 期望=${n + 1}——按纪律停止，不续发`)
      await sendInteractiveNote('TalkScene 计算测试中断', `n=${n} 回答非期望（得 "${r.text}"，期望 ${n + 1}），已完成 ${done} 题。请守护台侧留意是否有异常换模/拒绝记录。`)
      process.exit(2)
    }
    done += 1
    log(`[完成 ${done}/${MAX_N}] 1+${n}=${r.num} ✓ 耗时 ${(r.costMs / 1000).toFixed(1)}s（第 ${r.attempts} 次尝试）| 调度态: ${stateBefore}`)
    // 每 10 题向守护台发一次进度交互消息（与计算通道分离）
    if (done % 10 === 0) await sendInteractiveNote(`TalkScene 计算测试进度 ${done}/${MAX_N}`, `已连续正确完成 ${done} 题（当前 1+${n}=${r.num}）。调度侧如有排队/换模压力请知会。`)
  }
  await sendInteractiveNote('TalkScene 计算测试完成', `1+n 串行任务全部正确完成（n=1..${MAX_N}）。感谢配合。`)
  log('全部完成 ✓')
}

main().catch((e) => {
  log('异常终止:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
