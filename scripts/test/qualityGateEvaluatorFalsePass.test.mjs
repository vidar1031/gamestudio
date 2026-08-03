import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SESSIONS_DIR = path.join(REPO_ROOT, 'state', 'agent-runtime-sessions')

async function importQualityGate() {
  const qualityGate = await import(path.join(REPO_ROOT, 'apps/control-server/src/server/reasoning/qualityGate.js'))
  return qualityGate
}

async function importControlServerCore() {
  const core = await import(path.join(REPO_ROOT, 'apps/control-server/src/server/controlServerCore.js'))
  return core
}

function createTestSession(sessionId, options = {}) {
  const now = new Date().toISOString()
  return {
    sessionId,
    runtimeSessionId: sessionId,
    sessionKind: 'agent-runtime',
    agentId: 'hermes-manager',
    userPrompt: 'test-evaluator-false-pass',
    title: 'test-evaluator-false-pass',
    submissionContext: {
      productionTest: Boolean(options.productionTest),
      disableQualityAutoRetry: Boolean(options.disableQualityAutoRetry)
    },
    parentSessionId: null,
    childSessionIds: [],
    status: 'running',
    createdAt: now,
    updatedAt: now,
    runtimeTaskGraph: { planId: `plan_${sessionId}`, goal: 'test', strategy: 'sequential', steps: [] },
    plan: { planId: `plan_${sessionId}`, goal: 'test', strategy: 'sequential', steps: [] },
    currentStepId: null,
    review: null,
    events: [],
    artifacts: {
      finalAnswer: 'test final answer',
      finalAnswerPersisted: false,
      storyProduction: options.storyProduction || null
    }
  }
}

function writeSessionFile(sessionId, session) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  fs.writeFileSync(path.join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(session, null, 2), 'utf8')
}

function deleteSessionFile(sessionId) {
  try {
    fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`))
  } catch {}
}

test('disableQualityAutoRetry=true 且 story workflow evaluator 失败时 session 应记为 failed', async () => {
  const { finalizeReasoningSessionWithQualityGate } = await importQualityGate()
  const { readReasoningSession } = await importControlServerCore()
  const sessionId = `test_eval_false_pass_${Date.now()}`
  try {
    writeSessionFile(sessionId, createTestSession(sessionId, {
      disableQualityAutoRetry: true,
      productionTest: true,
      storyProduction: {
        steps: {
          step_story_compile_compose: {
            action: 'story_compile_compose',
            ok: true,
            evaluator: { passed: false, issues: ['compose evaluator failed'] },
            failedStage: null
          }
        }
      }
    }))
    await finalizeReasoningSessionWithQualityGate(sessionId, {}, [])
    const session = readReasoningSession(sessionId)
    assert.equal(session.status, 'failed', `期望 session 状态为 failed，实际为 ${session.status}`)
    assert.match(String(session.error || ''), /story_workflow_evaluator_failed/)
    const blockedEvent = session.events?.find((event) => event.type === 'quality_gate_blocked')
    assert.ok(blockedEvent, '应记录 quality_gate_blocked 事件')
  } finally {
    deleteSessionFile(sessionId)
  }
})

test('disableQualityAutoRetry=true 且无 story workflow 失败时 session 应正常 completed', async () => {
  const { finalizeReasoningSessionWithQualityGate } = await importQualityGate()
  const { readReasoningSession } = await importControlServerCore()
  const sessionId = `test_eval_pass_${Date.now()}`
  try {
    writeSessionFile(sessionId, createTestSession(sessionId, {
      disableQualityAutoRetry: true,
      productionTest: true,
      storyProduction: {
        steps: {
          step_story_compile_compose: {
            action: 'story_compile_compose',
            ok: true,
            evaluator: { passed: true },
            failedStage: null
          }
        }
      }
    }))
    await finalizeReasoningSessionWithQualityGate(sessionId, {}, [])
    const session = readReasoningSession(sessionId)
    assert.equal(session.status, 'completed', `期望 session 状态为 completed，实际为 ${session.status}`)
  } finally {
    deleteSessionFile(sessionId)
  }
})
