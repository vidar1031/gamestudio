// 模型对话明细（只读留证，2026-10-12）：GameStudio 侧直连 oMLX 的本地模型调用
// 按日落盘 state/model-dialogs/<yyyy-mm-dd>.jsonl（仓根 state 目录），供守护台
// 「模型交互」视图经 GET /api/projects/:id/ai/model-dialogs 合并展示。
// 与 control 侧 modelTaskQueue.js 的记录字段对齐（ts/model/messages/response/usage/
// durationMs/ok/caller）；messages 与 response 各截断 2000 字符；绝不记录 apiKey。
// 写文件失败静默 catch，不得影响主链路。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const MODEL_DIALOGS_DIR = path.join(REPO_ROOT, 'state', 'model-dialogs')
const MODEL_DIALOG_TEXT_CHARS = 2000

function dayStamp(ts = new Date()) {
  const d = ts instanceof Date ? ts : new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function summarizeDialogMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (messages) {
    return messages.map((message) => ({
      role: String(message?.role || 'unknown'),
      content: String(message?.content ?? '').slice(0, MODEL_DIALOG_TEXT_CHARS)
    }))
  }
  // /responses 形态：input 字符串或结构化数组折叠为一条 user 摘要
  const input = body?.input
  if (typeof input === 'string' && input.trim()) {
    return [{ role: 'user', content: input.slice(0, MODEL_DIALOG_TEXT_CHARS) }]
  }
  if (Array.isArray(input)) {
    return input.map((item) => ({
      role: String(item?.role || 'user'),
      content: String(typeof item?.content === 'string' ? item.content : JSON.stringify(item?.content ?? '')).slice(0, MODEL_DIALOG_TEXT_CHARS)
    }))
  }
  return []
}

function extractDialogResponseText(data) {
  if (!data || typeof data !== 'object') return ''
  const chatContent = data?.choices?.[0]?.message?.content
  if (typeof chatContent === 'string' && chatContent) return chatContent
  const reasoning = data?.choices?.[0]?.message?.reasoning_content
  if (typeof reasoning === 'string' && reasoning) return reasoning
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text
  // /responses 形态：output[].content[].text 拼合
  const output = Array.isArray(data.output) ? data.output : []
  const texts = []
  for (const item of output) {
    const parts = Array.isArray(item?.content) ? item.content : []
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text) texts.push(part.text)
    }
  }
  return texts.join('\n')
}

/**
 * 追加一条本地模型对话记录（仅调用方判定为本地 localoxml 时调用）。
 * 写盘失败静默吞掉，不影响模型调用主链路。
 */
export function appendStudioModelDialog({ model, body, response, usage, durationMs, ok, error, caller } = {}) {
  try {
    fs.mkdirSync(MODEL_DIALOGS_DIR, { recursive: true })
    const record = {
      ts: new Date().toISOString(),
      source: 'gamestudio',
      caller: String(caller || '').trim() || null,
      model: String(model || ''),
      messages: summarizeDialogMessages(body),
      response: String(response || '').slice(0, MODEL_DIALOG_TEXT_CHARS),
      usage: usage && typeof usage === 'object' ? usage : null,
      durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
      ok: ok !== false,
      ...(ok === false ? { error: String(error || 'unknown') } : {})
    }
    fs.appendFileSync(path.join(MODEL_DIALOGS_DIR, `${dayStamp()}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 明细落盘失败不阻断模型调用
  }
}

export { extractDialogResponseText }

/**
 * 只读查询：最近模型对话（按 ts 倒序）。记录按日文件组织且不带项目归属
 * （调用链不穿透 projectId），按时间窗返回今天+昨天的最近 N 条并注明 scope。
 */
export function readStudioModelDialogs({ limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50))
  const entries = []
  try {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 86400000)
    for (const day of [dayStamp(yesterday), dayStamp(now)]) {
      const file = path.join(MODEL_DIALOGS_DIR, `${day}.jsonl`)
      if (!fs.existsSync(file)) continue
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try { entries.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
    }
  } catch {
    // 读取失败按空处理
  }
  entries.sort((a, b) => String(b?.ts || '').localeCompare(String(a?.ts || '')))
  return {
    entries: entries.slice(0, cap),
    scope: 'recent_window',
    note: '记录按时间窗采集（今天+昨天），不按项目隔离；同一时刻本机仅一个故事产线在跑，窗口内记录即当前产线对话。'
  }
}
