import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveModelRouteForPhase,
  getModelRouteOverrideForPhase,
  buildConfigValidation
} from '../../apps/control-server/src/server/controlServerCore.js'
import { requestHermesChatCompletion } from '../../apps/control-server/src/server/model/modelTaskQueue.js'
import {
  REASONING_RETRY_CATEGORY,
  classifyReasoningFailure
} from '../../apps/control-server/src/server/reasoning/retryPolicy.js'

// strict 路由静默降级治理测试：
// - hermes+strict 路由与左脑绑定不一致 → 显式不可用（route_unavailable），不再静默降级 direct；
// - hermes+strict 路由与绑定一致 → 正常走 hermes；
// - 非 strict 路由不一致 → 保持 best-effort 直连，但 degradedFrom 留痕（非静默）；
// - strictRouteRequiredPhases 运行期补 strict 的场景同样显式不可用；
// - 运行期 choke point（requestHermesChatCompletion）显式抛错，C02 分类收敛 blocked；
// - 自检面（buildConfigValidation）把 strict 不可满足暴露为 error 项。

function buildTestBinding({ model = 'Model-A', phaseRoutes = {}, actionRoutes = {}, strictRouteRequiredPhases = [] } = {}) {
  return {
    provider: 'omlx',
    baseUrl: 'http://127.0.0.1:18888/v1',
    model,
    rightBrainEnabled: false,
    workflow: {
      memoryOverlayMode: 'content-injection',
      modelRouting: {
        defaultRoute: { provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model, transport: 'hermes', strict: false },
        phaseRoutes,
        actionRoutes,
        strictRouteRequiredPhases
      }
    }
  }
}

test('strict hermes 路由与绑定模型不一致：显式不可用，绝不静默降级 direct', () => {
  const binding = buildTestBinding({
    phaseRoutes: {
      story_blueprint_review: { provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: 'Model-B', transport: 'hermes', strict: true }
    }
  })
  const resolved = resolveModelRouteForPhase(binding, 'story_blueprint_review')
  assert.equal(resolved.strict, true)
  assert.equal(resolved.transport, 'hermes', 'strict 路由不得被静默改写成 direct')
  assert.equal(resolved.unavailableReason, 'route_unavailable:strict_route_model_mismatch:Model-B')
  // override 同样携带不可用原因（server 侧消费方可见）
  const override = getModelRouteOverrideForPhase(binding, 'story_blueprint_review')
  assert.equal(override.unavailableReason, 'route_unavailable:strict_route_model_mismatch:Model-B')
})

test('strict hermes 路由与绑定一致：可满足，正常走 hermes 通道', () => {
  const binding = buildTestBinding({
    phaseRoutes: {
      story_blueprint_review: { provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: 'Model-A', transport: 'hermes', strict: true }
    }
  })
  const resolved = resolveModelRouteForPhase(binding, 'story_blueprint_review')
  assert.equal(resolved.strict, true)
  assert.equal(resolved.transport, 'hermes')
  assert.equal(resolved.unavailableReason, '')
})

test('非 strict 路由不一致：保持 best-effort 直连，但 degradedFrom 留痕（不再静默）', () => {
  const binding = buildTestBinding({
    phaseRoutes: {
      reasoning_answer: { provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: 'Model-B', transport: 'hermes', strict: false }
    }
  })
  const resolved = resolveModelRouteForPhase(binding, 'reasoning_answer')
  assert.equal(resolved.strict, false)
  assert.equal(resolved.transport, 'direct')
  assert.equal(resolved.degradedFrom, 'hermes')
  assert.equal(resolved.requestedTransport, 'hermes')
  assert.equal(resolved.unavailableReason, '')
})

test('strictRouteRequiredPhases 运行期补 strict：已降级 direct 的 hermes 路由必须转显式不可用', () => {
  const binding = buildTestBinding({
    phaseRoutes: {
      story_blueprint_review: { provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: 'Model-B', transport: 'hermes', strict: false }
    },
    strictRouteRequiredPhases: ['story_blueprint_review']
  })
  const resolved = resolveModelRouteForPhase(binding, 'story_blueprint_review')
  assert.equal(resolved.strict, true, '阶段强制 strict 生效')
  assert.equal(resolved.transport, 'hermes', '不得继续静默 direct')
  assert.equal(resolved.unavailableReason, 'route_unavailable:strict_route_model_mismatch:Model-B')
})

