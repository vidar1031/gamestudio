import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  writeStepCheckpoint,
  readLatestStepCheckpoint,
  listStepCheckpoints,
  clearStepCheckpoints,
  applyCheckpointToSession
} from '../../apps/control-server/src/server/reasoning/stepCheckpoint.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CHECKPOINT_DIR = path.resolve(__dirname, '..', '..', 'state', 'reasoning-checkpoints')

function cleanCheckpointDir() {
  try {
    const files = fs.readdirSync(CHECKPOINT_DIR).filter((f) => f.startsWith('test_session_'))
    for (const f of files) {
      fs.unlinkSync(path.join(CHECKPOINT_DIR, f))
    }
  } catch {}
}

function makeSession(sessionId, overrides = {}) {
  return {
    sessionId,
    submissionContext: { projectId: 'proj_1' },
    artifacts: { recoverableFailureCount: 0, checkpointRecoveryCount: 0 },
    ...overrides
  }
}

function makeStep(stepId, stepIndex = 0) {
  return {
    stepId,
    action: 'read_file',
    tool: 'fs.read',
    title: `step ${stepIndex}`,
    params: { filePath: 'test.txt' }
  }
}

test('setup', () => {
  cleanCheckpointDir()
})

test('writeStepCheckpoint: 写入 checkpoint 并包含必需字段', () => {
  const sessionId = 'test_session_write'
  const session = makeSession(sessionId)
  const step = makeStep('step_0', 0)
  const result = { ok: true, status: 'completed', summary: 'read ok' }
  const checkpoint = writeStepCheckpoint(session, step, 0, result)

  assert.equal(checkpoint.sessionId, sessionId)
  assert.equal(checkpoint.stepIndex, 0)
  assert.equal(checkpoint.nextStepIndex, 1)
  assert.equal(checkpoint.inputSummary.action, 'read_file')
  assert.equal(checkpoint.resultSummary.ok, true)
  assert.ok(checkpoint.completedAt)
  assert.ok(fs.existsSync(path.join(CHECKPOINT_DIR, `${sessionId}_step_0.json`)))
})

test('readLatestStepCheckpoint: 读取最新 checkpoint', () => {
  const sessionId = 'test_session_latest'
  const session = makeSession(sessionId)
  writeStepCheckpoint(session, makeStep('step_0', 0), 0)
  writeStepCheckpoint(session, makeStep('step_1', 1), 1)
  writeStepCheckpoint(session, makeStep('step_2', 2), 2)

  const latest = readLatestStepCheckpoint(sessionId)
  assert.equal(latest.stepIndex, 2)
  assert.equal(latest.nextStepIndex, 3)
})

test('listStepCheckpoints: 按 stepIndex 排序', () => {
  const sessionId = 'test_session_list'
  const session = makeSession(sessionId)
  writeStepCheckpoint(session, makeStep('step_1', 1), 1)
  writeStepCheckpoint(session, makeStep('step_0', 0), 0)
  writeStepCheckpoint(session, makeStep('step_2', 2), 2)

  const list = listStepCheckpoints(sessionId)
  assert.equal(list.length, 3)
  assert.deepStrictEqual(list.map((item) => item.stepIndex), [0, 1, 2])
})

test('applyCheckpointToSession: 从 failed 状态恢复为 running', () => {
  const session = makeSession('test_session_apply', {
    status: 'failed',
    artifacts: { existingKey: 'value' }
  })
  const checkpoint = {
    stepIndex: 2,
    nextStepIndex: 3,
    artifacts: { projectRoot: '/tmp', latestStepReviewEvidence: { ok: true } }
  }
  const recovered = applyCheckpointToSession(session, checkpoint)
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.artifacts.nextStepIndex, 3)
  assert.equal(recovered.artifacts.projectRoot, '/tmp')
  assert.equal(recovered.artifacts.existingKey, 'value')
  assert.equal(recovered.artifacts.checkpointRecoveryCount, 1)
})

test('clearStepCheckpoints: 清理指定 session 的 checkpoint', () => {
  const sessionId = 'test_session_clear'
  const session = makeSession(sessionId)
  writeStepCheckpoint(session, makeStep('step_0', 0), 0)
  writeStepCheckpoint(session, makeStep('step_1', 1), 1)

  assert.equal(listStepCheckpoints(sessionId).length, 2)
  const removed = clearStepCheckpoints(sessionId)
  assert.equal(removed, 2)
  assert.equal(listStepCheckpoints(sessionId).length, 0)
})

test('teardown', () => {
  cleanCheckpointDir()
})
