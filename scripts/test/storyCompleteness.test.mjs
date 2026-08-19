import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// AUTO-E05：故事完整度核实。
// 覆盖路径：
// - 图构建：BFS 最短路径、同文本选项 ordinal、孤儿节点识别、startNode 兜底
// - 确定性检查：全部问题码（背景缺失/加载失败、立绘缺失/加载失败、空文本、死胡同、
//   选项按钮缺失、结尾 UI 缺失、console 错误、运行时/静态不可达、到达未确认）
// - 汇总判定：pass/fail、aiReviewStatus completed/partial/unavailable/skipped、ai_review_failed 归因
// - Kimi 评审：fake fetch 覆盖成功解析（含 markdown 围栏）、HTTP 失败、非法 JSON；
//   无 API key → reviewer 为 null（如实降级，不伪造评审）
// - 浏览器遍历：fake page 驱动真实 walk 逻辑（DFS 重放、截图留证、事件按节点归账、
//   隐藏按钮导致运行时不可达、文本篡改导致到达未确认）
// - 编排落盘：报告原子写入 reviews/completeness_<ts>.json、截图目录、latest 读取
// 环境说明：不启动真实 Chrome、不访问真实 Kimi；浏览器/网络均注入 fake，
// 被验证的遍历/判定/落盘逻辑为真实实现，未伪造任何评审结论。

const TMP = await mkdtemp(path.join(os.tmpdir(), 'gs-e05-'))

const {
  buildStoryNodeGraph,
  expectedNodeTextHint,
  assetTailFromUri,
  buildAssetIndex,
  buildCharacterIndex,
  evaluateNodeDeterministicChecks,
  walkStoryPlayer,
  reviewNodeScreenshotWithVision,
  createNodeVisualReviewer,
  resolveReviewConfig,
  normalizeCompletenessAiReview,
  summarizeCompleteness,
  runStoryCompletenessCheck,
  loadLatestCompletenessReport,
  observePlayerState,
  clickChoiceButtonByText,
  waitForFontsReady
} = await import('../../apps/server/src/ai/storyCompleteness.js')

// 1x1 透明 PNG（真实图片字节，截图夹具）
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const noSleep = async () => {}

// ---------------------------------------------------------------------------
// 夹具：健康的故事图（6 节点：开场 → A/B 两线 → 双结局 + 1 孤儿节点）
// ---------------------------------------------------------------------------
function makeStory() {
  return {
    schemaVersion: '1.0',
    startNodeId: 'n_start',
    nodes: [
      {
        id: 'n_start', name: '开场', kind: 'scene',
        body: { text: '阳光洒在山坡上，牧童在放羊。' },
        visuals: { backgroundAssetId: 'asset_bg', placements: [{ characterId: 'char_a', imageAssetId: 'asset_sprite_a', visible: true }] },
        choices: [
          { id: 'c1', text: '去A', toNodeId: 'n_a', effects: [], visibleWhen: null, enabledWhen: null },
          { id: 'c2', text: '去B', toNodeId: 'n_b', effects: [], visibleWhen: null, enabledWhen: null }
        ]
      },
      {
        id: 'n_a', name: 'A线', kind: 'scene',
        body: { text: '牧童大喊狼来了。' },
        visuals: { backgroundAssetId: 'asset_bg', placements: [] },
        choices: [{ id: 'c3', text: '继续', toNodeId: 'n_end_a' }]
      },
      {
        id: 'n_b', name: 'B线', kind: 'scene',
        body: { text: '牧童安静放羊。' },
        visuals: { backgroundAssetId: 'asset_bg', placements: [{ characterId: 'char_b', imageAssetId: 'asset_sprite_b', visible: true }] },
        choices: [{ id: 'c4', text: '继续', toNodeId: 'n_end_b' }]
      },
      {
        id: 'n_end_a', name: '结局A', kind: 'ending',
        body: { text: '结局A文本。' },
        timeline: { steps: [{ id: 's1', actions: [{ type: 'ui.showEndingCard', card: { moral: '诚实才有信任。' } }], advance: { type: 'end' } }] },
        visuals: { backgroundAssetId: 'asset_bg', placements: [] },
        choices: []
      },
      {
        id: 'n_end_b', name: '结局B', kind: 'ending',
        body: { text: '牧童付出了代价。' },
        visuals: { backgroundAssetId: 'asset_bg', placements: [] },
        choices: []
      },
      { id: 'n_orphan', name: '孤儿', kind: 'scene', body: { text: '无人到达。' }, visuals: {}, choices: [] }
    ]
  }
}

function makeProject() {
  return {
    id: 'proj_e05',
    assets: [
      { id: 'asset_bg', uri: 'assets/ai/bg.png' },
      { id: 'asset_sprite_a', uri: 'assets/ai/sprite_a.png' },
      { id: 'asset_sprite_b', uri: 'assets/ai/sprite_b.png' }
    ],
    characters: [
      { id: 'char_a', imageAssetId: 'asset_sprite_a' },
      { id: 'char_b', imageAssetId: 'asset_sprite_b' }
    ]
  }
}

// 无孤儿版本：verdict pass 用例专用（孤儿节点按契约计 fail）
function makeStoryNoOrphan() {
  const s = makeStory()
  s.nodes = s.nodes.filter((n) => n.id !== 'n_orphan')
  return s
}

