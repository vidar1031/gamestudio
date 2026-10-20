// 脚本草稿结构公式拟合/阻断问题汇总（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改）
import { genId, generateScriptDraft, repairScriptDraft } from './scripts.js'
import { compileBlueprintFromScripts, normalizeScriptCardsForBlueprint } from '../blueprint/compile.js'
import { validateBlueprintDoc } from '../blueprint/validate.js'
import { nowIso } from '../studio/storeFs.js'

export function buildScriptsFromDraftCards(cardsIn, prevScripts, formula) {
  const sourceCards = Array.isArray(cardsIn) ? cardsIn : []
  const prevCards = prevScripts && typeof prevScripts === 'object' && Array.isArray(prevScripts.cards) ? prevScripts.cards : []
  const preserveIds = prevCards.length > 0 && prevCards.length === sourceCards.length

  const cards = sourceCards
    .map((x, i) => {
      const base = preserveIds ? prevCards[i] : null
      const idUse = base && base.id ? String(base.id) : genId('sc')
      const orderUse = base && base.order != null ? Number(base.order) : i + 1
      return {
        id: idUse,
        name: String(x && x.name ? x.name : `场景${i + 1}`),
        order: Number.isFinite(orderUse) && orderUse > 0 ? orderUse : i + 1,
        text: String(x && x.text ? x.text : ''),
        updatedAt: nowIso()
      }
    })
    .filter((c) => c.text.trim())

  if (!cards.length) return null

  const scripts = { schemaVersion: '1.0', cards, updatedAt: nowIso() }
  scripts.cards = normalizeScriptCardsForBlueprint(scripts.cards, formula)
  // 2026-10-05 公式硬约束：AI 即兴多写选项时，确定性裁剪到公式值（裁选项句/后果卡/结局卡并重编号），
  // 不再依赖 LLM 修复的自由改写（后者曾幻觉出多余选择点与结局，P1-20 编辑器同款）。
  scripts.cards = fitScriptCardsToFormula(scripts.cards, formula)
  return scripts
}

export function fitScriptCardsToFormula(cards, formula) {
  const cp = Math.max(0, Number(formula?.choicePoints) || 0)
  const opt = Math.max(0, Number(formula?.optionsPerChoice) || 0)
  const end = Math.max(0, Number(formula?.endings) || 0)
  if (!cp && !opt && !end) return cards
  const list = cards.map((c) => ({ ...c }))

  // ①+② 选择点发现（按出现顺序编号）与裁剪
  const choiceCards = list.filter((c) => (String(c.text || '').match(/选项\s*\d{1,2}\s*[:：]/g) || []).length >= 2)
  choiceCards.forEach((c, i) => { c.__choiceNo = i + 1 })
  const dropChoiceNos = new Set()
  if (cp > 0 && choiceCards.length > cp) {
    choiceCards.slice(cp).forEach((c) => { c.__drop = true; dropChoiceNos.add(c.__choiceNo) })
  }
  for (const c of choiceCards) {
    if (c.__drop) continue
    const marks = [...String(c.text || '').matchAll(/选项\s*(\d{1,2})\s*[:：]/g)]
    if (opt > 0 && marks.length > opt) {
      const keepOld = marks.slice(0, opt).map((m) => Number(m[1]))
      const dropOld = new Set(marks.map((m) => Number(m[1])).filter((k) => !keepOld.includes(k)))
      const firstIdx = String(c.text).search(/选项\s*\d{1,2}\s*[:：]/)
      const head = firstIdx > 0 ? String(c.text).slice(0, firstIdx).trim() : ''
      const parts = String(c.text).slice(Math.max(0, firstIdx)).split(/(?=选项\s*\d{1,2}\s*[:：])/)
      const segByOld = {}
      for (const seg of parts) {
        const m = seg.match(/选项\s*(\d{1,2})\s*[:：]/)
        if (m) segByOld[Number(m[1])] = seg
      }
      const kept = []
      keepOld.forEach((oldK, i) => {
        const seg = String(segByOld[oldK] || '').replace(/选项\s*\d{1,2}\s*[:：]\s*/, `选项${i + 1}：`).trim()
        if (seg) kept.push(seg)
      })
      c.text = (head ? head + ' ' : '') + kept.join(' ')
      const renum = new Map(keepOld.map((k, i) => [k, i + 1]))
      c.__conseqRenum = { renum, dropOld, choiceNo: c.__choiceNo }
    }
  }
  for (const c of list) {
    const m = c.name.match(/^(\d{1,2})后果(\d{1,2})$/)
    if (!m) continue
    const choiceNo = Number(m[1])
    if (dropChoiceNos.has(choiceNo)) { c.__drop = true; continue }
    const owner = choiceCards.find((x) => x.__choiceNo === choiceNo)
    const fit = owner && owner.__conseqRenum
    if (fit && fit.choiceNo === choiceNo) {
      const k = Number(m[2])
      if (fit.dropOld.has(k)) c.__drop = true
      else c.name = `${choiceNo}后果${fit.renum.get(k)}`
    }
  }

  // ④结局裁剪+重编号
  if (end > 0) {
    const endings = list
      .filter((c) => /^结局\d{1,2}$/.test(c.name) && !c.__drop)
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    if (endings.length > end) endings.slice(end).forEach((c) => { c.__drop = true })
    let ei = 0
    for (const c of list) {
      if (/^结局\d{1,2}$/.test(c.name) && !c.__drop) { ei += 1; c.name = `结局${ei}` }
    }
  }

  // ③后果卡与结局卡之间夹着的普通卡删除（保铺垫段与后果卡前的铺垫）
  {
    const alive = list.filter((c) => !c.__drop)
    const firstConseqOrder = Math.min(...alive.filter((c) => /\d{1,2}后果\d{1,2}$/.test(c.name)).map((c) => Number(c.order) || 0).filter(Number.isFinite), Infinity)
    if (Number.isFinite(firstConseqOrder)) {
      for (const c of alive) {
        const o = Number(c.order) || 0
        if (o <= firstConseqOrder) continue
        const isConseq = /\d{1,2}后果\d{1,2}$/.test(c.name)
        const isEnding = /^结局\d{1,2}$/.test(c.name)
        const hasOptions = (String(c.text || '').match(/选项\s*\d{1,2}\s*[:：]/g) || []).length >= 2
        if (!isConseq && !isEnding && !hasOptions) c.__drop = true
      }
    }
  }

  // ⑤重名去重（非后果/结局的叙述卡同名时后缀序号）
  {
    const seen = new Map()
    for (const c of list) {
      if (c.__drop) continue
      if (/\d{1,2}后果\d{1,2}$/.test(c.name) || /^结局\d{1,2}$/.test(c.name)) continue
      const n = seen.get(c.name) || 0
      seen.set(c.name, n + 1)
      if (n > 0) c.name = `${c.name}${n + 1}`
    }
  }

  return list.filter((c) => !c.__drop).map((c) => {
    const { __drop, __choiceNo, __conseqRenum, ...rest } = c
    return rest
  })
}

