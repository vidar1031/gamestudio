/*
  apps/server/src/ai/analyze.js

  说明：该模块用于对“脚本文档”（scriptsDoc）进行结构化分析，判断是否满足
  将脚本转换为蓝图（blueprint）所需的基本约束，例如卡片数量、选择点位置、
  选项格式、后果承接与结局数量等。返回一组 checks 与 suggestions，便于上层
  UI/后端给出修正建议或自动化规则生成。
*/

// 规范化换行：将 CRLF/CR 统一为 LF，返回字符串。
function normLines(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

// 将文本按行拆分为数组（基于 normLines 规范化后的换行）。
function splitLines(s) {
  return normLines(s).split('\n')
}

// 从给定文本中提取“选项”列表（支持两种常见格式）：
// 1) 每个选项独占一行：
//    选项A： 去做 X
//    选项B： 不去
// 2) 单行标记多个选项，后续文本片段作为每个选项的内容（更灵活，但需解析边界）。
// 返回数组 [{ key: 'A'|'1', text: '...'}]，至少 2 个选项时才视为有效。
function pickOptions(text) {
  const lines = splitLines(text).map((x) => x.trim()).filter(Boolean)
  const opts = []
  for (const ln of lines) {
    const m = ln.match(/^选项([A-Z]|\d{1,2})：\s*(.+)\s*$/i)
    if (m) {
      const rawKey = String(m[1])
      const key = /^\d/.test(rawKey) ? rawKey : rawKey.toUpperCase()
      opts.push({ key, text: m[2] })
    }
  }
  if (opts.length >= 2) return opts

  // 如果未以逐行格式找到足够选项，则尝试在全文中定位每个 “选项X：” 的起始位置，
  // 并根据相邻匹配划分片段。
  const raw = normLines(text)
  const re = /选项([A-Z]|\d{1,2})：/gi
  const hits = []
  let m = null
  while ((m = re.exec(raw))) {
    const rawKey = String(m[1])
    const key = /^\d/.test(rawKey) ? rawKey : rawKey.toUpperCase()
    hits.push({ key, idx: m.index + m[0].length })
  }
  if (hits.length < 2) return []
  const out = []
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].idx
    const end = i + 1 < hits.length ? hits[i + 1].idx - (`选项${hits[i + 1].key}：`.length) : raw.length
    const chunk = raw.slice(start, end).trim()
    const cleaned = chunk
      .replace(/^[：:;\s]+/, '')
      .replace(/\s+/g, ' ')
      .replace(/[。；;]+$/, '')
      .trim()
    if (cleaned) out.push({ key: hits[i].key, text: cleaned })
  }
  const seen = new Set()
  return out.filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)))
}

// 判定某张卡片是否为“选择点卡”：即包含至少两个解析出的选项。
// 返回 { ok: boolean, options: [...] }
function isChoiceCard(card) {
  const text = String(card?.text || '')
  const opts = pickOptions(text)
  return { ok: opts.length >= 2, options: opts }
}

// 判断一个卡片名称是否看起来像“后果”卡（用于检测是否为后续承接卡）。
function looksLikeConsequenceName(name) {
  const s = String(name || '')
  return /(^|\s)[A-Z]后果[:：]/i.test(s) || /(^|\s)\d{1,2}后果\d{1,2}[:：]/.test(s) || /后果/.test(s)
}

// 从后果卡的名称中提取其对应的选项 key。
// 支持两种命名：数字形式 "i后果k"（例如 "1后果2" 表示第 1 个选择点的选项 2）
// 以及字母形式 "A后果"（旧格式，返回大写字母）。如果匹配到且与当前 choicePointNo 对应则返回 key。
function consequenceKeyForChoice(name, choicePointNo) {
  const s = String(name || '').trim()
  // numeric: i后果k
  const mNum = s.match(/^(\d{1,2})后果(\d{1,2})(?:[:：]\s*)?/)
  if (mNum) {
    const i = Number(mNum[1])
    const k = String(mNum[2])
    if (Number.isFinite(i) && i === Number(choicePointNo)) return k
  }
  // legacy: A后果
  const mLet = s.match(/^([A-Z])后果(?:[:：]\s*)?/i)
  if (mLet) return String(mLet[1]).toUpperCase()
  return null
}

// 判断是否为“结局”卡（名称包含“结局”）。
function isEndingCard(card) {
  const name = String(card?.name || '')
  return /^结局/.test(name) || /结局/.test(name)
}

// 构造一个检查项对象，包含 id、ok、severity、message 和可选 detail。
function makeCheck(id, ok, severity, message, detail) {
  return { id, ok: Boolean(ok), severity: severity || 'info', message: String(message || ''), ...(detail ? { detail } : {}) }
}