test('direct 声明的 strict 路由：无 hermes 可满足性问题，不受影响', () => {
  const binding = buildTestBinding({
    phaseRoutes: {
      story_blueprint_review: { provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: 'Model-B', transport: 'direct', strict: true }
    }
  })
  const resolved = resolveModelRouteForPhase(binding, 'story_blueprint_review')
  assert.equal(resolved.transport, 'direct')
  assert.equal(resolved.unavailableReason, '')
})

test('运行期 choke point：带 unavailableReason 的路由请求显式抛 route_unavailable，不发起网络调用', async () => {
  await assert.rejects(
    () => requestHermesChatCompletion({
      sessionId: 'strict-route-test',
      phase: 'story_blueprint_review',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 1,
      route: { transport: 'hermes', model: 'Model-B', unavailableReason: 'route_unavailable:strict_route_model_mismatch:Model-B' }
    }),
    /route_unavailable:strict_route_model_mismatch:Model-B/
  )
})

test('C02 错误分类：route_unavailable 收敛 blocked（配置级问题，不自动重试）', () => {
  const classified = classifyReasoningFailure({ error: 'route_unavailable:strict_route_model_mismatch:Model-B' })
  assert.equal(classified.category, REASONING_RETRY_CATEGORY.BLOCKED)
  assert.equal(classified.rule, 'route_unavailable')
})

test('自检面：strict 路由不可满足暴露为 error 项，可满足为 ok 项', () => {
  const baseConfig = {
    provider: 'omlx',
    baseUrl: 'http://127.0.0.1:18888/v1',
    model: 'Model-A',
    shortTerm: { minContextTokens: 0 },
    workflow: {
      modelRouting: {
        phaseRoutes: {},
        actionRoutes: {}
      }
    },
    memory: {
      agentDefinitionFile: '',
      userFile: '',
      memoryFile: '',
      longTasksFile: '',
      statusFile: '',
      taskQueueFile: '',
      decisionsFile: '',
      dailyLogDir: ''
    },
    skills: { skillRoot: '', skillFiles: [] }
  }
  const unavailableConfig = {
    ...baseConfig,
    workflow: {
      modelRouting: {
        phaseRoutes: {
          story_blueprint_review: {
            provider: 'omlx',
            baseUrl: 'http://127.0.0.1:18888/v1',
            model: 'Model-B',
            transport: 'hermes',
            requestedTransport: 'hermes',
            strict: true,
            unavailableReason: 'route_unavailable:strict_route_model_mismatch:Model-B',
            degradedFrom: ''
          }
        },
        actionRoutes: {}
      }
    }
  }
  const unavailableValidation = buildConfigValidation(unavailableConfig, { contextLength: 0 })
  const errorItem = unavailableValidation.items.find((item) => item.key === 'strict-route-phase:story_blueprint_review')
  assert.ok(errorItem, '自检项必须存在')
  assert.equal(errorItem.status, 'error')
  assert.match(errorItem.detail, /route_unavailable/)
  assert.equal(unavailableValidation.ready, false, 'strict 不可满足必须反映到整体 ready')

  const satisfiableConfig = {
    ...baseConfig,
    workflow: {
      modelRouting: {
        phaseRoutes: {
          story_blueprint_review: {
            provider: 'omlx',
            baseUrl: 'http://127.0.0.1:18888/v1',
            model: 'Model-A',
            transport: 'hermes',
            requestedTransport: 'hermes',
            strict: true,
            unavailableReason: '',
            degradedFrom: ''
          }
        },
        actionRoutes: {}
      }
    }
  }
  const satisfiableValidation = buildConfigValidation(satisfiableConfig, { contextLength: 0 })
  const okItem = satisfiableValidation.items.find((item) => item.key === 'strict-route-phase:story_blueprint_review')
  assert.ok(okItem, '自检项必须存在')
  assert.equal(okItem.status, 'ok')
})