function healthyObserved(overrides = {}) {
  return {
    canvasExists: true,
    canvasWidth: 960,
    canvasHeight: 1280,
    dialogText: '一段可见文本',
    dialogVisible: true,
    nodeTitle: '',
    endingVisible: false,
    actionsVisible: false,
    choiceButtons: [{ text: '继续', disabled: false }],
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// fake page：实现 walk 依赖的最小接口（goto/evaluate/screenshot/on/setViewport），
// 内部用故事图模拟播放器状态机；evaluate 按导出函数名分发，walk 逻辑为真实实现。
// ---------------------------------------------------------------------------
function makeFakePage(story, {
  textOverrides = {},
  hiddenButtons = [],
  consoleErrorsOn = {},
  failedRequestsOn = {}
} = {}) {
  const nodeMap = new Map(story.nodes.map((n) => [n.id, n]))
  const handlers = {}
  const screenshots = []
  let current = story.startNodeId

  const fire = (evt, ...args) => {
    for (const fn of handlers[evt] || []) fn(...args)
  }
  const arriveAt = (nodeId) => {
    current = nodeId
    for (const t of consoleErrorsOn[nodeId] || []) fire('console', { type: () => 'error', text: () => t })
    for (const r of failedRequestsOn[nodeId] || []) fire('response', { status: () => r.status, url: () => r.url })
  }

  const renderedButtons = () => {
    const node = nodeMap.get(current)
    if (!node) return []
    if (node.kind === 'ending') return [{ text: '重新开始', disabled: false }]
    const choices = Array.isArray(node.choices) ? node.choices : []
    const hidden = hiddenButtons.filter((h) => h.nodeId === current).map((h) => h.text)
    return choices.filter((c) => !hidden.includes(c.text)).map((c) => ({ text: c.text, disabled: false }))
  }

  const stateFor = () => {
    const node = nodeMap.get(current)
    const text = Object.prototype.hasOwnProperty.call(textOverrides, current)
      ? textOverrides[current]
      : expectedNodeTextHint(node)
    return {
      canvasExists: true,
      canvasWidth: 960,
      canvasHeight: 1280,
      dialogText: text,
      dialogVisible: Boolean(text),
      nodeTitle: '',
      endingVisible: false,
      actionsVisible: false,
      choiceButtons: renderedButtons()
    }
  }

  return {
    screenshots,
    async on() {},
    on(evt, fn) {
      if (!handlers[evt]) handlers[evt] = []
      handlers[evt].push(fn)
    },
    async setViewport() {},
    async goto() {
      arriveAt(story.startNodeId)
    },
    async evaluate(fn, arg) {
      if (fn === observePlayerState || fn.name === 'observePlayerState') return stateFor()
      if (fn === waitForFontsReady || fn.name === 'waitForFontsReady') return true
      if (fn === clickChoiceButtonByText || fn.name === 'clickChoiceButtonByText') {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
        const buttons = renderedButtons()
        const rendered = buttons.map((b) => ({ ...b }))
        const node = nodeMap.get(current)
        const choices = node && Array.isArray(node.choices) ? node.choices : []
        const hidden = hiddenButtons.filter((h) => h.nodeId === current).map((h) => h.text)
        const visibleChoices = choices.filter((c) => !hidden.includes(c.text))
        const matches = visibleChoices.filter((c) => norm(c.text) === norm(arg && arg.text))
        const choice = matches[Math.max(0, Number(arg && arg.ordinal) || 0)] || null
        if (!choice) return { clicked: false, reason: 'not_found', rendered }
        arriveAt(choice.toNodeId)
        return { clicked: true, rendered }
      }
      throw new Error(`fake page 未实现的 evaluate: ${fn && fn.name}`)
    },
    async screenshot({ path: p }) {
      screenshots.push(p)
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, PNG_BYTES)
    }
  }
}

function makeFakeBrowser(page) {
  return {
    closed: false,
    async newPage() { return page },
    async close() { this.closed = true }
  }
}

const passReviewer = async ({ node }) => ({ status: 'completed', passed: true, score: 90, issues: [], summary: `${node.id} ok` })

// ---------------------------------------------------------------------------
// 图构建
// ---------------------------------------------------------------------------
test('buildStoryNodeGraph：BFS 路径、孤儿节点、startNode 兜底', () => {
  const graph = buildStoryNodeGraph(makeStory())
  assert.equal(graph.startNodeId, 'n_start')
  assert.deepEqual(graph.visitOrder, ['n_start', 'n_a', 'n_b', 'n_end_a', 'n_end_b'])
  assert.deepEqual(graph.unreachableNodeIds, ['n_orphan'])
  assert.equal(graph.paths.get('n_start').length, 0)
  assert.equal(graph.paths.get('n_end_a').length, 2)
  assert.equal(graph.paths.get('n_end_a')[0].choiceText, '去A')
  assert.equal(graph.paths.get('n_end_a')[1].fromNodeId, 'n_a')

  // startNodeId 缺失时回退首节点
  const s = makeStory()
  delete s.startNodeId
  const g2 = buildStoryNodeGraph(s)
  assert.equal(g2.startNodeId, 'n_start')

  // 同文本选项：ordinal 递增，分别指向不同目标
  const dup = {
    startNodeId: 'x',
    nodes: [
      { id: 'x', kind: 'scene', body: { text: 'x' }, choices: [
        { text: '同文', toNodeId: 'y1' },
        { text: '同文', toNodeId: 'y2' }
      ] },
      { id: 'y1', kind: 'ending', body: { text: 'y1' }, choices: [] },
      { id: 'y2', kind: 'ending', body: { text: 'y2' }, choices: [] }
    ]
  }
  const g3 = buildStoryNodeGraph(dup)
  assert.equal(g3.paths.get('y1')[0].ordinal, 0)
  assert.equal(g3.paths.get('y2')[0].ordinal, 1)
})

test('expectedNodeTextHint：timeline setText / endingCard moral / body 兜底', () => {
  assert.equal(expectedNodeTextHint(makeStory().nodes[0]), '阳光洒在山坡上，牧童在放羊。')
  assert.equal(expectedNodeTextHint(makeStory().nodes[3]), '诚实才有信任。')
  assert.equal(expectedNodeTextHint(makeStory().nodes[4]), '牧童付出了代价。')
  assert.equal(expectedNodeTextHint({ id: 'z', kind: 'scene', body: {} }), '')
})

test('assetTailFromUri：归一各种 uri 形态', () => {
  assert.equal(assetTailFromUri('assets/ai/bg.png'), 'assets/ai/bg.png')
  assert.equal(assetTailFromUri('/project-assets/pid/assets/ai/bg.png'), 'assets/ai/bg.png')
  assert.equal(assetTailFromUri('./assets/bg.png'), 'assets/bg.png')
  assert.equal(assetTailFromUri(''), '')
})

// ---------------------------------------------------------------------------
// 确定性检查：全问题码
// ---------------------------------------------------------------------------
test('evaluateNodeDeterministicChecks：健康节点零问题', () => {
  const story = makeStory()
  const project = makeProject()
  const { issues, checks } = evaluateNodeDeterministicChecks({
    node: story.nodes[0],
    observed: healthyObserved({ choiceButtons: [{ text: '去A', disabled: false }, { text: '去B', disabled: false }] }),
    assetIndex: buildAssetIndex(project),
    characterIndex: buildCharacterIndex(project)
  })
  assert.deepEqual(issues, [])
  assert.equal(checks.background, 'ok')
  assert.equal(checks.sprites, 'ok')
})

test('evaluateNodeDeterministicChecks：背景缺失与加载失败', () => {
  const project = makeProject()
  const assetIndex = buildAssetIndex(project)
  const characterIndex = buildCharacterIndex(project)
  const node = { id: 'n', kind: 'scene', body: { text: 't' }, visuals: {}, choices: [{ text: 'go', toNodeId: 'm' }] }
  // 未绑定背景 → 占位符
  let r = evaluateNodeDeterministicChecks({ node, observed: healthyObserved(), assetIndex, characterIndex })
  assert.ok(r.issues.some((i) => i.code === 'background_missing'))
  // 绑定了项目里不存在的资产
  r = evaluateNodeDeterministicChecks({ node: { ...node, visuals: { backgroundAssetId: 'asset_ghost' } }, observed: healthyObserved(), assetIndex, characterIndex })
  assert.ok(r.issues.some((i) => i.code === 'background_missing'))
  // 请求 404
  r = evaluateNodeDeterministicChecks({
    node: { ...node, visuals: { backgroundAssetId: 'asset_bg' } },
    observed: healthyObserved(),
    assetIndex,
    characterIndex,
    failedRequests: [{ url: 'http://127.0.0.1:1999/demos/p/latest/dist/assets/ai/bg.png', status: 404 }]
  })
  assert.ok(r.issues.some((i) => i.code === 'background_load_failed'))
  assert.equal(r.checks.background, 'load_failed')
})

test('evaluateNodeDeterministicChecks：立绘缺失与加载失败', () => {
  const project = makeProject()
  const assetIndex = buildAssetIndex(project)
  const characterIndex = buildCharacterIndex(project)
  const node = {
    id: 'n', kind: 'scene', body: { text: 't' },
    visuals: {
      backgroundAssetId: 'asset_bg',
      placements: [
        { characterId: 'char_ghost', imageAssetId: '', visible: true }, // 角色无立绘资产
        { characterId: 'char_a', imageAssetId: 'asset_sprite_a', visible: true },
        { characterId: 'char_hidden', imageAssetId: '', visible: false } // 隐藏不计
      ]
    },
    choices: [{ text: 'go', toNodeId: 'm' }]
  }
  const r = evaluateNodeDeterministicChecks({
    node,
    observed: healthyObserved(),
    assetIndex,
    characterIndex,
    failedRequests: [{ url: 'http://x/assets/ai/sprite_a.png', status: 0, error: 'net::ERR_CONNECTION_REFUSED' }]
  })
  const codes = r.issues.map((i) => i.code)
  assert.ok(codes.includes('sprite_missing'))
  assert.ok(codes.includes('sprite_load_failed'))
  assert.ok(!r.issues.some((i) => i.message.includes('char_hidden')))
})

test('evaluateNodeDeterministicChecks：文本/选项/结尾/console/可达性', () => {
  const project = makeProject()
  const assetIndex = buildAssetIndex(project)
  const characterIndex = buildCharacterIndex(project)
  const base = { id: 'n', kind: 'scene', body: { text: 't' }, visuals: { backgroundAssetId: 'asset_bg' }, choices: [{ text: 'go', toNodeId: 'm' }] }

  // 空文本
  let r = evaluateNodeDeterministicChecks({ node: base, observed: healthyObserved({ dialogText: '' }), assetIndex, characterIndex })
  assert.ok(r.issues.some((i) => i.code === 'dialog_text_empty'))
  // 死胡同
  r = evaluateNodeDeterministicChecks({ node: { ...base, choices: [] }, observed: healthyObserved({ choiceButtons: [] }), assetIndex, characterIndex })
  assert.ok(r.issues.some((i) => i.code === 'non_ending_no_choices'))
  // 选项按钮未渲染
  r = evaluateNodeDeterministicChecks({ node: base, observed: healthyObserved({ choiceButtons: [] }), assetIndex, characterIndex })
  assert.ok(r.issues.some((i) => i.code === 'choice_buttons_missing'))
  // 按钮全部禁用
  r = evaluateNodeDeterministicChecks({ node: base, observed: healthyObserved({ choiceButtons: [{ text: 'go', disabled: true }] }), assetIndex, characterIndex })
  assert.ok(r.issues.some((i) => i.code === 'choice_buttons_missing'))
  // 结尾 UI 缺失
  r = evaluateNodeDeterministicChecks({ node: { ...base, kind: 'ending', choices: [] }, observed: healthyObserved({ choiceButtons: [] }), assetIndex, characterIndex })
  assert.ok(r.issues.some((i) => i.code === 'ending_ui_missing'))
  // 结尾有重开按钮 → 正常
  r = evaluateNodeDeterministicChecks({ node: { ...base, kind: 'ending', choices: [] }, observed: healthyObserved({ choiceButtons: [{ text: '重新开始', disabled: false }] }), assetIndex, characterIndex })
  assert.ok(!r.issues.some((i) => i.code === 'ending_ui_missing'))
  // console 脚本错误 → 记账；资源加载错误 → 过滤（由 failedRequests 归账）
  r = evaluateNodeDeterministicChecks({
    node: base,
    observed: healthyObserved(),
    assetIndex,
    characterIndex,
    consoleErrors: [{ text: 'TypeError: boom' }, { text: 'Failed to load resource: the server responded with 404' }]
  })
  assert.ok(r.issues.some((i) => i.code === 'console_error' && i.message.includes('TypeError')))
  assert.equal(r.consoleErrors, undefined) // 归账在 walk 层，evaluate 不回传
  // 运行时不可达：只记不可达，不重复记其他项
  r = evaluateNodeDeterministicChecks({ node: base, observed: null, assetIndex, characterIndex, reachable: false, replayError: { code: 'choice_button_not_found', detail: 'x' } })
  assert.deepEqual(r.issues.map((i) => i.code), ['node_unreachable_runtime'])
  // 到达未确认
  r = evaluateNodeDeterministicChecks({ node: base, observed: healthyObserved(), assetIndex, characterIndex, arrivalConfirmed: false })
  assert.ok(r.issues.some((i) => i.code === 'arrival_unconfirmed'))
  // 画布缺失
  r = evaluateNodeDeterministicChecks({ node: base, observed: healthyObserved({ canvasExists: false }), assetIndex, characterIndex })
  assert.ok(r.issues.some((i) => i.code === 'canvas_missing'))
})

// ---------------------------------------------------------------------------
// 汇总判定
// ---------------------------------------------------------------------------
test('summarizeCompleteness：verdict 与 aiReviewStatus 全组合', () => {
  // 全通过 + 评审完成
  let r = summarizeCompleteness([
    { nodeId: 'a', reachable: true, pathLength: 0, issues: [], aiReview: { status: 'completed', passed: true, score: 90 } },
    { nodeId: 'b', reachable: true, pathLength: 1, issues: [], aiReview: { status: 'completed', passed: true, score: 80 } }
  ])
  assert.equal(r.verdict, 'pass')
  assert.equal(r.aiReviewStatus, 'completed')
  assert.equal(r.summary.failed, 0)

  // 确定性失败
  r = summarizeCompleteness([
    { nodeId: 'a', reachable: true, pathLength: 0, issues: [{ code: 'dialog_text_empty', message: '空' }], aiReview: { status: 'completed', passed: true, score: 90 } }
  ])
  assert.equal(r.verdict, 'fail')
  assert.equal(r.failedNodes[0].nodeId, 'a')

  // AI 评审判失败 → ai_review_failed 归因
  r = summarizeCompleteness([
    { nodeId: 'a', reachable: true, pathLength: 0, issues: [], aiReview: { status: 'completed', passed: false, score: 30, summary: '白底框' } }
  ])
  assert.equal(r.verdict, 'fail')
  assert.ok(r.failedNodes[0].reasons.some((x) => x.startsWith('ai_review_failed')))
  assert.equal(r.summary.aiReview.failed, 1)

  // 部分不可用 → partial；全部不可用 → unavailable（不影响 verdict）
  r = summarizeCompleteness([
    { nodeId: 'a', reachable: true, pathLength: 0, issues: [], aiReview: { status: 'completed', passed: true, score: 90 } },
    { nodeId: 'b', reachable: true, pathLength: 1, issues: [], aiReview: { status: 'unavailable', reason: 'timeout' } }
  ])
  assert.equal(r.aiReviewStatus, 'partial')
  assert.equal(r.verdict, 'pass')
  r = summarizeCompleteness([
    { nodeId: 'a', reachable: true, pathLength: 0, issues: [], aiReview: { status: 'unavailable', reason: 'missing_moonshot_api_key' } }
  ])
  assert.equal(r.aiReviewStatus, 'unavailable')
  assert.equal(r.verdict, 'pass')

  // 静态不可达计数
  r = summarizeCompleteness([
    { nodeId: 'a', reachable: true, pathLength: 0, issues: [], aiReview: { status: 'skipped', reason: 'x' } },
    { nodeId: 'orphan', reachable: false, pathLength: -1, issues: [{ code: 'node_unreachable_static', message: '孤儿' }], aiReview: { status: 'skipped', reason: 'node_unreachable' } }
  ])
  assert.equal(r.summary.unreachableStatic, 1)
  assert.equal(r.aiReviewStatus, 'skipped')
  assert.equal(r.verdict, 'fail')
})

// ---------------------------------------------------------------------------
// 视觉评审（fake fetch，不访问真实网络）
// ---------------------------------------------------------------------------
test('reviewNodeScreenshotWithVision：moonshot 成功解析（含 markdown 围栏），temperature=1', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body)
    assert.equal(body.model, 'kimi-for-coding')
    assert.equal(body.temperature, 1) // kimi-for-coding 唯一允许值
    assert.ok(body.messages[1].content.some((p) => p.type === 'image_url'))
    assert.ok(url.endsWith('/chat/completions'))
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '```json\n{"passed":false,"score":35,"issues":["立绘有白底框"],"summary":"立绘合成不自然"}\n```' } }] })
    }
  }
  const r = await reviewNodeScreenshotWithVision({
    provider: 'moonshot', apiKey: 'k', baseUrl: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding',
    imageDataUrl: 'data:image/png;base64,xxxx', nodeContext: { nodeId: 'n', text: 't' }, fetchImpl
  })
  assert.equal(r.passed, false)
  assert.equal(r.score, 35)
  assert.deepEqual(r.issues, ['立绘有白底框'])
})