export function collectBlockingScriptIssues(report, validation) {
  const out = []
  const blockingReportWarnings = new Set([
    'formula_choicePoints_mismatch',
    'formula_optionsPerChoice_mismatch',
    'formula_endings_too_few',
    'missing_consequence',
    'consequence_index_mismatch'
  ])
  const blockingValidationWarnings = new Set([
    'scene_no_choices',
    'ending_has_choices',
    'unreachable_nodes',
    'no_reachable_endings'
  ])

  for (const item of Array.isArray(report?.errors) ? report.errors : []) {
    if (!item || !item.message) continue
    out.push({ source: 'compile', severity: 'error', code: String(item.code || ''), message: String(item.message) })
  }
  for (const item of Array.isArray(report?.warnings) ? report.warnings : []) {
    const code = String(item?.code || '')
    if (!blockingReportWarnings.has(code) || !item?.message) continue
    out.push({ source: 'compile', severity: 'warning', code, message: String(item.message) })
  }
  for (const item of Array.isArray(validation?.errors) ? validation.errors : []) {
    if (!item || !item.message) continue
    out.push({ source: 'validate', severity: 'error', code: String(item.code || ''), message: String(item.message) })
  }
  for (const item of Array.isArray(validation?.warnings) ? validation.warnings : []) {
    const code = String(item?.code || '')
    if (!blockingValidationWarnings.has(code) || !item?.message) continue
    out.push({ source: 'validate', severity: 'warning', code, message: String(item.message) })
  }
  return out
}

export function summarizeScriptIssues(issues) {
  const items = Array.isArray(issues) ? issues : []
  if (!items.length) return ''
  return items.slice(0, 3).map((item) => String(item?.message || '').trim()).filter(Boolean).join('；')
}

