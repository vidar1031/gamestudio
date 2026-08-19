// AUTO-E05：故事完整度核实——用真实浏览器打开导出的可玩 H5，逐节点走查截图，
// 做确定性检查 + AI 视觉评审，产出完整度报告。补齐生产 QA 在导出后的整体验证环节
// （生成侧已有 E01 reference gate / E02 审核门禁 / E03 批量队列，导出后此前无核实）。
//
// 分层与复用：
// - 浏览器遍历（walkStoryPlayer）只依赖一个最小 page 接口（goto/evaluate/screenshot/on/setViewport），
//   测试可注入 fake page 覆盖 DFS 遍历与降级分支，真实运行由 createPuppeteerBrowserLauncher 驱动本机 Chrome。
// - AI 视觉评审复用 story.lock.review 的 moonshot 模式（chat/completions + image_url，
//   kimi-for-coding 支持视觉输入且 temperature 仅允许 1）；Kimi 不可用/失败一律如实记
//   review_unavailable，绝不伪造评审结果。
// - 产物落盘：截图 <project>/reviews/completeness/<timestamp>/node_<nodeId>.png，
//   汇总报告 <project>/reviews/completeness_<timestamp>.json（tmp+rename 原子写，与 E03 checkpoint 同手法）。
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const COMPLETENESS_TASK_KIND = 'story.completeness_check'

function asStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function nowIso() {
  return new Date().toISOString()
}