test('reviewNodeScreenshotWithVision：HTTP 失败与非法输出均抛错（由调用方降级）', async () => {
  await assert.rejects(
    () => reviewNodeScreenshotWithVision({
      provider: 'moonshot', apiKey: 'k', baseUrl: 'https://x/v1', imageDataUrl: 'data:image/png;base64,x',
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'image_url not supported' } }) })
    }),
    /image_url not supported/
  )
  await assert.rejects(
    () => reviewNodeScreenshotWithVision({
      provider: 'moonshot', apiKey: 'k', baseUrl: 'https://x/v1', imageDataUrl: 'data:image/png;base64,x',
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '这不是JSON' } }] }) })
    })
  )
})

test('reviewNodeScreenshotWithVision：omlx 不传 temperature，端点解析正确', async () => {
  let seenBody = null
  let seenUrl = ''
  const r = await reviewNodeScreenshotWithVision({
    provider: 'omlx', apiKey: 'k', baseUrl: 'http://127.0.0.1:18888/v1', model: 'Qwen3.6-27B-4bit',
    imageDataUrl: 'data:image/png;base64,x', nodeContext: { nodeId: 'n' },
    fetchImpl: async (url, opts) => {
      seenUrl = url
      seenBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"passed":true,"score":88,"issues":[],"summary":"ok"}' } }] }) }
    }
  })
  assert.equal(seenUrl, 'http://127.0.0.1:18888/v1/chat/completions')
  assert.equal(seenBody.model, 'Qwen3.6-27B-4bit')
  assert.equal('temperature' in seenBody, false) // omlx 走服务端默认
  assert.equal(r.passed, true)
  assert.equal(r.score, 88)
})