export async function generateClosedScriptDraft({
  prompt,
  title,
  projectTitle,
  rules,
  formula,
  provider,
  model,
  apiUrl,
  proxyUrl,
  timeoutMs,
  prevScripts,
  prevBlueprint
}) {
  let generated = null
  let genMeta = null
  try {
    generated = await generateScriptDraft({
      prompt,
      title: title || undefined,
      rules,
      formula,
      provider,
      model,
      apiUrl,
      proxyUrl,
      timeoutMs
    })
    if (generated && typeof generated === 'object' && generated.meta) genMeta = generated.meta
    if (generated && typeof generated === 'object' && generated.draft) generated = generated.draft
  } catch (e) {
    const err = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null,
      cause: e && e.cause ? (e.cause.message ? String(e.cause.message) : String(e.cause)) : null
    }
    return {
      ok: false,
      repaired: false,
      status: Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502,
      message: err.message || 'ai_generate_failed',
      meta: { provider, model: model || null, api: apiUrl || null, error: err },
      scripts: null,
      blueprint: null,
      before: null,
      after: null
    }
  }

  const generatedTitle = generated && typeof generated.title === 'string' ? String(generated.title).trim() : ''
  if (!generated || typeof generated !== 'object' || !Array.isArray(generated.cards)) {
    const err = genMeta && genMeta.error ? genMeta.error : null
    return {
      ok: false,
      repaired: false,
      status: err && Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502,
      message: err && err.message ? String(err.message) : 'AI 未返回有效脚本卡片',
      title: generatedTitle,
      meta: genMeta || { provider, model: model || null, api: apiUrl || null, error: err },
      scripts: null,
      blueprint: null,
      before: null,
      after: null
    }
  }

  const initialScripts = buildScriptsFromDraftCards(generated.cards, prevScripts, formula)
  if (!initialScripts) {
    return {
      ok: false,
      repaired: false,
      status: 502,
      message: 'AI 返回了空脚本，未生成可用场景卡片',
      title: generatedTitle,
      meta: genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      scripts: null,
      blueprint: null,
      before: null,
      after: null
    }
  }

  const compiledBefore = compileBlueprintFromScripts({ scripts: initialScripts, prevBlueprint, expectedFormula: formula })
  const validationBefore = validateBlueprintDoc(compiledBefore.blueprint)
  const beforeIssues = collectBlockingScriptIssues(compiledBefore.report, validationBefore)
  const before = { report: compiledBefore.report, validation: validationBefore, issues: beforeIssues }

  if (!beforeIssues.length) {
    return {
      ok: true,
      repaired: false,
      title: generatedTitle,
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      meta: genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      before,
      after: before
    }
  }

  let fixed = null
  try {
    fixed = await repairScriptDraft({
      projectTitle: String(projectTitle || title || generatedTitle || '').trim(),
      scripts: initialScripts,
      rules,
      formula,
      report: compiledBefore.report,
      validation: validationBefore,
      provider,
      model,
      apiUrl,
      proxyUrl,
      timeoutMs
    })
  } catch (e) {
    const err = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null,
      cause: e && e.cause ? (e.cause.message ? String(e.cause.message) : String(e.cause)) : null
    }
    return {
      ok: false,
      repaired: true,
      status: Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502,
      message: `脚本初稿未通过校验，AI 修复失败：${err.message || 'unknown_error'}`,
      title: generatedTitle,
      meta: { ...(genMeta || { provider, model: model || null, api: apiUrl || null }), error: err },
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      before,
      after: null
    }
  }

  if (!fixed || typeof fixed !== 'object' || !fixed.draft || typeof fixed.draft !== 'object' || !Array.isArray(fixed.draft.cards)) {
    return {
      ok: false,
      repaired: true,
      status: 502,
      message: `脚本初稿未通过校验，且当前 Provider 没有返回可用修复结果：${summarizeScriptIssues(beforeIssues) || 'unknown_issue'}`,
      title: generatedTitle,
      meta: fixed && typeof fixed === 'object' && fixed.meta
        ? fixed.meta
        : (genMeta || { provider, model: model || null, api: apiUrl || null, error: null }),
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      before,
      after: null
    }
  }

  const repairedTitle = fixed.draft && typeof fixed.draft.title === 'string' ? String(fixed.draft.title).trim() : generatedTitle
  const repairedScripts = buildScriptsFromDraftCards(fixed.draft.cards, prevScripts || initialScripts, formula)
  if (!repairedScripts) {
    return {
      ok: false,
      repaired: true,
      status: 502,
      message: 'AI 修复返回了空脚本，无法生成可用场景卡片',
      title: repairedTitle,
      meta: fixed.meta || genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      before,
      after: null
    }
  }

  const compiledAfter = compileBlueprintFromScripts({ scripts: repairedScripts, prevBlueprint, expectedFormula: formula })
  const validationAfter = validateBlueprintDoc(compiledAfter.blueprint)
  const afterIssues = collectBlockingScriptIssues(compiledAfter.report, validationAfter)
  const after = { report: compiledAfter.report, validation: validationAfter, issues: afterIssues }

  if (afterIssues.length) {
    return {
      ok: false,
      repaired: true,
      status: 502,
      message: `AI 修复后仍未通过结构校验：${summarizeScriptIssues(afterIssues) || 'unknown_issue'}`,
      title: repairedTitle,
      meta: fixed.meta || genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      scripts: repairedScripts,
      blueprint: compiledAfter.blueprint,
      before,
      after
    }
  }

  return {
    ok: true,
    repaired: true,
    title: repairedTitle,
    scripts: repairedScripts,
    blueprint: compiledAfter.blueprint,
    meta: fixed.meta || genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
    before,
    after
  }
}