// 报告目录/文件名用可排序的紧凑时间戳（20260817T014500Z）
export function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function sanitizeFilePart(s) {
  return asStr(s).replace(/[^a-zA-Z0-9_.-]+/g, '_') || 'node'
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 图构建：从 story.json 读出节点图，BFS 计算每个节点的最短到达路径（选项序列）
// ---------------------------------------------------------------------------

export function buildStoryNodeGraph(story) {
  const nodes = Array.isArray(story && story.nodes) ? story.nodes.filter((n) => n && asStr(n.id)) : []
  const nodeMap = new Map(nodes.map((n) => [asStr(n.id), n]))
  const startNodeId = asStr(story && (story.startNodeId || story.startId)) || (nodes[0] ? asStr(nodes[0].id) : '')

  // 每个节点的出边：choices 顺序即播放器渲染顺序（visibleWhen 过滤在运行时发生）
  const edgesOf = (node) =>
    (Array.isArray(node && node.choices) ? node.choices : []).map((c, index) => ({
      choiceIndex: index,
      choiceText: asStr(c && c.text) || '选择',
      toNodeId: asStr(c && c.toNodeId)
    }))

  // BFS：path = [{ fromNodeId, choiceIndex, choiceText, ordinal, toNodeId }]，ordinal 为同文本选项的出现序号
  const paths = new Map()
  const visitOrder = []
  if (startNodeId && nodeMap.has(startNodeId)) {
    paths.set(startNodeId, [])
    visitOrder.push(startNodeId)
    const queue = [startNodeId]
    while (queue.length) {
      const current = queue.shift()
      const node = nodeMap.get(current)
      const seenTexts = new Map()
      for (const edge of edgesOf(node)) {
        const ordinal = seenTexts.get(edge.choiceText) || 0
        seenTexts.set(edge.choiceText, ordinal + 1)
        if (!edge.toNodeId || !nodeMap.has(edge.toNodeId)) continue
        if (paths.has(edge.toNodeId)) continue // 重复路径去重：保留最短
        paths.set(edge.toNodeId, [...paths.get(current), { fromNodeId: current, ...edge, ordinal }])
        visitOrder.push(edge.toNodeId)
        queue.push(edge.toNodeId)
      }
    }
  }
  const unreachableNodeIds = nodes.map((n) => asStr(n.id)).filter((id) => !paths.has(id))
  return { nodes, nodeMap, startNodeId, paths, visitOrder, unreachableNodeIds }
}

// ---------------------------------------------------------------------------
// 期望文本提示：与播放器 ensureTimelineForNode/renderOverlay 同源地推导节点可见文本，
// 用于走查时的到达确认（到达确认失败本身就是一条确定性缺陷证据）
// ---------------------------------------------------------------------------

// 播放器 renderOverlay 的选项行过滤（保持同一条正则，避免提示文本与页面实际显示不一致）
const OPTION_LINE_RE = /^\s*(?:选项|option)\s*(?:\d{1,2}|[A-Z]|[一二三四五六七八九十])\s*[:：]/i

function normalizeVisibleText(raw) {
  const filtered = String(raw || '')
    .split(/\r?\n/)
    .filter((ln) => !OPTION_LINE_RE.test(ln))
    .map((ln) => ln.trim())
    .filter(Boolean)
    .join('\n')
  return (filtered || String(raw || '')).replace(/\s+/g, ' ').trim()
}

export function expectedNodeTextHint(node) {
  const steps = Array.isArray(node && node.timeline && node.timeline.steps) ? node.timeline.steps : []
  for (const step of steps) {
    const actions = Array.isArray(step && step.actions) ? step.actions : []
    for (const action of actions) {
      const t = asStr(action && action.type)
      if (t === 'ui.setText' && asStr(action.text)) return normalizeVisibleText(action.text).slice(0, 24)
      if (t === 'ui.showEndingCard' && asStr(action.card && action.card.moral)) return normalizeVisibleText(action.card.moral).slice(0, 24)
    }
  }
  const fallback = asStr(node && node.body && node.body.text)
  return fallback ? normalizeVisibleText(fallback).slice(0, 24) : ''
}

// ---------------------------------------------------------------------------
// 资产索引：backgroundAssetId / placements → 资产 uri；uri 归一为 assets/ 尾巴，
// 用于与浏览器失败请求 URL 做确定性匹配（dist 内为 ./assets/... 相对路径）
// ---------------------------------------------------------------------------

export function assetTailFromUri(uri) {
  const raw = asStr(uri).replace(/\\/g, '/')
  if (!raw) return ''
  const m = raw.match(/(?:^|\/)assets\/.+$/)
  if (m) return m[0].replace(/^\//, '')
  const segs = raw.split('/').filter(Boolean)
  return segs.length ? segs[segs.length - 1] : ''
}

export function buildAssetIndex(project) {
  const index = new Map()
  const assets = Array.isArray(project && project.assets) ? project.assets : []
  for (const a of assets) {
    const id = asStr(a && a.id)
    if (!id) continue
    const uri = asStr(a && a.uri)
    index.set(id, { uri, tail: assetTailFromUri(uri) })
  }
  return index
}

export function buildCharacterIndex(project) {
  const index = new Map()
  const chars = Array.isArray(project && project.characters) ? project.characters : []
  for (const ch of chars) {
    const id = asStr(ch && ch.id)
    if (id) index.set(id, { imageAssetId: asStr(ch && ch.imageAssetId) })
  }
  return index
}

function urlMatchesTail(url, tail) {
  const u = asStr(url)
  const t = asStr(tail)
  if (!u || !t) return false
  return u.includes(t) || u.includes(encodeURI(t))
}

// ---------------------------------------------------------------------------
// 页面观察/操作原语：在浏览器上下文执行，必须自包含（不可引用模块作用域变量）。
// 导出命名函数，fake page 在测试里按 fn.name 分发。
// ---------------------------------------------------------------------------

export function observePlayerState() {
  const txt = (el) => (el ? String(el.textContent || '') : '')
  const visible = (el) => Boolean(el) && el.style.display !== 'none'
  const canvas = document.querySelector('#app canvas')
  return {
    canvasExists: Boolean(canvas),
    canvasWidth: canvas ? Number(canvas.width) || 0 : 0,
    canvasHeight: canvas ? Number(canvas.height) || 0 : 0,
    dialogText: txt(document.getElementById('dialogText')).trim(),
    dialogVisible: visible(document.getElementById('dialogText')),
    nodeTitle: txt(document.getElementById('dialogNodeName')).trim(),
    endingVisible: visible(document.getElementById('endingWrap')),
    actionsVisible: visible(document.getElementById('actions')),
    choiceButtons: Array.from(document.querySelectorAll('#choices .choiceBtn')).map((b) => ({
      text: String(b.textContent || '').replace(/\s+/g, ' ').trim(),
      disabled: Boolean(b.disabled)
    }))
  }
}

export function clickChoiceButtonByText(arg) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const want = norm(arg && arg.text)
  const ordinal = Math.max(0, Number(arg && arg.ordinal) || 0)
  const btns = Array.from(document.querySelectorAll('#choices .choiceBtn'))
  const rendered = btns.map((b) => ({ text: norm(b.textContent), disabled: Boolean(b.disabled) }))
  const matches = btns.filter((b) => norm(b.textContent) === want)
  const el = matches[ordinal] || null
  if (!el) return { clicked: false, reason: 'not_found', rendered }
  if (el.disabled) return { clicked: false, reason: 'disabled', rendered }
  el.click()
  return { clicked: true, rendered }
}

export function waitForFontsReady() {
  try {
    return Promise.resolve(document.fonts && document.fonts.ready).then(() => true)
  } catch (_) {
    return true
  }
}

// 页面侧事件采集：console 错误 / pageerror / 失败请求，按当前走查节点 tag 归账
export function attachPageObservers(page, sink) {
  if (!page || typeof page.on !== 'function') return
  page.on('console', (msg) => {
    try {
      if (msg.type() !== 'error') return
      sink.consoleErrors.push({ tag: sink.currentTag, text: asStr(msg.text()) || 'console_error' })
    } catch (_) {}
  })
  page.on('pageerror', (err) => {
    sink.consoleErrors.push({ tag: sink.currentTag, text: `pageerror: ${asStr(err && err.message) || 'unknown'}` })
  })
  page.on('response', (res) => {
    try {
      const status = Number(res.status())
      if (status >= 400) sink.failedRequests.push({ tag: sink.currentTag, url: asStr(res.url()), status })
    } catch (_) {}
  })
  page.on('requestfailed', (req) => {
    try {
      sink.failedRequests.push({ tag: sink.currentTag, url: asStr(req.url()), status: 0, error: asStr(req.failure() && req.failure().errorText) })
    } catch (_) {}
  })
}

// ---------------------------------------------------------------------------
// 每节点确定性检查（纯函数，测试可直接覆盖全部问题码）
// ---------------------------------------------------------------------------

export function evaluateNodeDeterministicChecks({
  node,
  observed,
  assetIndex,
  characterIndex,
  failedRequests = [],
  consoleErrors = [],
  reachable = true,
  arrivalConfirmed = true,
  replayError = null
}) {
  const issues = []
  const checks = {
    arrival: 'ok',
    canvas: 'ok',
    background: 'ok',
    sprites: 'ok',
    dialogText: 'ok',
    choices: 'ok',
    console: 'ok'
  }
  const push = (code, message) => issues.push({ code, message })
  const kind = asStr(node && node.kind) === 'ending' ? 'ending' : 'scene'
  const nodeId = asStr(node && node.id)

  if (!reachable) {
    checks.arrival = 'unreachable'
    push('node_unreachable_runtime', `节点不可达：${asStr(replayError && replayError.code) || 'unknown'}（${asStr(replayError && replayError.detail)}）`)
    return { issues, checks }
  }
  if (!arrivalConfirmed) {
    checks.arrival = 'unconfirmed'
    push('arrival_unconfirmed', '点击跳转后页面文本未在时限内呈现该节点内容，导航疑似失败')
  }

  // 画布：Pixi 初始化失败的直接证据
  if (!observed || !observed.canvasExists) {
    checks.canvas = 'missing'
    push('canvas_missing', '页面中不存在 Pixi 画布（#app canvas），播放器渲染失败')
  }

  // 背景：无 backgroundAssetId/uri → 播放器走「场景图像未生成」占位符；uri 存在但请求失败 → 破图
  const bgId = asStr(node && node.visuals && node.visuals.backgroundAssetId)
  const bgAsset = bgId && assetIndex ? assetIndex.get(bgId) : null
  if (!bgId || !bgAsset || !bgAsset.uri) {
    checks.background = 'missing'
    push('background_missing', bgId ? `背景资产 ${bgId} 在项目资产中无可用文件，舞台显示占位符` : '节点未绑定背景资产，舞台显示「场景图像未生成」占位符')
  } else {
    const failed = failedRequests.find((r) => urlMatchesTail(r.url, bgAsset.tail))
    if (failed) {
      checks.background = 'load_failed'
      push('background_load_failed', `背景图请求失败（${asStr(failed.url)} status=${failed.status}）`)
    }
  }

  // 立绘：与 story.json placements 对照，缺立绘记 sprite_missing，请求失败记 sprite_load_failed
  const placements = (Array.isArray(node && node.visuals && node.visuals.placements) ? node.visuals.placements : [])
    .filter((p) => p && p.visible !== false)
  const missingSprites = []
  const failedSprites = []
  for (const p of placements) {
    const ch = characterIndex ? characterIndex.get(asStr(p.characterId)) : null
    const imageAssetId = asStr(p.imageAssetId) || (ch ? ch.imageAssetId : '')
    const asset = imageAssetId && assetIndex ? assetIndex.get(imageAssetId) : null
    if (!imageAssetId || !asset || !asset.uri) {
      missingSprites.push(asStr(p.characterId) || imageAssetId || 'unknown')
      continue
    }
    const failed = failedRequests.find((r) => urlMatchesTail(r.url, asset.tail))
    if (failed) failedSprites.push(`${imageAssetId}（status=${failed.status}）`)
  }
  if (missingSprites.length) {
    checks.sprites = 'missing'
    push('sprite_missing', `立绘缺失 ${missingSprites.length}/${placements.length}：${missingSprites.join('、')}（无可用图像资产）`)
  }
  if (failedSprites.length) {
    checks.sprites = checks.sprites === 'ok' ? 'load_failed' : checks.sprites
    push('sprite_load_failed', `立绘加载失败：${failedSprites.join('、')}`)
  }

  // 文本：对话框可见文本非空（结尾节点为结局卡 moral 的兜底显示）
  if (!observed || !asStr(observed.dialogText)) {
    checks.dialogText = 'empty'
    push('dialog_text_empty', '对话框文本为空')
  }

  // 选项/结尾：非结尾节点需有可点选项；结尾节点需出现结尾 UI（结尾卡或重开按钮）
  const storyChoices = Array.isArray(node && node.choices) ? node.choices : []
  const renderedButtons = observed && Array.isArray(observed.choiceButtons) ? observed.choiceButtons : []
  const enabledButtons = renderedButtons.filter((b) => !b.disabled)
  if (kind === 'ending') {
    const hasEndingUi = Boolean(observed && observed.endingVisible) || renderedButtons.length > 0
    if (!hasEndingUi) {
      checks.choices = 'ending_ui_missing'
      push('ending_ui_missing', '结尾节点未呈现结尾卡或重开按钮，遍历无法在此终止')
    }
  } else if (!storyChoices.length) {
    checks.choices = 'dead_end'
    push('non_ending_no_choices', '非结尾节点没有配置选项，故事在此死胡同终止')
  } else if (!enabledButtons.length) {
    checks.choices = 'missing'
    push('choice_buttons_missing', `节点配置了 ${storyChoices.length} 个选项，但页面未渲染出可点击的选项按钮`)
  }

  // 控制台错误：资源加载失败已由 failedRequests 精确归账，这里只记脚本级错误
  const scriptErrors = Array.from(new Set(consoleErrors.map((e) => asStr(e.text)).filter(Boolean)))
    .filter((t) => !/failed to load resource/i.test(t))
    .slice(0, 10)
  if (scriptErrors.length) {
    checks.console = 'errors'
    push('console_error', `页面控制台出现 ${scriptErrors.length} 条错误：${scriptErrors[0].slice(0, 160)}`)
  }

  return { issues, checks }
}

// ---------------------------------------------------------------------------
// 浏览器遍历：BFS 顺序逐节点走查；每次访问先 reload 再按路径重放点击，保证状态确定
// ---------------------------------------------------------------------------

async function waitArrival(page, hint, { timeoutMs, sleep }) {
  if (!hint) {
    await sleep(600)
    return { confirmed: true, observed: await page.evaluate(observePlayerState) }
  }
  const deadline = Date.now() + timeoutMs
  let observed = null
  while (Date.now() < deadline) {
    observed = await page.evaluate(observePlayerState)
    if (normalizeVisibleText(observed.dialogText).includes(hint)) return { confirmed: true, observed }
    await sleep(150)
  }
  return { confirmed: false, observed }
}

export async function walkStoryPlayer({
  page,
  graph,
  distUrl,
  screenshotDir,
  assetIndex,
  characterIndex,
  reviewer = null,
  sink = null,
  onNodeDone = null,
  settleMs = 700,
  navTimeoutMs = 20000,
  arrivalTimeoutMs = 4000,
  sleep = defaultSleep
}) {
  const reports = []
  const eventSink = sink || { currentTag: '', consoleErrors: [], failedRequests: [] }
  let playerInitChecked = false

  for (const nodeId of graph.visitOrder) {
    const node = graph.nodeMap.get(nodeId)
    eventSink.currentTag = nodeId

    // 1. 全量加载（等价 reload，变量状态归零），随后确认播放器已初始化
    await page.goto(distUrl, { waitUntil: 'networkidle2' })
    if (!playerInitChecked) {
      const deadline = Date.now() + navTimeoutMs
      let ok = false
      while (Date.now() < deadline) {
        const obs = await page.evaluate(observePlayerState)
        if (obs.canvasExists) { ok = true; break }
        await sleep(250)
      }
      if (!ok) {
        const e = new Error('player_init_failed')
        e.message = 'player_init_failed: Pixi 画布在时限内未出现（CDN/脚本加载失败？），走查中止'
        throw e
      }
      playerInitChecked = true
    }

    // 2. 重放到达路径（点击序列），任一步失败即该节点运行时不可达；
    // 末步不做中间到达检查——目标节点的到达确认归第 3 步（arrival_unconfirmed 语义）
    const pathSteps = graph.paths.get(nodeId) || []
    let replayError = null
    for (let stepIdx = 0; stepIdx < pathSteps.length; stepIdx += 1) {
      const step = pathSteps[stepIdx]
      await waitArrival(page, expectedNodeTextHint(graph.nodeMap.get(step.fromNodeId)), { timeoutMs: arrivalTimeoutMs, sleep })
      const res = await page.evaluate(clickChoiceButtonByText, { text: step.choiceText, ordinal: step.ordinal })
      if (!res || !res.clicked) {
        replayError = {
          code: `choice_button_${res && res.reason ? res.reason : 'not_found'}`,
          detail: `在 ${step.fromNodeId} 未点到选项「${step.choiceText}」，渲染按钮：${(res && res.rendered ? res.rendered : []).map((b) => `${b.text}${b.disabled ? '(禁用)' : ''}`).join(' / ') || '无'}`
        }
        break
      }
      if (stepIdx < pathSteps.length - 1) {
        const arrival = await waitArrival(page, expectedNodeTextHint(graph.nodeMap.get(step.toNodeId)), { timeoutMs: arrivalTimeoutMs, sleep })
        if (!arrival.confirmed) {
          replayError = { code: 'arrival_timeout', detail: `点击「${step.choiceText}」后未到达中间节点 ${step.toNodeId}，路径中断` }
          break
        }
      }
    }

    // 3. 到达目标节点：等待字体与 Pixi 渲染稳定后观察页面状态
    const reachable = !replayError
    let arrivalConfirmed = reachable
    let observed = null
    if (reachable) {
      const arrival = await waitArrival(page, expectedNodeTextHint(node), { timeoutMs: arrivalTimeoutMs, sleep })
      arrivalConfirmed = arrival.confirmed
      await page.evaluate(waitForFontsReady)
      await sleep(settleMs)
      observed = await page.evaluate(observePlayerState)
    }

    // 4. 确定性检查（console 错误与失败请求按 tag 归账到本节点）
    const consoleErrors = eventSink.consoleErrors.filter((e) => e.tag === nodeId)
    const failedRequests = eventSink.failedRequests.filter((r) => r.tag === nodeId)
    const { issues, checks } = evaluateNodeDeterministicChecks({
      node,
      observed,
      assetIndex,
      characterIndex,
      failedRequests,
      consoleErrors,
      reachable,
      arrivalConfirmed,
      replayError
    })

    // 5. 截图留证（不可达节点也截，记录当时页面状态）
    const shotName = `node_${sanitizeFilePart(nodeId)}.png`
    const shotPath = path.join(screenshotDir, shotName)
    try {
      await page.screenshot({ path: shotPath })
    } catch (_) { /* 截图失败不阻断走查，AI 评审随之降级 */ }

    // 6. AI 视觉评审：仅对到达的节点执行；失败如实记 unavailable
    let aiReview = { status: 'skipped', reason: reachable ? 'reviewer_not_configured' : 'node_unreachable' }
    if (reachable && reviewer) {
      try {
        aiReview = await reviewer({ node, observed, screenshotPath: shotPath })
      } catch (e) {
        aiReview = { status: 'unavailable', reason: asStr(e && e.message) || 'review_failed' }
      }
    }

    const report = {
      nodeId,
      name: asStr(node.name) || asStr(node.body && node.body.title),
      kind: asStr(node.kind) === 'ending' ? 'ending' : 'scene',
      reachable,
      pathLength: pathSteps.length,
      observed: observed
        ? {
            dialogText: asStr(observed.dialogText).slice(0, 200),
            choiceButtons: (observed.choiceButtons || []).slice(0, 12),
            canvasExists: Boolean(observed.canvasExists),
            endingVisible: Boolean(observed.endingVisible)
          }
        : null,
      checks,
      issues,
      consoleErrors: consoleErrors.map((e) => e.text).slice(0, 10),
      failedRequests: failedRequests.slice(0, 10),
      screenshot: shotName,
      aiReview
    }
    reports.push(report)
    if (onNodeDone) await onNodeDone({ nodeId, index: reports.length, total: graph.visitOrder.length + graph.unreachableNodeIds.length, report })
  }

  // 静态不可达节点（图中没有任何路径）：直接记失败证据，不消耗浏览器访问
  for (const nodeId of graph.unreachableNodeIds) {
    const node = graph.nodeMap.get(nodeId)
    const report = {
      nodeId,
      name: asStr(node.name),
      kind: asStr(node.kind) === 'ending' ? 'ending' : 'scene',
      reachable: false,
      pathLength: -1,
      observed: null,
      checks: { arrival: 'unreachable', canvas: 'ok', background: 'ok', sprites: 'ok', dialogText: 'ok', choices: 'ok', console: 'ok' },
      issues: [{ code: 'node_unreachable_static', message: '节点在选项图中没有任何到达路径（孤儿节点）' }],
      consoleErrors: [],
      failedRequests: [],
      screenshot: '',
      aiReview: { status: 'skipped', reason: 'node_unreachable' }
    }
    reports.push(report)
    if (onNodeDone) await onNodeDone({ nodeId, index: reports.length, total: graph.visitOrder.length + graph.unreachableNodeIds.length, report })
  }

  return reports
}

// ---------------------------------------------------------------------------
// AI 视觉评审：复用 story.lock.review 的 moonshot 视觉调用模式，并支持 omlx
// （本地 OpenAI 兼容 /chat/completions，已实测 Qwen3.5-9B-MLX-4bit 接受 image_url；
// Qwen3.6-27B 当前受内存上限 507，属临时故障，如实记 unavailable 不伪造）。
// ---------------------------------------------------------------------------

// 评审模型配置解析（纯函数）：provider 按 body > settings > 环境默认解析；
// model/apiUrl 只在「来源段与生效 provider 相同」时继承，否则回落该 provider 的默认，
// 避免 body 把 provider 改成 omlx 却继承 settings 里 moonshot 的模型与端点。
export function resolveReviewConfig({ studioEffective, body, env = process.env } = {}) {
  const s = studioEffective && typeof studioEffective.review === 'object' && studioEffective.review ? studioEffective.review : {}
  const b = body && typeof body === 'object' ? body : {}
  const settingsProvider = asStr(s.provider).toLowerCase()
  const provider = (asStr(b.provider) || settingsProvider || (asStr(env.MOONSHOT_API_KEY) ? 'moonshot' : '')).toLowerCase()
  const inheritSettings = settingsProvider && settingsProvider === provider
  const defaultModel = provider === 'omlx'
    ? (asStr(env.LOCALOXML_MODEL) || asStr(env.STUDIO_AI_MODEL) || 'Qwen3.6-27B-4bit')
    : 'kimi-for-coding'
  const defaultUrl = provider === 'omlx'
    ? (asStr(env.LOCALOXML_BASE_URL) || asStr(env.STUDIO_AI_BASE_URL) || 'http://127.0.0.1:18888/v1')
    : (asStr(env.MOONSHOT_BASE_URL) || 'https://api.kimi.com/coding/v1')
  return {
    provider,
    model: asStr(b.model) || (inheritSettings ? asStr(s.model) : '') || defaultModel,
    apiUrl: asStr(b.apiUrl) || (inheritSettings ? asStr(s.apiUrl) : '') || defaultUrl
  }
}

function extractJsonObjectString(raw) {
  let text = asStr(raw)
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return text
  return text.slice(start, end + 1)
}

function buildNodeReviewInstructions(nodeContext) {
  const ctx = nodeContext && typeof nodeContext === 'object' ? nodeContext : {}
  return (
    `你是互动故事成品的视觉质检员。输入是一张故事播放器的真实截图（竖屏舞台：Pixi 画布渲染背景图与人物立绘，底部为对话卡）。\n` +
    `请按以下细则审查该节点画面：\n` +
    `1. 图文匹配：画面内容与节点文本描述的场景是否一致。\n` +
    `2. 立绘合成：人物立绘是否为透明背景自然合成——无白底/黑底方框、无明显错位、无被裁出画面。\n` +
    `3. 背景纯净：背景图本身不应包含人物（人物应由立绘层提供）。\n` +
    `4. 破图与占位：有无图片加载失败导致的大片纯黑/纯白/灰块；出现「场景图像未生成」占位文字必须判失败。\n` +
    `5. 文本可读：对话框文本清晰可读，未被异常遮挡。\n` +
    `输出要求：只输出一个合法 JSON 对象，不要 markdown 代码块，不要任何额外文字。\n` +
    `JSON 结构：{"passed": 布尔, "score": 0到100的整数, "issues": ["问题描述"], "summary": "一句话结论"}\n` +
    `passed=false 当且仅当存在上述任一类明确缺陷；拿不准的轻微风格问题只扣分不判失败。`
  )
}

export function normalizeCompletenessAiReview(obj) {
  if (!obj || typeof obj !== 'object') return null
  const out = { ...obj }
  if (typeof out.passed !== 'boolean') {
    const score = Number(out.score)
    out.passed = Number.isFinite(score) ? score >= 60 : false
  }
  const score = Number(out.score)
  out.score = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : (out.passed ? 80 : 20)
  if (!Array.isArray(out.issues)) {
    const alt = out.problems || out.errors || out.issue
    out.issues = Array.isArray(alt) ? alt : (alt ? [String(alt)] : [])
  }
  out.issues = out.issues.map((x) => asStr(x)).filter(Boolean).slice(0, 20)
  out.summary = asStr(out.summary || out.reason || out.analysis || out.issues[0] || (out.passed ? '视觉评审通过' : '视觉评审未通过'))
  return out
}

export async function reviewNodeScreenshotWithVision({
  provider,
  apiKey,
  baseUrl,
  model,
  imageDataUrl,
  nodeContext,
  timeoutMs = 120000,
  fetchImpl
}) {
  const p = asStr(provider).toLowerCase() || 'moonshot'
  const doFetch = fetchImpl || fetch
  const url = `${asStr(baseUrl).replace(/\/+$/, '') || (p === 'omlx' ? 'http://127.0.0.1:18888/v1' : 'https://api.kimi.com/coding/v1')}/chat/completions`
  const ctx = nodeContext && typeof nodeContext === 'object' ? nodeContext : {}
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 120000))
  try {
    const res = await doFetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: asStr(model) || (p === 'omlx' ? 'Qwen3.6-27B-4bit' : 'kimi-for-coding'),
        messages: [
          { role: 'system', content: buildNodeReviewInstructions(ctx) },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `请审查这个节点的画面。\n` +
                  `节点：${asStr(ctx.name) || asStr(ctx.nodeId)}（${asStr(ctx.kind) || 'scene'}）\n` +
                  `节点文本：${asStr(ctx.text) || '（空）'}\n` +
                  `预期：背景图 ${ctx.backgroundExpected ? '1 张' : '无'}；立绘 ${Number(ctx.placementsExpected) || 0} 个。`
              },
              { type: 'image_url', image_url: { url: asStr(imageDataUrl) } }
            ]
          }
        ],
        max_tokens: 4000,
        // kimi-for-coding 仅允许 temperature=1；omlx 走服务端默认，不显式传
        ...(p === 'moonshot' ? { temperature: 1 } : {})
      })
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error((json && json.error && json.error.message) || `review_http_${res.status}`)
    }
    const content = asStr(json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content)
    const parsed = normalizeCompletenessAiReview(JSON.parse(extractJsonObjectString(content) || '{}'))
    if (!parsed) throw new Error('invalid_completeness_review_output')
    return parsed
  } finally {
    clearTimeout(timeout)
  }
}