test('resolveReviewConfig：body 覆盖 > settings review 段 > 环境默认', () => {
  // 环境默认：有 MOONSHOT_API_KEY → moonshot/kimi-for-coding/kimi 端点
  let r = resolveReviewConfig({ env: { MOONSHOT_API_KEY: 'k' } })
  assert.deepEqual(r, { provider: 'moonshot', model: 'kimi-for-coding', apiUrl: 'https://api.kimi.com/coding/v1' })
  // settings review 段覆盖默认
  r = resolveReviewConfig({ studioEffective: { review: { provider: 'omlx', model: 'Qwen3.6-27B-4bit', apiUrl: 'http://127.0.0.1:18888/v1' } }, env: {} })
  assert.deepEqual(r, { provider: 'omlx', model: 'Qwen3.6-27B-4bit', apiUrl: 'http://127.0.0.1:18888/v1' })
  // body 覆盖 settings（provider 相同：继承 settings 的 url，model 被 body 覆盖）
  r = resolveReviewConfig({
    studioEffective: { review: { provider: 'moonshot', model: 'm1', apiUrl: 'http://a/v1' } },
    body: { provider: 'moonshot', model: 'kimi-for-coding' },
    env: {}
  })
  assert.equal(r.provider, 'moonshot')
  assert.equal(r.model, 'kimi-for-coding')
  assert.equal(r.apiUrl, 'http://a/v1')
  // body 改 provider 与 settings 不同：model/apiUrl 必须回落 omlx 默认，不得继承 moonshot 配置
  r = resolveReviewConfig({
    studioEffective: { review: { provider: 'moonshot', model: 'kimi-for-coding', apiUrl: 'https://api.kimi.com/coding/v1' } },
    body: { provider: 'omlx' },
    env: {}
  })
  assert.deepEqual(r, { provider: 'omlx', model: 'Qwen3.6-27B-4bit', apiUrl: 'http://127.0.0.1:18888/v1' })
  // omlx 无配置时的环境默认
  r = resolveReviewConfig({ body: { provider: 'omlx' }, env: {} })
  assert.equal(r.model, 'Qwen3.6-27B-4bit')
  assert.equal(r.apiUrl, 'http://127.0.0.1:18888/v1')
  // 无任何配置 → provider 空串（由评审器如实记 unavailable）
  r = resolveReviewConfig({ env: {} })
  assert.equal(r.provider, '')
})

