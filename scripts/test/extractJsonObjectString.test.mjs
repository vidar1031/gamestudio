// extractJsonObjectString：从模型输出截取第一个完整 JSON 对象
// 回归现场（2026-09-05 场景3会话 reasoning_1788602495627）：
// 模型把 plan JSON 重复输出两遍并泄漏 </anttThinking> 残渣，
// 旧的"首{到尾}"贪婪切片把两个对象拼成非法 JSON，规划被静默替换为兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractJsonObjectString } from '../../apps/control-server/src/server/reasoning/promptBuilders.js'

test('重复输出多份 JSON 时截取第一个完整对象', () => {
  const raw = '{"goal":"g1","steps":[{"a":1}]}' + '\n</anttThinking>\n\n' + '{"goal":"g2","steps":[]}'
  const out = extractJsonObjectString(raw)
  assert.deepEqual(JSON.parse(out), { goal: 'g1', steps: [{ a: 1 }] })
})

test('字符串内的花括号与转义引号不参与配平', () => {
  const raw = '前言 {"note":"他说 \\"a{b}\\""} 尾巴'
  const out = extractJsonObjectString(raw)
  assert.deepEqual(JSON.parse(out), { note: '他说 "a{b}"' })
})

test('围栏代码块内取首个对象，忽略块后复读内容', () => {
  const out = extractJsonObjectString('```json\n{"ok":true}\n```\n复读 {"ok":false}')
  assert.deepEqual(JSON.parse(out), { ok: true })
})

test('单个对象带尾部废话行为不变', () => {
  const out = extractJsonObjectString('好的：{"a":1} 请查收')
  assert.deepEqual(JSON.parse(out), { a: 1 })
})

test('纯文本与空输入原样返回（由调用方兜底）', () => {
  assert.equal(extractJsonObjectString(''), '')
  assert.equal(extractJsonObjectString('完全没有 JSON'), '完全没有 JSON')
})