// 评审器工厂：任何配置问题都返回「如实记 unavailable 的评审器」，绝不伪造评审。
// provider=moonshot 读 MOONSHOT_API_KEY；provider=omlx 读 LOCALOXML/STUDIO_AI/OPENAI_API_KEY。
export function createNodeVisualReviewer({ provider, model, apiUrl, timeoutMs, fetchImpl, env = process.env } = {}) {
  const p = asStr(provider).toLowerCase()
  if (p !== 'moonshot' && p !== 'omlx') {
    return async () => ({ status: 'unavailable', reason: `unsupported_review_provider: ${p || 'none'}` })
  }
  const apiKey = p === 'moonshot'
    ? asStr(env.MOONSHOT_API_KEY)
    : (asStr(env.LOCALOXML_API_KEY) || asStr(env.STUDIO_AI_API_KEY) || asStr(env.OPENAI_API_KEY))
  if (!apiKey) {
    return async () => ({ status: 'unavailable', reason: p === 'moonshot' ? 'missing_moonshot_api_key' : 'missing_omlx_api_key' })
  }
  const baseUrl = asStr(apiUrl) || (p === 'moonshot' ? 'https://api.kimi.com/coding/v1' : 'http://127.0.0.1:18888/v1')
  const reviewModel = asStr(model) || (p === 'moonshot' ? 'kimi-for-coding' : 'Qwen3.6-27B-4bit')
  return async ({ node, observed, screenshotPath }) => {
    const buf = await readFile(screenshotPath)
    const imageDataUrl = `data:image/png;base64,${buf.toString('base64')}`
    const placements = (Array.isArray(node && node.visuals && node.visuals.placements) ? node.visuals.placements : [])
      .filter((x) => x && x.visible !== false)
    const parsed = await reviewNodeScreenshotWithVision({
      provider: p,
      apiKey,
      baseUrl,
      model: reviewModel,
      imageDataUrl,
      timeoutMs,
      fetchImpl,
      nodeContext: {
        nodeId: asStr(node && node.id),
        name: asStr(node && node.name),
        kind: asStr(node && node.kind) === 'ending' ? 'ending' : 'scene',
        text: asStr(observed && observed.dialogText) || asStr(node && node.body && node.body.text),
        backgroundExpected: Boolean(asStr(node && node.visuals && node.visuals.backgroundAssetId)),
        placementsExpected: placements.length
      }
    })
    return { status: 'completed', ...parsed }
  }
}

