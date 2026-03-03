import { generateScriptsViaOpenAI, repairScriptsViaOpenAI } from './openai.js'
import { generateScriptsViaDoubao, repairScriptsViaDoubao } from './doubao.js'
import { generateScriptsViaOllama, repairScriptsViaOllama } from './ollama.js'

export function guessTitleFromPrompt(prompt) {
  const s = String(prompt || '').trim()
  if (!s) return '未命名故事'
  const firstLine = s.split(/\r?\n/)[0] || s
  return firstLine.replace(/^[#\s]+/, '').slice(0, 20) || '未命名故事'
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

export async function generateScriptDraft({ prompt, title, rules, formula, provider, model, proxyUrl, timeoutMs }) {
  const p = String(provider || process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  if (p === 'doubao') return generateScriptsViaDoubao({ prompt, title, rules, formula, model, proxyUrl, timeoutMs })
  if (p === 'ollama') return generateScriptsViaOllama({ prompt, title, rules, formula, model, proxyUrl, timeoutMs })
  if (p !== 'openai') return null
  return generateScriptsViaOpenAI({ prompt, title, rules, formula, model, timeoutMs })
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
  proxyUrl
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
      proxyUrl
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
      proxyUrl
    })
  }
  if (p === 'openai') {
    return repairScriptsViaOpenAI({
      projectTitle,
      scripts,
      rules,
      formula,
      report,
      validation,
      model
    })
  }
  return null
}
