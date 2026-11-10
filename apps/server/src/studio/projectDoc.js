// 项目文档默认值/写入/阶段派生（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改）
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { normalizeProjectDoc } from './projectState.js'
import { existsFile, nowIso, readJson, writeJson } from './storeFs.js'

export function defaultStory() {
  return {
    schemaVersion: '2.0',
    startNodeId: 'start',
    nodes: [
      {
        id: 'start',
        name: '开始',
        kind: 'scene',
        body: { text: '这是一个新的故事。请在右侧属性面板编辑内容。' },
        timeline: {
          steps: [
            {
              id: 'st_start_1',
              actions: [{ type: 'ui.setText', mode: 'replace', text: '这是一个新的故事。请在右侧属性面板编辑内容。' }],
              advance: { type: 'choice' }
            }
          ]
        },
        choices: [
          { id: 'c1', text: '继续', toNodeId: 'end' }
        ],
        visuals: { placements: [] }
      },
      {
        id: 'end',
        name: '结局',
        kind: 'ending',
        body: { text: '故事结束。' },
        timeline: {
          steps: [
            {
              id: 'st_end_1',
              actions: [
                {
                  type: 'ui.showEndingCard',
                  card: {
                    title: '故事结束',
                    bullets: [],
                    moral: '故事结束。',
                    buttons: [
                      { type: 'restart', label: '重新开始' },
                      { type: 'backToHub', label: '返回工作台' }
                    ]
                  }
                }
              ],
              advance: { type: 'end' }
            }
          ]
        },
        visuals: { placements: [] }
      }
    ]
  }
}