// ---------------------------------------------------------------------------
// 汇总判定（纯函数）
// ---------------------------------------------------------------------------

export function summarizeCompleteness(reports) {
  const list = Array.isArray(reports) ? reports : []
  const failedNodes = []
  let aiCompleted = 0
  let aiUnavailable = 0
  let aiFailed = 0
  for (const r of list) {
    const reasons = (Array.isArray(r.issues) ? r.issues : []).map((i) => `${i.code}: ${i.message}`)
    const review = r.aiReview && typeof r.aiReview === 'object' ? r.aiReview : null
    if (review && review.status === 'completed') {
      aiCompleted += 1
      if (review.passed === false) {
        aiFailed += 1
        reasons.push(`ai_review_failed: ${asStr(review.summary) || '视觉评审未通过'}（score=${review.score}）`)
      }
    } else if (review && review.status === 'unavailable') {
      aiUnavailable += 1
    }
    if (reasons.length) failedNodes.push({ nodeId: r.nodeId, name: asStr(r.name), reasons })
  }
  const attempted = aiCompleted + aiUnavailable
  const aiReviewStatus = !attempted ? 'skipped' : aiUnavailable === 0 ? 'completed' : aiCompleted === 0 ? 'unavailable' : 'partial'
  return {
    verdict: failedNodes.length ? 'fail' : 'pass',
    aiReviewStatus,
    summary: {
      total: list.length,
      visited: list.filter((r) => r.reachable).length,
      passed: list.length - failedNodes.length,
      failed: failedNodes.length,
      unreachableStatic: list.filter((r) => !r.reachable && r.pathLength === -1).length,
      aiReview: { completed: aiCompleted, unavailable: aiUnavailable, failed: aiFailed }
    },
    failedNodes
  }
}

