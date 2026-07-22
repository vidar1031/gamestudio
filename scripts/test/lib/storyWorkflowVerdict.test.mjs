import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectStoryWorkflowFailure, hasStoryWorkflowSteps } from './storyWorkflowVerdict.mjs'

test('evaluator 失败但 step.ok=true 也必须记为失败(L4-04 false-pass 回归)', () => {
  const session = {
    artifacts: {
      storyProduction: {
        steps: {
          step_story_compile_compose: {
            action: 'story_compile_compose',
            ok: true,
            evaluator: { passed: false, issues: ['compose evaluator failed'] }
          }
        }
      }
    }
  }
  const result = inspectStoryWorkflowFailure(session)
  assert.equal(result.hasFailure, true)
  assert.match(result.detail, /story_compile_compose:evaluator_failed/)
})

test('全部步骤 ok 且 evaluator passed 时无失败', () => {
  const session = {
    artifacts: {
      storyProduction: {
        steps: {
          a: { action: 'story_compile_compose', ok: true, evaluator: { passed: true } },
          b: { action: 'story_validate_project', ok: true }
        }
      }
    }
  }
  const result = inspectStoryWorkflowFailure(session)
  assert.equal(result.hasFailure, false)
  assert.equal(result.stepCount, 2)
})

test('step.ok=false 仍然记为失败(原行为不回归)', () => {
  const session = {
    artifacts: {
      storyProduction: {
        steps: {
          a: { action: 'story_export_project', ok: false, failedStage: 'export_api' }
        }
      }
    }
  }
  const result = inspectStoryWorkflowFailure(session)
  assert.equal(result.hasFailure, true)
  assert.match(result.detail, /story_export_project:export_api/)
})

test('无 storyProduction artifacts 时无失败且 hasStoryWorkflowSteps=false', () => {
  assert.equal(inspectStoryWorkflowFailure({}).hasFailure, false)
  assert.equal(hasStoryWorkflowSteps({}), false)
  assert.equal(hasStoryWorkflowSteps({ artifacts: { storyProduction: { steps: { a: { ok: true } } } } }), true)
})
