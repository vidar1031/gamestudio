// Routes for the skill / intent proposal pipeline.
//
// All routes are additive and DO NOT touch the existing runtime
// lifecycle controls (start / stop / pause / resume), per
// .github/instructions/control-system.instructions.md.

import {
  deactivateActiveIntent,
  listActiveIntentFiles,
  listProposals,
  promoteProposal,
  rejectProposal,
  scanProposals,
} from '../intents/proposals.js'
import { listIntents } from '../intents/registry.js'

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
    })
  })

  app.post('/api/control/skill-proposals/scan', async (c) => {
    let body = {}
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const minOccurrence = Math.max(1, Number(body?.minOccurrence || 2))
    try {
      const result = scanProposals({ minOccurrence })
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.post('/api/control/skill-proposals/:id/promote', (c) => {
    const id = c.req.param('id')
    try {
      const result = promoteProposal(id)
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  app.post('/api/control/skill-proposals/:id/reject', (c) => {
    const id = c.req.param('id')
    try {
      const result = rejectProposal(id)
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  app.post('/api/control/skill-intents/:id/deactivate', (c) => {
    const id = c.req.param('id')
    try {
      const result = deactivateActiveIntent(id)
      return c.json({ ok: true, ...result })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
}