// ---------------------------------------------------------------------------
// 浏览器启动（puppeteer-core 驱动本机 Chrome；动态 import，缺依赖时给出明确错误）
// ---------------------------------------------------------------------------

export function resolveChromeExecutablePath(env = process.env) {
  const fromEnv = asStr(env.STUDIO_CHROME_PATH)
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser'
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return ''
}

export function createPuppeteerBrowserLauncher({ executablePath } = {}) {
  return async () => {
    let puppeteer
    try {
      puppeteer = (await import('puppeteer-core')).default
    } catch (_) {
      throw new Error('puppeteer_core_missing: 未安装 puppeteer-core，无法驱动浏览器走查')
    }
    const exe = asStr(executablePath) || resolveChromeExecutablePath()
    if (!exe) throw new Error('chrome_not_found: 未找到本机 Chrome（可设 STUDIO_CHROME_PATH 指定）')
    return puppeteer.launch({
      executablePath: exe,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio']
    })
  }
}

// ---------------------------------------------------------------------------
// 编排：图构建 → 浏览器走查 → 汇总 → 报告原子落盘
// ---------------------------------------------------------------------------

export async function runStoryCompletenessCheck({
  projectId,
  dir,
  story,
  project,
  distUrl,
  launchBrowser,
  reviewer = null,
  reviewMeta = null,
  timestamp = compactTimestamp(),
  settleMs,
  arrivalTimeoutMs,
  navTimeoutMs,
  sleep = defaultSleep,
  onProgress = null
}) {
  const graph = buildStoryNodeGraph(story)
  if (!graph.nodes.length || !graph.startNodeId) {
    throw new Error('empty_story: story.json 无节点或缺少 startNodeId')
  }
  const assetIndex = buildAssetIndex(project)
  const characterIndex = buildCharacterIndex(project)
  const runDir = path.join(dir, 'reviews', 'completeness', timestamp)
  await mkdir(runDir, { recursive: true })

  const effectiveReviewer = reviewer || (async () => ({ status: 'unavailable', reason: 'missing_moonshot_api_key' }))
  let reports
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    if (typeof page.setViewport === 'function') {
      await page.setViewport({ width: 960, height: 1280, deviceScaleFactor: 1 })
    }
    const sink = { currentTag: '', consoleErrors: [], failedRequests: [] }
    attachPageObservers(page, sink)
    reports = await walkStoryPlayer({
      page,
      graph,
      distUrl,
      screenshotDir: runDir,
      assetIndex,
      characterIndex,
      reviewer: effectiveReviewer,
      sink,
      settleMs,
      arrivalTimeoutMs,
      navTimeoutMs,
      sleep,
      onNodeDone: onProgress
    })
  } finally {
    await browser.close().catch(() => {})
  }

  const { verdict, aiReviewStatus, summary, failedNodes } = summarizeCompleteness(reports)
  const report = {
    schemaVersion: '1.0',
    kind: COMPLETENESS_TASK_KIND,
    projectId: asStr(projectId),
    checkedAt: nowIso(),
    runId: asStr(timestamp),
    screenshotDir: path.relative(dir, runDir).replace(/\\/g, '/'),
    distUrl: asStr(distUrl),
    review: reviewMeta && typeof reviewMeta === 'object'
      ? { provider: asStr(reviewMeta.provider), model: asStr(reviewMeta.model), apiUrl: asStr(reviewMeta.apiUrl) }
      : null,
    verdict,
    aiReviewStatus,
    summary,
    failedNodes,
    nodes: reports
  }
  const reportPath = path.join(dir, 'reviews', `completeness_${timestamp}.json`)
  const tmp = `${reportPath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(report, null, 2))
  await rename(tmp, reportPath)
  return { report, reportPath, runDir }
}

// 读取最近一次报告（文件名时间戳可排序；排除未完成的 tmp 文件）
export async function loadLatestCompletenessReport(dir) {
  const reviewsDir = path.join(dir, 'reviews')
  let entries = []
  try {
    entries = await readdir(reviewsDir)
  } catch (_) {
    return null
  }
  const files = entries
    .filter((name) => /^completeness_\d{8}T\d{6}Z\.json$/.test(name))
    .sort()
    .reverse()
  if (!files.length) return null
  try {
    const report = JSON.parse(await readFile(path.join(reviewsDir, files[0]), 'utf-8'))
    return { report, file: `reviews/${files[0]}` }
  } catch (_) {
    return null
  }
}
