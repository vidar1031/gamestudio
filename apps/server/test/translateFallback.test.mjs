// 业务面确定性核心单测：翻译容错与文本判定（无模型调用，纯函数路径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseModelJsonLenient } from '../src/ai/openai.js'

test('parseModelJsonLenient：裸 JSON 直解', () => {
  assert.deepEqual(parseModelJsonLenient('{"a":1}'), { a: 1 })
})

test('parseModelJsonLenient：代码围栏与夹带文字可解', () => {
  assert.deepEqual(parseModelJsonLenient('```json\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(parseModelJsonLenient('结果如下：{"a":3} 请查收'), { a: 3 })
})

test('parseModelJsonLenient：空输出显式报错 empty_ai_output', () => {
  assert.throws(() => parseModelJsonLenient('   '), /empty_ai_output/)
})
