import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REASONING_SESSION_STATE,
  isTerminalSessionState,
  isLegalSessionTransition,
  validateSessionTransition,
  applySessionTransition,
  normalizeLegacySessionStatus
} from '../../apps/control-server/src/server/reasoning/sessionStateMachine.js'

test('状态枚举包含所有要求状态', () => {
  const required = [
    'queued', 'running', 'waiting_review', 'pausing', 'paused', 'resuming',
    'retry_wait', 'completed', 'failed', 'blocked', 'cancelled', 'orphaned', 'timeout'
  ]
  for (const state of required) {
    assert.ok(Object.values(REASONING_SESSION_STATE).includes(state), `missing state: ${state}`)
  }
})

test('终态判断正确', () => {
  assert.equal(isTerminalSessionState('completed'), true)
  assert.equal(isTerminalSessionState('blocked'), true)
  assert.equal(isTerminalSessionState('cancelled'), true)
  assert.equal(isTerminalSessionState('timeout'), true)
  // failed 允许重试/恢复，不是终态
  assert.equal(isTerminalSessionState('failed'), false)
  assert.equal(isTerminalSessionState('running'), false)
  assert.equal(isTerminalSessionState('paused'), false)
})

test('合法转移: queued -> running', () => {
  assert.equal(isLegalSessionTransition('queued', 'running'), true)
})

test('合法转移: running -> waiting_review', () => {
  assert.equal(isLegalSessionTransition('running', 'waiting_review'), true)
})

test('合法转移: waiting_review -> running', () => {
  assert.equal(isLegalSessionTransition('waiting_review', 'running'), true)
})

test('合法转移: running -> completed', () => {
  assert.equal(isLegalSessionTransition('running', 'completed'), true)
})

test('非法转移: completed -> running', () => {
  assert.equal(isLegalSessionTransition('completed', 'running'), false)
})

test('非法转移: cancelled -> running', () => {
  assert.equal(isLegalSessionTransition('cancelled', 'running'), false)
})

test('validateSessionTransition: 非法转移返回错误', () => {
  const result = validateSessionTransition('completed', 'running')
  assert.equal(result.ok, false)
  assert.match(result.error, /terminal_state_cannot_transition/)
})

test('validateSessionTransition: 未知状态返回错误', () => {
  const result = validateSessionTransition('running', 'unknown_state')
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown_target_state/)
})

test('applySessionTransition: 合法转移写入状态与事件', () => {
  const session = { status: 'queued', stateTransitions: [] }
  const next = applySessionTransition(session, 'running', 'task started')
  assert.equal(next.status, 'running')
  assert.equal(next.stateTransitions.length, 1)
  assert.equal(next.stateTransitions[0].from, 'queued')
  assert.equal(next.stateTransitions[0].to, 'running')
  assert.equal(next.stateTransitions[0].reason, 'task started')
})

test('applySessionTransition: 非法转移抛出异常', () => {
  const session = { status: 'completed', stateTransitions: [] }
  assert.throws(() => applySessionTransition(session, 'running'), /session_state_transition_rejected/)
})

test('normalizeLegacySessionStatus: 映射旧状态', () => {
  assert.equal(normalizeLegacySessionStatus('pending'), 'queued')
  assert.equal(normalizeLegacySessionStatus('pending-review'), 'waiting_review')
  assert.equal(normalizeLegacySessionStatus('error'), 'failed')
  assert.equal(normalizeLegacySessionStatus('running'), 'running')
  assert.equal(normalizeLegacySessionStatus(''), 'queued')
  assert.equal(normalizeLegacySessionStatus('unknown'), 'blocked')
})