export function defaultGlobalRulesSkeleton() {
  return {
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    hardRules: [
      '输出 8~12 张卡片。',
      '前 3~5 张卡内必须出现第 1 个选择点。',
      '至少 2 个选择点，每个选择点 2~3 个选项。',
      '选项格式必须换行：选项1/选项2/（可选 选项3/4/5）。',
      '后果卡命名：第 i 个选择点第 k 个选项对应“i后果k”（例如：1后果2）。',
      '结局 2~3 个，且能追溯到前面的选择。'
    ],
    softPrefs: [
      '因果紧凑，每张卡推进一个动作或结果，避免空泛总结。',
      '场景可演出：尽量包含动作/对话/环境变化。'
    ],
    notes: ''
  }
}

export function analyzeScriptsForBlueprint(scriptsDoc) {
  const cards = Array.isArray(scriptsDoc?.cards) ? scriptsDoc.cards : []
  const checks = []
  const suggestions = []

  // 1) card count
  const countOk = cards.length >= 8 && cards.length <= 12
  checks.push(makeCheck('card_count', countOk, countOk ? 'info' : 'warn', `卡片数量：${cards.length}（建议 8~12）`))
  if (!countOk) suggestions.push('将卡片数量收敛到 8~12，避免过长或过短。')

  // 2) choice points
  const choiceIdx = []
  const choiceCards = []
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    const res = isChoiceCard(c)
    if (res.ok) {
      choiceIdx.push(i)
      choiceCards.push({ index: i + 1, name: String(c?.name || ''), options: res.options })
    }
  }

  const choiceCountOk = choiceIdx.length >= 2
  checks.push(makeCheck('choice_count', choiceCountOk, choiceCountOk ? 'info' : 'error', `选择点数量：${choiceIdx.length}（至少 2 个）`))
  if (!choiceCountOk) suggestions.push('至少加入 2 个选择点，才能形成可用的蓝图分支。')

  const firstChoice = choiceIdx.length ? (choiceIdx[0] + 1) : null
  const earlyChoiceOk = firstChoice != null && firstChoice >= 3 && firstChoice <= 5
  checks.push(makeCheck('choice_early', earlyChoiceOk, earlyChoiceOk ? 'info' : 'warn', `第 1 个选择点位置：${firstChoice ? `第 ${firstChoice} 卡` : '未发现'}`))
  if (!earlyChoiceOk) suggestions.push('把第 1 个选择点提前到第 3~5 卡，提高交互参与感。')

  const escapedNewlineCards = cards
    .map((c, i) => ({ i, text: String(c?.text || '') }))
    .filter((x) => x.text.includes('\\n'))
    .map((x) => x.i + 1)
  const escapedNewlineOk = escapedNewlineCards.length === 0
  checks.push(makeCheck('escaped_newlines', escapedNewlineOk, escapedNewlineOk ? 'info' : 'warn', escapedNewlineOk ? '换行字符：OK' : `有 ${escapedNewlineCards.length} 张卡包含字面量 \\n（第 ${escapedNewlineCards.join('、')} 卡）`))
  if (!escapedNewlineOk) suggestions.push('不要在 text 里输出字面量 \\n，请直接使用真实换行，避免选项解析和编辑器显示异常。')

  // 3) option formatting (newline)
  let newlineOk = true
  let badOptionCards = 0
  for (const idx of choiceIdx) {
    const t = normLines(cards[idx]?.text || '')
    // if options exist but all are in one line, treat as bad
    const hasOpt = /选项([A-Z]|\d{1,2})：/i.test(t)
    const hasNewlineBetween = /\n\s*选项([A-Z]|\d{1,2})：/i.test(t)
    if (hasOpt && !hasNewlineBetween) {
      newlineOk = false
      badOptionCards++
    }
  }
  checks.push(makeCheck('option_newlines', newlineOk, newlineOk ? 'info' : 'warn', `选项换行格式：${newlineOk ? 'OK' : `有 ${badOptionCards} 张选择卡未按换行格式`}`))
  if (!newlineOk) suggestions.push('选择点的选项请使用换行格式：每个“选项A/B/C”独占一行，便于后续自动转 choices。')

  // 4) consequences after choice (1-2 cards)
  let consequenceOk = true
  const consequenceIssues = []
  let choiceNo = 0
  for (const idx of choiceIdx) {
    choiceNo += 1
    const opts = pickOptions(cards[idx]?.text || '')
    const keys = opts.map((o) => o.key)
    const found = new Set()
    for (let j = idx + 1; j < Math.min(cards.length, idx + 40); j++) {
      const k = consequenceKeyForChoice(cards[j]?.name, choiceNo)
      if (k && keys.includes(k)) found.add(k)
      if (found.size === keys.length) break
      // Stop early if next choice point begins.
      if (choiceIdx.includes(j)) break
    }
    if (keys.length >= 2 && found.size < keys.length) {
      consequenceOk = false
      consequenceIssues.push(choiceNo)
    }
  }

  checks.push(makeCheck('consequences', consequenceOk, consequenceOk ? 'info' : 'warn', consequenceOk ? '选择点后果承接：OK' : `存在选择点缺少后果承接：第 ${consequenceIssues.join(', ')} 个选择点`))
  if (!consequenceOk) suggestions.push('每个选择点后请为每个选项提供对应后果卡（推荐命名：i后果k），保证分支可追溯。')

  const branchMergeRisks = []
  let mergeChoiceNo = 0
  for (const idx of choiceIdx) {
    mergeChoiceNo += 1
    const opts = pickOptions(cards[idx]?.text || '')
    const keys = opts.map((o) => o.key)
    if (keys.length < 2) continue
    const found = []
    for (let j = idx + 1; j < Math.min(cards.length, idx + 40); j++) {
      const k = consequenceKeyForChoice(cards[j]?.name, mergeChoiceNo)
      if (k && keys.includes(k)) found.push(j)
      if (found.length === keys.length) break
      if (choiceIdx.includes(j)) break
    }
    if (found.length !== keys.length) continue
    const joinIndex = Math.max(...found) + 1
    const joinCard = joinIndex < cards.length ? cards[joinIndex] : null
    if (!joinCard || isEndingCard(joinCard) || isChoiceCard(joinCard).ok) {
      if (joinCard && isChoiceCard(joinCard).ok) {
        branchMergeRisks.push({
          choicePoint: mergeChoiceNo,
          joinName: String(joinCard?.name || `第${joinIndex + 1}卡`)
        })
      }
      continue
    }
    branchMergeRisks.push({
      choicePoint: mergeChoiceNo,
      joinName: String(joinCard?.name || `第${joinIndex + 1}卡`)
    })
  }
  const branchMergeOk = branchMergeRisks.length === 0
  checks.push(
    makeCheck(
      'branch_merge_common_state',
      branchMergeOk,
      branchMergeOk ? 'info' : 'warn',
      branchMergeOk
        ? '分支合流风险：未发现明显共享合流场景'
        : `存在 ${branchMergeRisks.length} 处共享合流场景，需确认只描述共同事实`
    )
  )
  if (!branchMergeOk) {
    suggestions.push('若多个后果卡会重新进入同一场景/选择点，这个合流场景只能写所有路径都成立的共同事实；若涉及“已经拿到鱼/丢了鱼竿/受伤/获得道具”等分支专属状态，应拆成不同承接卡。')
  }

  // 5) endings
  const endings = cards.filter((c) => isEndingCard(c))
  const endingOk = endings.length >= 2 && endings.length <= 3
  checks.push(makeCheck('endings', endingOk, endingOk ? 'info' : 'warn', `结局数量：${endings.length}（建议 2~3）`))
  if (!endingOk) suggestions.push('结局建议控制在 2~3 个，并确保与前面选择的因果一致、可追溯。')

  // 6) duplicative choices heuristic
  let dupWarn = false
  if (choiceCards.length >= 2) {
    const a0 = choiceCards[0].options.map((o) => o.text).join('|')
    const a1 = choiceCards[1].options.map((o) => o.text).join('|')
    if (a0 && a1 && (a0.includes('继续等待') && a1.includes('继续等待'))) dupWarn = true
  }
  checks.push(makeCheck('choice_distinct', !dupWarn, dupWarn ? 'warn' : 'info', dupWarn ? '选择点内容疑似重复（建议让第 2 个选择点提出不同维度的决策）' : '选择点区分度：OK'))
  if (dupWarn) suggestions.push('第 2 个选择点要提出不同维度的决策（策略/风险/人物关系等），避免重复“继续/放弃”。')

  const ok = checks.every((c) => c.ok || c.severity === 'warn' || c.severity === 'info') && checks.filter((c) => c.severity === 'error').length === 0

  const proposedRules = defaultGlobalRulesSkeleton()
  // If we detect issues, emphasize the failing checks as hard rules
  if (!earlyChoiceOk) proposedRules.hardRules.unshift('第 1 个选择点必须在第 3~5 张卡内出现。')
  if (!choiceCountOk) proposedRules.hardRules.unshift('至少 2 个选择点。')
  if (!newlineOk) proposedRules.hardRules.unshift('选择点选项必须换行输出（选项A/选项B/选项C）。')
  if (!consequenceOk) proposedRules.hardRules.unshift('每个选择点后必须紧跟 1~2 张后果卡，并标注 A后果/B后果。')
  if (!endingOk) proposedRules.hardRules.unshift('结局数量控制在 2~3 个，且可追溯到选择。')

  const summary = ok ? '整体结构可用于后续蓝图分支（仍可微调）。' : '存在影响蓝图转换的结构问题，建议先修正再进入蓝图层。'

  return {
    ok,
    summary,
    stats: {
      cardCount: cards.length,
      choiceCount: choiceIdx.length,
      firstChoiceCard: firstChoice,
      endingCount: endings.length
    },
    checks,
    suggestions,
    proposedRules
  }
}
