import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildProjectMemorySystemMessage } from '../../apps/control-server/src/server/controlServerCore.js'

// 记忆注入 content-injection 有界化测试：
// - 正文注入 + 每文件/总量字符上限截尾标注（env 可配）；
// - 缺失文件/空文件跳过不注入；
// - AGENTS.md（Agent Definition）默认不注入正文、仅列引用，可用 env 开极低上限；
// - references-only 保留为可选项，且文案不再暗示「去读文件」（与注入文案分离）。

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-overlay-'))

const FILES = {
  agentDefinitionFile: 'AGENTS.md',
  userFile: 'USER.md',
  memoryFile: 'MEMORY.md',
  longTasksFile: 'LONG_TASKS.md',
  statusFile: 'STATUS.md',
  taskQueueFile: 'TASK_QUEUE.md',
  decisionsFile: 'DECISIONS.md'
}

const OVERLAY_ENV_KEYS = [
  'HERMES_MEMORY_OVERLAY_FILE_CHAR_LIMIT',
  'HERMES_MEMORY_OVERLAY_TOTAL_CHAR_LIMIT',
  'HERMES_MEMORY_OVERLAY_AGENT_DEFINITION_CHAR_LIMIT'
]
const savedEnv = Object.fromEntries(OVERLAY_ENV_KEYS.map((key) => [key, process.env[key]]))

