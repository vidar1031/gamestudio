import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isGarbageMemoryContent,
  assertAuthoritativeMemoryContent
} from '../../apps/control-server/src/server/reasoning/memory.js'

test('空白内容被识别为垃圾', () => {
  assert.equal(isGarbageMemoryContent(''), true)
  assert.equal(isGarbageMemoryContent('   '), true)
  assert.equal(isGarbageMemoryContent('\n\t '), true)
})

test('有效记忆内容不被识别为垃圾', () => {
  assert.equal(isGarbageMemoryContent('## 当前目标\n打通生产链路。'), false)
  assert.equal(isGarbageMemoryContent('# DECISIONS.md\n- Hermes = 助手层'), false)
})

test('英文刷新指令被识别为垃圾', () => {
  assert.equal(isGarbageMemoryContent('Refresh ai/memory/STATUS.md after this run.'), true)
  assert.equal(isGarbageMemoryContent('Refresh this file'), true)
  assert.equal(isGarbageMemoryContent('Rewrite ai/memory/TASK_QUEUE.md'), true)
})

test('中文刷新/重写指令被识别为垃圾', () => {
  assert.equal(isGarbageMemoryContent('刷新本文件'), true)
  assert.equal(isGarbageMemoryContent('请刷新 ai/memory/STATUS.md'), true)
  assert.equal(isGarbageMemoryContent('请重写本文件'), true)
})

test('assertAuthoritativeMemoryContent 对垃圾内容抛错', () => {
  assert.throws(() => assertAuthoritativeMemoryContent('Refresh this file', 'STATUS.md'), /authoritative_memory_rejected_garbage/)
})

test('assertAuthoritativeMemoryContent 对有效内容通过', () => {
  assert.doesNotThrow(() => assertAuthoritativeMemoryContent('## 当前目标\n继续推进。', 'STATUS.md'))
})