test('createNodeVisualReviewer：配置问题如实记 unavailable，不伪造评审', async () => {
  // 不支持的 provider
  let reviewer = createNodeVisualReviewer({ provider: 'openai', env: {} })
  let r = await reviewer({ node: makeStory().nodes[0], observed: healthyObserved(), screenshotPath: '/tmp/x.png' })
  assert.equal(r.status, 'unavailable')
  assert.ok(r.reason.includes('unsupported_review_provider'))
  // moonshot 缺 key
  reviewer = createNodeVisualReviewer({ provider: 'moonshot', env: {} })
  r = await reviewer({ node: makeStory().nodes[0], observed: healthyObserved(), screenshotPath: '/tmp/x.png' })
  assert.deepEqual(r, { status: 'unavailable', reason: 'missing_moonshot_api_key' })
  // omlx 缺 key
  reviewer = createNodeVisualReviewer({ provider: 'omlx', env: {} })
  r = await reviewer({ node: makeStory().nodes[0], observed: healthyObserved(), screenshotPath: '/tmp/x.png' })
  assert.deepEqual(r, { status: 'unavailable', reason: 'missing_omlx_api_key' })
})

test('createNodeVisualReviewer：omlx 读截图发评审（fake fetch）', async () => {
  const shotDir = await mkdtemp(path.join(TMP, 'shot-omlx-'))
  const shotPath = path.join(shotDir, 'node_n.png')
  await writeFile(shotPath, PNG_BYTES)
  const reviewer = createNodeVisualReviewer({
    provider: 'omlx',
    model: 'Qwen3.6-27B-4bit',
    apiUrl: 'http://127.0.0.1:18888/v1',
    env: { LOCALOXML_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"passed":true,"score":76,"issues":[],"summary":"画面完整"}' } }] }) })
  })
  const r = await reviewer({ node: makeStory().nodes[0], observed: healthyObserved(), screenshotPath: shotPath })
  assert.equal(r.status, 'completed')
  assert.equal(r.passed, true)
  assert.equal(r.score, 76)
})