export function defaultMeta({ id, title }) {
  return {
    schemaVersion: '1.0',
    id: String(id),
    title: String(title || ''),
    stage: 'script',
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
}

export function clampInt(x, min, max, fallback) {
  const n = Number(x)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

export function defaultScripts() {
  const id = `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return {
    schemaVersion: '1.0',
    cards: [
      {
        id,
        name: '脚本1',
        order: 1,
        text: '',
        updatedAt: nowIso()
      }
    ],
    updatedAt: nowIso()
  }
}

export function defaultBlueprint() {
  return {
    schemaVersion: '1.0',
    startNodeId: '',
    placeholders: [],
    nodes: [],
    updatedAt: nowIso()
  }
}

export async function writeAiDraftProject({ dir, id, title, formula, scripts, blueprint, projectBase = null }) {
  await mkdir(path.join(dir, 'assets'), { recursive: true })
  const project = normalizeProjectDoc(projectBase || {
    schemaVersion: '2.0',
    id,
    title,
    pluginId: 'story-pixi',
    pluginVersion: '0.1.0',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    characters: [],
    assets: [],
    events: [],
    state: { vars: [] }
  })
  await writeJson(path.join(dir, 'project.json'), project)
  await writeJson(path.join(dir, 'story.json'), defaultStory())
  await writeJson(path.join(dir, 'scripts.json'), scripts || defaultScripts())
  await writeJson(path.join(dir, 'blueprint.json'), blueprint || defaultBlueprint())
  await writeJson(path.join(dir, 'meta.json'), { ...defaultMeta({ id, title }), aiFormula: formula, aiDraftStatus: 'pending' })
  return project
}

export function normalizeProjectAndDetectChanges(project) {
  const before = project && typeof project === 'object' ? project : {}
  const after = normalizeProjectDoc(before)
  let changed = false
  try {
    changed = JSON.stringify(before?.state || null) !== JSON.stringify(after?.state || null)
  } catch (_) {
    changed = true
  }
  return { project: after, changed }
}

export async function touchProjectUpdatedAt(dir) {
  try {
    const curr = await readJson(path.join(dir, 'project.json'))
    await writeJson(path.join(dir, 'project.json'), { ...curr, updatedAt: nowIso() })
  } catch (_) {}

  try {
    const metaPath = path.join(dir, 'meta.json')
    const meta = (await existsFile(metaPath)) ? await readJson(metaPath) : null
    if (meta && typeof meta === 'object') {
      // 2026-09-27 F8：meta.json.stage 随写盘收口同步回写（创建时写 'script' 后无人更新），
      // 派生逻辑与 /api/projects/summary 的 Hub 展示值保持一致（deriveProjectStage 单一来源）
      const stage = await deriveProjectStageFromDisk(dir)
      await writeJson(metaPath, { ...meta, stage, updatedAt: nowIso() })
    }
  } catch (_) {}
}

// Q 波（2026-10-27 阶段梯子倒挂根修，用户实测：三只小猪无 dist 却显示「已导出」）：
// 旧口径把 !distExists 直接映射 export、前端再把 export 标成「已导出」——双重倒挂。
// 新口径=真实生产进度语义，逐级判定（单一来源，前端只翻译 stage 不自行推断）：
//   script   无脚本卡片
//   blueprint 蓝图结构未编译(nodes=0) 或 蓝图就绪未满（资产计划缺失/场景元素分析未覆盖/事物未全锁定/构图预演未覆盖；
//             口径参照 editor readiness.ts + StageStepper（K 波）的同源磁盘可判定字段；配音为全局开关增强项，不进阶段门槛）
//   compose  蓝图就绪但出图链未完（story 场景未编译出 或 场景图未齐）
//   export   生产齐（场景图齐）但无 dist → 前端标「已完成 · 待导出」
//   playable dist 存在 → 前端标「已导出 · 可试玩」（已导出=dist 存在，单一判定）
// planStats 派生：plan 存于 project.json state.aiBackground.storyAssetPlan（与 readiness.ts 同源）；
// 分析/构图分母只计蓝图场景幕（sceneNodeIds，结局条目永不分析/构图，计入会永远不满——StageStepper 2026-10-25 同款修正）。
export function derivePlanStats(plan, sceneNodeIds) {
  if (!plan || typeof plan !== 'object') return { exists: false, scenes: 0, analyzed: 0, locked: 0, totalAssets: 0, composed: 0 }
  const assets = Array.isArray(plan.assets) ? plan.assets : []
  const allScenes = Array.isArray(plan.scenes) ? plan.scenes : []
  const idSet = sceneNodeIds instanceof Set && sceneNodeIds.size ? sceneNodeIds : null
  const scenes = idSet ? allScenes.filter((s) => idSet.has(String(s?.sceneId || ''))) : allScenes
  const analyzed = scenes.filter((s) => String(s?.analyzedAt || '').trim() || (Array.isArray(s?.assetIds) && s.assetIds.length)).length
  const composed = scenes.filter((s) => s?.composition && Array.isArray(s.composition.items) && s.composition.items.length).length
  const locked = assets.filter((a) => a?.referenceStatus === 'ready' || Boolean(a?.primaryReferenceAssetId)).length
  return { exists: true, scenes: scenes.length, analyzed, locked, totalAssets: assets.length, composed }
}

// story.json 场景图覆盖（readiness.ts storyImageCoverage 同口径：结尾幕不计分母；全 ending 时回退全量）
export function deriveSceneStats(story) {
  const nodes = Array.isArray(story?.nodes) ? story.nodes : Object.values(story?.nodes || {})
  const scenes = nodes.filter((n) => String(n?.kind || 'scene') !== 'ending')
  const withImages = scenes.filter((n) => {
    const bgId = n?.visuals?.backgroundAssetId
    if (typeof bgId === 'string' && bgId.trim()) return true
    const bg = n?.visuals?.background ?? n?.background
    if (!bg) return false
    if (typeof bg === 'string') return bg.trim().length > 0
    if (typeof bg === 'object') return Boolean(bg.uri || bg.src || bg.url || bg.path)
    return false
  }).length
  return { total: scenes.length || nodes.length, withImages }
}

export function deriveProjectStage({ cards, blueprintNodes, planStats, sceneStats, distExists }) {
  if (!(Number(cards) > 0)) return 'script'
  if (!(Number(blueprintNodes) > 0)) return 'blueprint'
  if (!planStats || !planStats.exists) return 'blueprint'
  if (planStats.scenes > 0 && planStats.analyzed < planStats.scenes) return 'blueprint'
  if (planStats.totalAssets > 0 && planStats.locked < planStats.totalAssets) return 'blueprint'
  if (planStats.scenes > 0 && planStats.composed < planStats.scenes) return 'blueprint'
  if (!sceneStats || sceneStats.total <= 0) return 'compose'
  if (sceneStats.withImages < sceneStats.total) return 'compose'
  return distExists ? 'playable' : 'export'
}

// 阶段输入磁盘采集单一收口：summary 端点与 meta.json 回写链（touchProjectUpdatedAt）共用，
// 返回原始 story/project 供调用方继续派生（imageStats/封面等），避免二次读盘。
export async function collectProjectStageInput(dir) {
  const scripts = await readJson(path.join(dir, 'scripts.json')).catch(() => null)
  const blueprint = await readJson(path.join(dir, 'blueprint.json')).catch(() => null)
  const story = await readJson(path.join(dir, 'story.json')).catch(() => null)
  const project = await readJson(path.join(dir, 'project.json')).catch(() => null)
  const cards = Array.isArray(scripts?.cards) ? scripts.cards.length : 0
  const bpNodes = Array.isArray(blueprint?.nodes) ? blueprint.nodes : []
  const sceneNodeIds = new Set(
    bpNodes.filter((n) => String(n?.kind || 'scene') !== 'ending').map((n) => String(n?.id || '')).filter(Boolean)
  )
  const plan = project?.state?.aiBackground?.storyAssetPlan || null
  const storyNodes = story?.nodes && typeof story.nodes === 'object' ? (Array.isArray(story.nodes) ? story.nodes.length : Object.keys(story.nodes).length) : 0
  return {
    cards,
    blueprintNodes: bpNodes.length,
    storyNodes,
    planStats: derivePlanStats(plan, sceneNodeIds),
    sceneStats: deriveSceneStats(story),
    distExists: await existsFile(path.join(dir, 'builds', 'latest', 'dist', 'index.html')),
    story,
    project
  }
}

export async function deriveProjectStageFromDisk(dir) {
  return deriveProjectStage(await collectProjectStageInput(dir))
}

export function normalizeAiStoryFormula(input) {
  const choicePoints = clampInt(input?.choicePoints, 1, 3, 2)
  const optionsPerChoice = Number(input?.optionsPerChoice) === 3 ? 3 : 2
  const endings = optionsPerChoice
  return { schemaVersion: '1.0', format: 'numeric', choicePoints, optionsPerChoice, endings }
}
