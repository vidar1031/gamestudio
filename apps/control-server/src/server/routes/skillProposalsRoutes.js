// Routes for the skill / intent proposal pipeline.
//
// All routes are additive and DO NOT touch the existing runtime
// lifecycle controls (start / stop / pause / resume), per
// .github/instructions/control-system.instructions.md.
//
// AUTO-F02：proposal 晋级全面治理化——测试门禁 → 人工审核 → 人工激活 →
// 版本记录/回滚，全部经 proposalGovernance 受控函数；写类端点必须携带
// 人类 actor，model/cron 等自动路径身份一律拒绝并审计。

import {
  listActiveIntentFiles,
  listProposals,
  scanProposals,
} from '../intents/proposals.js'
import { listIntents } from '../intents/registry.js'
import {
  activateProposal,
  deactivateGovernedIntent,
  getProposalGovernanceRecord,
  listProposalGovernance,
  reviewProposal,
  rollbackActiveIntent,
  runProposalTests,
} from '../intents/proposalGovernance.js'

function buildActiveIntentSummary() {
  return listIntents().map((intent) => ({
    id: intent.id,
    source: intent.source || 'unknown',
    description: intent.description || '',
    hasMatchPlan: typeof intent.matchPlan === 'function',
    hasMatchAnswer: typeof intent.matchAnswer === 'function',
    hasMatchEvaluation: typeof intent.matchEvaluation === 'function',
  }))
}

async function readBody(c) {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}

function governedErrorStatus(error) {
  if (error === 'actor_not_human') return 403
  if (error === 'proposal_not_found' || error === 'intent_not_found' || error === 'governance_record_not_found') return 404
  return 409
}

function respondGoverned(c, result) {
  if (result.ok) return c.json({ ok: true, ...result })
  return c.json({ ok: false, error: result.error, detail: result.detail }, governedErrorStatus(result.error))
}

export function registerSkillProposalsRoutes(app) {
  app.get('/api/control/intents', (c) => {
    return c.json({
      ok: true,
      activeIntents: buildActiveIntentSummary(),
      activeIntentFiles: listActiveIntentFiles(),
    })
  })

  app.get('/api/control/skill-proposals', (c) => {
    const proposals = listProposals()
    return c.json({
      ok: true,
      proposals,
      activeIntents: buildActiveIntentSummary(),
      activeIntentFiles: listActiveIntentFiles(),
      governance: listProposalGovernance(),
    })
  })

  app.get('/api/control/skill-proposals/:id/governance', (c) => {
    const record = getProposalGovernanceRecord(c.req.param('id'))
    if (!record) return c.json({ ok: false, error: 'governance_record_not_found' }, 404)
    return c.json({ ok: true, record })
  })

  app.post('/api/control/skill-proposals/scan', async (c) => {
    const body = await readBody(c)
    const minOccurrence = Math.max(1, Number(body?.minOccurrence || 2))
    try {
      const result = scanProposals({ minOccurrence })
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // 测试门禁：对 _inbox 候选执行确定性测试，证据落治理记录
  app.post('/api/control/skill-proposals/:id/test', async (c) => {
    const body = await readBody(c)
    const result = runProposalTests(c.req.param('id'), { actor: body?.actor })
    return respondGoverned(c, result)
  })

  // 人工审核：approve 要求已通过测试门禁；reject 保留快照与历史
  app.post('/api/control/skill-proposals/:id/review', async (c) => {
    const body = await readBody(c)
    const result = reviewProposal(c.req.param('id'), {
      actor: body?.actor,
      decision: body?.decision,
      note: body?.note,
    })
    return respondGoverned(c, result)
  })

  // 人工激活：仅 approved 可激活；产生版本记录，失败自动回滚
  app.post('/api/control/skill-proposals/:id/promote', async (c) => {
    const body = await readBody(c)
    const result = activateProposal(c.req.param('id'), { actor: body?.actor })
    return respondGoverned(c, result)
  })

  // 人工驳回（保留快照与历史记录）
  app.post('/api/control/skill-proposals/:id/reject', async (c) => {
    const body = await readBody(c)
    const result = reviewProposal(c.req.param('id'), {
      actor: body?.actor,
      decision: 'reject',
      note: body?.note,
    })
    return respondGoverned(c, result)
  })

  // 人工回滚：active 回退到上一已知版本（无上一版本则完全下线），版本记录保留
  app.post('/api/control/skill-intents/:id/rollback', async (c) => {
    const body = await readBody(c)
    const result = rollbackActiveIntent(c.req.param('id'), {
      actor: body?.actor,
      reason: body?.reason,
    })
    return respondGoverned(c, result)
  })

  // 受控下线：移除 active 文件并注销，版本记录保留可追溯
  app.post('/api/control/skill-intents/:id/deactivate', async (c) => {
    const body = await readBody(c)
    const result = deactivateGovernedIntent(c.req.param('id'), {
      actor: body?.actor,
      reason: body?.reason,
    })
    return respondGoverned(c, result)
  })
}