test('normalizeCompletenessAiReview：字段兜底与分数钳制', () => {
  assert.equal(normalizeCompletenessAiReview(null), null)
  const r = normalizeCompletenessAiReview({ score: 45 })
  assert.equal(r.passed, false) // 无 passed 时按 score>=60 推导
  assert.equal(r.score, 45)
  assert.ok(r.summary.length > 0)
  const r2 = normalizeCompletenessAiReview({ passed: true, score: 280, problems: '小问题' })
  assert.equal(r2.score, 100)
  assert.deepEqual(r2.issues, ['小问题'])
})

test('createNodeVisualReviewer：moonshot 读截图发评审（fake fetch）', async () => {
  const shotDir = await mkdtemp(path.join(TMP, 'shot-'))
  const shotPath = path.join(shotDir, 'node_n.png')
  await writeFile(shotPath, PNG_BYTES)
  const reviewer = createNodeVisualReviewer({
    provider: 'moonshot',
    apiUrl: 'https://x/v1',
    env: { MOONSHOT_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"passed":true,"score":92,"issues":[],"summary":"画面完整"}' } }] }) })
  })
  const r = await reviewer({ node: makeStory().nodes[0], observed: healthyObserved(), screenshotPath: shotPath })
  assert.equal(r.status, 'completed')
  assert.equal(r.passed, true)
  assert.equal(r.score, 92)
})

