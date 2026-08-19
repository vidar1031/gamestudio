// 学习循环 + 技能治理桥的路由：hermes agent 自创技能的候选扫描、内容审阅、
// 人工审核（approve/reject）与当前注入清单查看。
//
// 与 skillProposalsRoutes 同一治理纪律：写类端点必须携带人类 actor，
// model/cron/agent 等自动路径身份一律 403 并写治理审计；学习产物绝不自动生效。

import {
  scanHermesSkills,
  getSkillCandidateContent,
  reviewLearnedSkill,
  listActiveSkills
} from '../intents/skillGovernance.js'

async function readBody(c) {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}

function governedErrorStatus(error) {
  if (error === 'actor_not_human') return 403
  if (error === 'skill_not_found') return 404
  return 409
}

function respondGoverned(c, result) {
  if (result.ok) return c.json({ ok: true, ...result })
  return c.json({ ok: false, error: result.error, detail: result.detail }, governedErrorStatus(result.error))
}

export function registerSkillGovernanceRoutes(app) {
  // 候选扫描：bundled pristine 不进候选；agent 自创 / 被 patch 的捆绑技能进候选；
  // 已决项（approved/rejected）不重复进候选
  app.get('/api/control/skills/candidates', (c) => {
    try {
      const scan = scanHermesSkills()
      return c.json({ ok: true, ...scan })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // 技能内容（SKILL.md 全文 + 文件清单），供人工审阅
  app.get('/api/control/skills/candidates/:name/content', (c) => {
    const result = getSkillCandidateContent(c.req.param('name'))
    if (!result.ok) return c.json({ ok: false, error: result.error, detail: result.detail }, result.error === 'skill_not_found' ? 404 : 500)
    return c.json(result)
  })

  // 人工审核：approve 复制到可信根并登记注入清单；reject 留档不生效
  app.post('/api/control/skills/candidates/:name/review', async (c) => {
    const body = await readBody(c)
    const result = reviewLearnedSkill(c.req.param('name'), {
      actor: body?.actor,
      decision: body?.decision,
      note: body?.note
    })
    return respondGoverned(c, result)
  })

  // 当前注入清单（与 buildHermesBinding 同一真相源）+ 已激活技能治理记录
  app.get('/api/control/skills/active', (c) => {
    return c.json(listActiveSkills())
  })
}
