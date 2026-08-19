// parseModelJsonLenient：模型输出 JSON 的宽松解析（Qwen 裸控制字符场景）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseModelJsonLenient } from '../../apps/server/src/ai/openai.js'

test('parseModelJsonLenient: 合法 JSON 直接解析', () => {
  const result = parseModelJsonLenient('{"title":"狼来了","cards":[{"name":"开场","text":"牧羊童上山放羊。"}]}')
  assert.equal(result.title, '狼来了')
  assert.equal(result.cards.length, 1)
})

test('parseModelJsonLenient: 字符串字面量内裸换行/制表符被转义修复（Qwen 实测场景）', () => {
  // Qwen 会在 JSON 字符串值里直接输出裸 \n / \t，严格 JSON.parse 报 Bad control character
  const raw = '{"title":"狼来了","cards":[{"name":"开场","text":"从前有个牧羊童，\n每天赶着羊群上山。\t他很无聊。"}]}'
  assert.throws(() => JSON.parse(raw), /Bad control character/)
  const result = parseModelJsonLenient(raw)
  assert.equal(result.cards[0].text, '从前有个牧羊童，\n每天赶着羊群上山。\t他很无聊。')
})

test('parseModelJsonLenient: 带前后废话的输出截取首个对象', () => {
  const result = parseModelJsonLenient('好的，以下是 JSON：\n{"a":1}\n请查收')
  assert.equal(result.a, 1)
})

test('parseModelJsonLenient: 已转义序列不被二次转义', () => {
  const result = parseModelJsonLenient('{"text":"第一行\\n第二行"}')
  assert.equal(result.text, '第一行\n第二行')
})

test('parseModelJsonLenient: 空输出与纯垃圾仍显式失败', () => {
  assert.throws(() => parseModelJsonLenient(''), /empty_ai_output/)
  assert.throws(() => parseModelJsonLenient('完全没有 JSON'), SyntaxError)
})