// ---------------------------------------------------------------------------
// 浏览器遍历（fake page 驱动真实 walk）
// ---------------------------------------------------------------------------
test('walkStoryPlayer：全覆盖走查、截图留证、评审逐节点调用', async () => {
  const story = makeStory()
  const project = makeProject()
  const graph = buildStoryNodeGraph(story)
  const page = makeFakePage(story)
  const sink = { currentTag: '', consoleErrors: [], failedRequests: [] }
  const reviewed = []
  const progress = []
  const shotDir = await mkdtemp(path.join(TMP, 'walk-'))
  const reports = await walkStoryPlayer({
    page,
    graph,
    distUrl: 'http://fake/dist/index.html',
    screenshotDir: shotDir,
    assetIndex: buildAssetIndex(project),
    characterIndex: buildCharacterIndex(project),
    reviewer: async ({ node, screenshotPath }) => {
      reviewed.push(node.id)
      await access(screenshotPath) // 评审时截图必须已落盘
      return passReviewer({ node })
    },
    sink,
    onNodeDone: ({ nodeId, index, total }) => progress.push({ nodeId, index, total }),
    sleep: noSleep
  })
  assert.equal(reports.length, 6) // 5 可达 + 1 孤儿
  const byId = new Map(reports.map((r) => [r.nodeId, r]))
  assert.equal(byId.get('n_start').reachable, true)
  assert.deepEqual(byId.get('n_start').issues, [])
  assert.equal(byId.get('n_end_a').pathLength, 2)
  assert.equal(byId.get('n_orphan').reachable, false)
  assert.equal(byId.get('n_orphan').issues[0].code, 'node_unreachable_static')
  assert.equal(byId.get('n_orphan').aiReview.status, 'skipped')
  // 评审仅对到达节点执行
  assert.deepEqual(reviewed.sort(), ['n_a', 'n_b', 'n_end_a', 'n_end_b', 'n_start'])
  // 每个到达节点一张截图
  assert.equal(page.screenshots.length, 5)
  assert.ok(page.screenshots.some((p) => p.includes('node_n_start.png')))
  // 进度回调覆盖全部节点
  assert.equal(progress.length, 6)
  assert.equal(progress[5].total, 6)
})

test('walkStoryPlayer：隐藏按钮 → 运行时不可达；事件按节点归账', async () => {
  const story = makeStory()
  const project = makeProject()
  const graph = buildStoryNodeGraph(story)
  const page = makeFakePage(story, {
    hiddenButtons: [{ nodeId: 'n_start', text: '去B' }],
    consoleErrorsOn: { n_a: ['TypeError: boom'] },
    failedRequestsOn: { n_a: [{ url: 'http://fake/dist/assets/ai/bg.png', status: 404 }] }
  })
  const sink = { currentTag: '', consoleErrors: [], failedRequests: [] }
  const { attachPageObservers } = await import('../../apps/server/src/ai/storyCompleteness.js')
  attachPageObservers(page, sink)
  const shotDir = await mkdtemp(path.join(TMP, 'walk2-'))
  const reports = await walkStoryPlayer({
    page,
    graph,
    distUrl: 'http://fake/dist/index.html',
    screenshotDir: shotDir,
    assetIndex: buildAssetIndex(project),
    characterIndex: buildCharacterIndex(project),
    reviewer: passReviewer,
    sink,
    sleep: noSleep
  })
  const byId = new Map(reports.map((r) => [r.nodeId, r]))
  // 去B 按钮隐藏 → n_b 与 n_end_b 均运行时不可达
  assert.equal(byId.get('n_b').reachable, false)
  assert.equal(byId.get('n_b').issues[0].code, 'node_unreachable_runtime')
  assert.ok(byId.get('n_b').issues[0].message.includes('choice_button_not_found'))
  assert.equal(byId.get('n_end_b').reachable, false)
  // n_a：console 错误 + 背景 404 归账到该节点
  const codesA = byId.get('n_a').issues.map((i) => i.code)
  assert.ok(codesA.includes('console_error'))
  assert.ok(codesA.includes('background_load_failed'))
})

test('walkStoryPlayer：文本被篡改 → 到达未确认', async () => {
  const story = makeStory()
  const graph = buildStoryNodeGraph(story)
  const page = makeFakePage(story, { textOverrides: { n_a: '完全无关的内容' } })
  const shotDir = await mkdtemp(path.join(TMP, 'walk3-'))
  const reports = await walkStoryPlayer({
    page,
    graph,
    distUrl: 'http://fake/dist/index.html',
    screenshotDir: shotDir,
    assetIndex: buildAssetIndex(makeProject()),
    characterIndex: buildCharacterIndex(makeProject()),
    reviewer: passReviewer,
    sleep: noSleep,
    arrivalTimeoutMs: 300
  })
  const na = reports.find((r) => r.nodeId === 'n_a')
  assert.ok(na.issues.some((i) => i.code === 'arrival_unconfirmed'))
})