function restoreEnv() {
  for (const key of OVERLAY_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
}

function writeMemoryFile(name, content) {
  const filePath = path.join(TMP_DIR, name)
  if (content === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return filePath
  }
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

function buildOverlayBinding(overrides = {}) {
  const memory = Object.fromEntries(Object.entries(FILES).map(([key, name]) => [key, path.join(TMP_DIR, name)]))
  return {
    provider: 'omlx',
    baseUrl: 'http://127.0.0.1:18888/v1',
    model: 'Model-A',
    workflow: { memoryOverlayMode: 'content-injection', replayWindowMessages: 0, reasoningReplayWindowMessages: 0 },
    memory: { ...memory, dailyLogDir: '' },
    skills: { skillFiles: [] },
    ...overrides
  }
}

test('content-injection：注入核心记忆正文，每文件上限截尾并标注', () => {
  writeMemoryFile('AGENTS.md', 'AGENT_CONTRACT_不应默认注入 '.repeat(50))
  writeMemoryFile('USER.md', `USER_FACT_互动故事生产工具 ${'u'.repeat(500)}`)
  writeMemoryFile('MEMORY.md', `MEMORY_FACT_控制平面与编辑器 ${'m'.repeat(500)}`)
  process.env.HERMES_MEMORY_OVERLAY_FILE_CHAR_LIMIT = '200'
  try {
    const result = buildProjectMemorySystemMessage(buildOverlayBinding(), '你是谁？', {})
    assert.equal(result.overlayMode, 'content-injection')
    assert.ok(result.message.includes('USER_FACT_互动故事生产工具'), '应注入 USER.md 正文事实')
    assert.ok(result.message.includes('MEMORY_FACT_控制平面与编辑器'), '应注入 MEMORY.md 正文事实')
    assert.ok(result.message.includes('content-injection'))
    assert.ok(result.message.includes('已截尾'), '超限文件必须截尾标注')
    // 每文件截尾在 200 字符内
    for (const section of result.overlayInjection.sections) {
      assert.ok(section.content.length <= 200, `${section.label} 超过每文件上限`)
      assert.equal(section.truncated, true)
    }
    // AGENTS.md 默认不注入正文，仅以引用列出
    assert.ok(!result.message.includes('AGENT_CONTRACT_不应默认注入'), 'Agent Definition 默认不得注入正文')
    assert.ok(result.overlayInjection.referenceOnly.some((source) => source.label === 'Agent Definition'))
    // 注入统计受控：总量不超过默认总上限
    assert.ok(result.overlayInjection.usedChars <= result.overlayInjection.totalCharLimit)
    // 注入模式文案：不再要求模型去读文件
    assert.ok(result.message.includes('不要再尝试读取这些文件'))
  } finally {
    restoreEnv()
  }
})

test('content-injection：总量上限耗尽后剩余来源降级为路径引用，注入总量有界', () => {
  writeMemoryFile('USER.md', `USER_FACT_A ${'u'.repeat(800)}`)
  writeMemoryFile('MEMORY.md', `MEMORY_FACT_B ${'m'.repeat(800)}`)
  process.env.HERMES_MEMORY_OVERLAY_FILE_CHAR_LIMIT = '300'
  process.env.HERMES_MEMORY_OVERLAY_TOTAL_CHAR_LIMIT = '350'
  try {
    const result = buildProjectMemorySystemMessage(buildOverlayBinding(), '你是谁？', {})
    // 总量 350：第一个文件 300，第二个文件预算 50（截尾）
    assert.ok(result.overlayInjection.usedChars <= 350, '注入总量不得超上限')
    assert.ok(result.message.includes('总量上限 350'))
    const totalContent = result.overlayInjection.sections.reduce((sum, section) => sum + section.content.length, 0)
    assert.equal(totalContent, result.overlayInjection.usedChars)
    // 防回归：整条系统消息尺寸受控（注入正文 + 固定文案开销）
    assert.ok(result.message.length <= 350 + 2000, `提示词尺寸失控: ${result.message.length}`)
  } finally {
    restoreEnv()
  }
})

test('content-injection：缺失文件与空文件跳过不注入', () => {
  writeMemoryFile('LONG_TASKS.md', null) // 缺失
  writeMemoryFile('STATUS.md', '') // 空文件
  writeMemoryFile('TASK_QUEUE.md', 'TASK_FACT_当前待办事项')
  writeMemoryFile('DECISIONS.md', null) // 缺失
  const result = buildProjectMemorySystemMessage(buildOverlayBinding(), '当前状态、进度与任务队列？', {})
  assert.equal(result.overlayMode, 'content-injection')
  assert.ok(result.message.includes('TASK_FACT_当前待办事项'), '存在的文件应注入')
  const injectedLabels = result.overlayInjection.sections.map((section) => section.label)
  assert.ok(!injectedLabels.includes('Long Tasks'), '缺失文件不得注入')
  assert.ok(!injectedLabels.includes('Project Status'), '空文件不得注入')
  assert.ok(!injectedLabels.includes('Decisions'), '缺失文件不得注入')
  assert.ok(!result.overlayInjection.referenceOnly.some((source) => source.label === 'Decisions'), '缺失文件也不应列为参考')
})

test('content-injection：Agent Definition 可用 env 显式开极低上限注入', () => {
  writeMemoryFile('AGENTS.md', `AGENT_FACT_工作契约 ${'a'.repeat(300)}`)
  process.env.HERMES_MEMORY_OVERLAY_AGENT_DEFINITION_CHAR_LIMIT = '60'
  try {
    const result = buildProjectMemorySystemMessage(buildOverlayBinding(), '你是谁？', {})
    const agentSection = result.overlayInjection.sections.find((section) => section.label === 'Agent Definition')
    assert.ok(agentSection, '显式开启后应注入 Agent Definition')
    assert.ok(agentSection.content.length <= 60)
    assert.ok(agentSection.content.includes('AGENT_FACT_工作契约'))
  } finally {
    restoreEnv()
  }
})

test('references-only：保留为可选项，文案明确「正文未注入、不要读文件、不要编造」', () => {
  writeMemoryFile('MEMORY.md', 'MEMORY_FACT_不应出现在引用模式')
  const binding = buildOverlayBinding({
    workflow: { memoryOverlayMode: 'references-only', replayWindowMessages: 0, reasoningReplayWindowMessages: 0 }
  })
  const result = buildProjectMemorySystemMessage(binding, '项目状态与决策？', {})
  assert.equal(result.overlayMode, 'references-only')
  assert.equal(result.overlayInjection, null)
  // 只列路径，不含正文
  assert.ok(!result.message.includes('MEMORY_FACT_不应出现在引用模式'), '引用模式不得包含文件正文')
  assert.ok(result.message.includes('DECISIONS.md'), '仍应列出来源路径')
  // 新文案：明确正文不在提示词中、不要假装读过；旧的误导性文案必须移除
  assert.ok(result.message.includes('正文未包含在本提示词中'))
  assert.ok(result.message.includes('不要尝试读取这些文件'))
  assert.ok(result.message.includes('不要编造'))
  assert.ok(!result.message.includes('Controller only passes source references'), '旧的“读不到却要读”文案必须移除')
  assert.ok(!result.message.includes('treat as authoritative') && !result.message.includes('treated as authoritative'), '引用模式不得再宣称正文是 authoritative 上下文')
})

test('兼容回退：binding 未声明 memoryOverlayMode 时仍按 references-only 处理', () => {
  const binding = buildOverlayBinding({ workflow: { replayWindowMessages: 0 } })
  const result = buildProjectMemorySystemMessage(binding, '项目状态？', {})
  assert.equal(result.overlayMode, 'references-only')
})
