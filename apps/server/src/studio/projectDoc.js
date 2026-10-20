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

export function deriveProjectStage({ cards, blueprintNodes, storyNodes, distExists }) {
  return !(Number(cards) > 0) ? 'script'
    : !(Number(blueprintNodes) > 0) ? 'blueprint'
    : !(Number(storyNodes) > 2) ? 'compose'
    : !distExists ? 'export'
    : 'playable'
}

export async function deriveProjectStageFromDisk(dir) {
  const scripts = await readJson(path.join(dir, 'scripts.json')).catch(() => null)
  const blueprint = await readJson(path.join(dir, 'blueprint.json')).catch(() => null)
  const story = await readJson(path.join(dir, 'story.json')).catch(() => null)
  const cards = Array.isArray(scripts?.cards) ? scripts.cards.length : 0
  const blueprintNodes = Array.isArray(blueprint?.nodes) ? blueprint.nodes.length : 0
  const storyNodes = story?.nodes && typeof story.nodes === 'object' ? Object.keys(story.nodes).length : 0
  const distExists = await existsFile(path.join(dir, 'builds', 'latest', 'dist', 'index.html'))
  return deriveProjectStage({ cards, blueprintNodes, storyNodes, distExists })
}

export function normalizeAiStoryFormula(input) {
  const choicePoints = clampInt(input?.choicePoints, 1, 3, 2)
  const optionsPerChoice = Number(input?.optionsPerChoice) === 3 ? 3 : 2
  const endings = optionsPerChoice
  return { schemaVersion: '1.0', format: 'numeric', choicePoints, optionsPerChoice, endings }
}
