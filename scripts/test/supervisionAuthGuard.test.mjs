import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAuthFailureError,
  stopSupervisionTimer,
  getSupervisionTimerState
} from '../../apps/control-server/src/server/controlServerCore.js'

test('isAuthFailureError 识别 401 错误', () => {
  assert.equal(isAuthFailureError(new Error('model_task_http_401_Unauthorized')), true)
  assert.equal(isAuthFailureError(new Error('HTTP 401 Unauthorized')), true)
  assert.equal(isAuthFailureError(new Error('认证失败')), true)
  assert.equal(isAuthFailureError('401'), true)
})

test('isAuthFailureError 不将普通网络错误误判为认证错误', () => {
  assert.equal(isAuthFailureError(new Error('model_task_http_503')), false)
  assert.equal(isAuthFailureError(new Error('ECONNREFUSED')), false)
  assert.equal(isAuthFailureError(new Error('timeout')), false)
})

test('stopSupervisionTimer 记录认证阻断状态', () => {
  stopSupervisionTimer('auth_failure_post_startup')
  const state = getSupervisionTimerState()
  assert.equal(state.hasPostStartupTimeout, false)
  assert.equal(state.hasPeriodicTimer, false)
  assert.ok(state.authFailure)
  assert.equal(state.authFailure.reason, 'auth_failure_post_startup')
  assert.ok(state.authFailure.stoppedAt)
  assert.ok(state.authFailure.recoveryHint)
})