// ---------------------------------------------------------------------------
// 编排落盘 + latest 读取
// ---------------------------------------------------------------------------
test('runStoryCompletenessCheck：报告原子落盘、截图目录、verdict pass', async () => {
  const dir = await mkdtemp(path.join(TMP, 'proj-pass-'))
  const story = makeStoryNoOrphan()
  const page = makeFakePage(story)
  const browser = makeFakeBrowser(page)
  const progress = []
  const { report, reportPath, runDir } = await runStoryCompletenessCheck({
    projectId: 'proj_e05',
    dir,
    story,
    project: makeProject(),
    distUrl: 'http://fake/dist/index.html',
    launchBrowser: async () => browser,
    reviewer: passReviewer,
    reviewMeta: { provider: 'moonshot', model: 'kimi-for-coding', apiUrl: 'https://api.kimi.com/coding/v1' },
    timestamp: '20260817T010000Z',
    sleep: noSleep,
    arrivalTimeoutMs: 300,
    onProgress: ({ index, total, nodeId }) => progress.push({ index, total, nodeId })
  })
  assert.equal(report.verdict, 'pass')
  assert.equal(report.aiReviewStatus, 'completed')
  assert.equal(report.summary.total, 5)
  assert.equal(report.summary.visited, 5)
  assert.equal(report.summary.unreachableStatic, 0)
  assert.ok(browser.closed) // 浏览器必关，防泄漏
  // 报告与截图真实落盘
  const written = JSON.parse(await readFile(reportPath, 'utf-8'))
  assert.equal(written.kind, 'story.completeness_check')
  assert.equal(written.runId, '20260817T010000Z')
  assert.equal(written.screenshotDir, 'reviews/completeness/20260817T010000Z')
  assert.deepEqual(written.review, { provider: 'moonshot', model: 'kimi-for-coding', apiUrl: 'https://api.kimi.com/coding/v1' })
  assert.ok(reportPath.endsWith(path.join('reviews', 'completeness_20260817T010000Z.json')))
  await access(path.join(runDir, 'node_n_start.png'))
  await access(path.join(runDir, 'node_n_end_b.png'))
  assert.equal(progress.length, 5)
})

test('runStoryCompletenessCheck：确定性缺陷 → verdict fail 且归因到节点', async () => {
  const dir = await mkdtemp(path.join(TMP, 'proj-fail-'))
  const story = makeStoryNoOrphan()
  const page = makeFakePage(story, { textOverrides: { n_a: '' } }) // A 线文本为空
  const { report } = await runStoryCompletenessCheck({
    projectId: 'proj_e05',
    dir,
    story,
    project: makeProject(),
    distUrl: 'http://fake/dist/index.html',
    launchBrowser: async () => makeFakeBrowser(page),
    reviewer: passReviewer,
    timestamp: '20260817T010100Z',
    sleep: noSleep,
    arrivalTimeoutMs: 300
  })
  assert.equal(report.verdict, 'fail')
  const failed = report.failedNodes.find((n) => n.nodeId === 'n_a')
  assert.ok(failed)
  assert.ok(failed.reasons.some((r) => r.startsWith('dialog_text_empty')))
})

test('runStoryCompletenessCheck：无评审器 → 如实记 unavailable，不影响确定性判定', async () => {
  const dir = await mkdtemp(path.join(TMP, 'proj-noview-'))
  const story = makeStoryNoOrphan()
  const { report } = await runStoryCompletenessCheck({
    projectId: 'proj_e05',
    dir,
    story,
    project: makeProject(),
    distUrl: 'http://fake/dist/index.html',
    launchBrowser: async () => makeFakeBrowser(makeFakePage(story)),
    reviewer: null, // 等价于 missing_moonshot_api_key
    timestamp: '20260817T010200Z',
    sleep: noSleep,
    arrivalTimeoutMs: 300
  })
  assert.equal(report.aiReviewStatus, 'unavailable')
  assert.equal(report.verdict, 'pass') // 确定性检查全绿，评审缺失只记覆盖限制
  assert.ok(report.nodes.every((n) => n.aiReview.status !== 'completed'))
})

test('runStoryCompletenessCheck：空故事直接抛错，不产生报告', async () => {
  const dir = await mkdtemp(path.join(TMP, 'proj-empty-'))
  await assert.rejects(
    () => runStoryCompletenessCheck({
      projectId: 'x', dir, story: { nodes: [] }, project: {}, distUrl: 'http://fake/',
      launchBrowser: async () => makeFakeBrowser(makeFakePage(makeStory()))
    }),
    /empty_story/
  )
})

test('compactTimestamp：保留 Z 后缀且与 latest 正则兼容', async () => {
  const { compactTimestamp } = await import('../../apps/server/src/ai/storyCompleteness.js')
  const ts = compactTimestamp(new Date('2026-08-17T02:02:33.406Z'))
  assert.equal(ts, '20260817T020233Z')
  assert.ok(/^completeness_\d{8}T\d{6}Z\.json$/.test(`completeness_${ts}.json`))
})

test('loadLatestCompletenessReport：取最新报告，忽略 tmp，空目录返回 null', async () => {
  const dir = await mkdtemp(path.join(TMP, 'proj-latest-'))
  assert.equal(await loadLatestCompletenessReport(dir), null)
  const reviewsDir = path.join(dir, 'reviews')
  await mkdir(reviewsDir, { recursive: true })
  await writeFile(path.join(reviewsDir, 'completeness_20260817T010000Z.json'), JSON.stringify({ verdict: 'pass', checkedAt: 'a' }))
  await writeFile(path.join(reviewsDir, 'completeness_20260817T020000Z.json'), JSON.stringify({ verdict: 'fail', checkedAt: 'b' }))
  await writeFile(path.join(reviewsDir, 'completeness_20260817T030000Z.json.tmp-1-2'), '{}')
  const latest = await loadLatestCompletenessReport(dir)
  assert.equal(latest.report.verdict, 'fail')
  assert.equal(latest.file, 'reviews/completeness_20260817T020000Z.json')
})
