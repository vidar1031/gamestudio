import { generateScriptsViaOpenAI, repairScriptsViaOpenAI } from './openai.js'
import { generateScriptsViaDoubao, repairScriptsViaDoubao } from './doubao.js'
import { generateScriptsViaOllama, repairScriptsViaOllama } from './ollama.js'

// Q 波（2026-10-27 标题清洗，用户实证脏标题入库：「帮我创建一个《三只小猪?」原样成了项目名）：
// 剥创作意图前缀（帮我创建一个/写一个/讲一个…）、书名号《》、疑问/感叹尾与「的故事」类后缀。
// 量词（一个/则/篇）必选，避免误伤以动词起笔的真标题（如「做事的小熊」）。
export function guessTitleFromPrompt(prompt) {
  const s = String(prompt || '').trim()
  if (!s) return '未命名故事'
  let t = (s.split(/\r?\n/)[0] || s).replace(/^[#\s]+/, '')
  t = t.replace(/^(请|帮我|帮忙|给我|我想|我要)?(创建|创作|制作|生成|编写|写|做|讲)(一个|一则|一篇|个|则|篇)/u, '')
  t = t.replace(/[《》]/g, '')
  t = t.replace(/[？?！!。.\s]+$/u, '')
  t = t.replace(/(的互动故事|的故事|互动故事|故事|绘本)$/u, '')
  t = t.trim().slice(0, 20)
  return t || '未命名故事'
}

export function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function nowIso() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}

export function generateScriptsFromPrompt(prompt) {
  const raw = String(prompt || '').trim()
  const theme = raw || '一个新的故事主题'

  const lines = raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !/^[-*]\s*$/.test(x))

  let beats = []
  if (lines.length >= 2) {
    beats = lines.slice(0, 12)
  } else {
    const parts = raw
      .split(/(?<=[。！？!?])\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 8)
    beats = parts.length >= 2 ? parts : []
  }

  if (!beats.length) {
    beats = [
      `开场：${theme}`,
      `冲突：出现一个阻碍主角目标的困难`,
      `选择：给用户 2-3 个选项（后续在蓝图层实现分支）`,
      `结果：根据选择走向不同结局（后续补全）`
    ]
  }

  const cards = beats.map((text, i) => {
    const id = genId('sc')
    const name = `场景${i + 1}`
    return { id, name, order: i + 1, text: String(text), updatedAt: nowIso() }
  })

  return { schemaVersion: '1.0', cards, updatedAt: nowIso() }
}

export async function generateScriptDraft({ prompt, title, rules, formula, provider, model, apiUrl, proxyUrl, timeoutMs }) {
  const p = String(provider || process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  if (p === 'doubao') return generateScriptsViaDoubao({ prompt, title, rules, formula, model, apiUrl, proxyUrl, timeoutMs })
  if (p === 'ollama') return generateScriptsViaOllama({ prompt, title, rules, formula, model, apiUrl, proxyUrl, timeoutMs })
  // omlx 是 localoxml 的别名（Control 受控模式传入）
  if (p !== 'openai' && p !== 'localoxml' && p !== 'omlx') return null
  const normalizedProvider = p === 'omlx' ? 'localoxml' : p
  return generateScriptsViaOpenAI({ prompt, title, rules, formula, model, apiUrl, proxyUrl, timeoutMs, provider: normalizedProvider })
}

export async function repairScriptDraft({
  projectTitle,
  scripts,
  rules,
  formula,
  report,
  validation,
  provider,
  model,
  apiUrl,
  proxyUrl,
  timeoutMs
}) {
  const p = String(provider || process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  if (p === 'doubao') {
    return repairScriptsViaDoubao({
      projectTitle,
      scripts,
      rules,
      formula,
      report,
      validation,
      model,
      apiUrl,
      proxyUrl,
      timeoutMs
    })
  }
  if (p === 'ollama') {
    return repairScriptsViaOllama({
      projectTitle,
      scripts,
      rules,
      formula,
      report,
      validation,
      model,
      apiUrl,
      proxyUrl,
      timeoutMs
    })
  }
  if (p === 'openai' || p === 'localoxml') {
    return repairScriptsViaOpenAI({
      projectTitle,
      scripts,
      rules,
      formula,
      report,
      validation,
      model,
      provider: p,
      apiUrl,
      timeoutMs
    })
  }
  return null
}
