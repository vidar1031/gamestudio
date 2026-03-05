function asObj(v) {
  return v && typeof v === 'object' ? v : {}
}

function asStr(v) {
  return typeof v === 'string' ? v : ''
}

function asFiniteNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function normalizeAiBackgroundState(input) {
  // P1:state-migration
  // Why:
  // - 统一 aiBackground 结构，避免 globalPrompt/global 分裂导致的读写不一致。
  const raw = asObj(input)
  const rawGlobal = asObj(raw.global)
  const legacyPrompt = asStr(raw.globalPrompt).trim()
  const legacyNegative = asStr(raw.globalNegativePrompt).trim()
  const globalPrompt = asStr(rawGlobal.prompt).trim() || legacyPrompt
  const globalNegativePrompt = asStr(rawGlobal.negativePrompt).trim() || legacyNegative

  const scenesIn = asObj(raw.storyboardScenes)
  const storyboardScenes = {}
  for (const [nodeId, value] of Object.entries(scenesIn)) {
    const scene = asObj(value)
    storyboardScenes[String(nodeId)] = {
      ...scene,
      nodeId: asStr(scene.nodeId).trim() || String(nodeId),
      prompt: asStr(scene.prompt).trim(),
      negativePrompt: asStr(scene.negativePrompt).trim(),
      status:
        scene.status === 'idle' || scene.status === 'generating' || scene.status === 'ok' || scene.status === 'error'
          ? scene.status
          : undefined,
      updatedAt: asStr(scene.updatedAt).trim() || undefined,
      error: asStr(scene.error).trim() || undefined
    }
  }

  const draftIn = asObj(raw.storyboardBatchDraft)
  const metaIn = asObj(raw.storyboardPromptMeta)
  const storyboardEntitySpec = asStr(raw.storyboardEntitySpec).trim() || asStr(raw.entitySpec).trim()

  return {
    schemaVersion: '1.0',
    global: {
      prompt: globalPrompt,
      negativePrompt: globalNegativePrompt
    },
    storyboardScenes,
    storyboardBatchDraft: {
      ...draftIn,
      style: asStr(draftIn.style) || undefined,
      aspectRatio: asStr(draftIn.aspectRatio) || undefined,
      width: asFiniteNum(draftIn.width),
      height: asFiniteNum(draftIn.height),
      steps: asFiniteNum(draftIn.steps),
      cfgScale: asFiniteNum(draftIn.cfgScale),
      sampler: asStr(draftIn.sampler) || undefined,
      scheduler: asStr(draftIn.scheduler) || undefined,
      model: asStr(draftIn.model) || undefined,
      lora: asStr(draftIn.lora) || undefined,
      timeoutMs: asFiniteNum(draftIn.timeoutMs)
    },
    storyboardPromptMeta: {
      ...metaIn,
      provider: asStr(metaIn.provider) || undefined,
      model: asStr(metaIn.model) || undefined,
      timeoutMs: asFiniteNum(metaIn.timeoutMs),
      generatedAt: asStr(metaIn.generatedAt) || undefined,
      sceneCount: asFiniteNum(metaIn.sceneCount),
      source: asStr(metaIn.source) || undefined
    },
    storyboardEntitySpec,
    globalPrompt,
    globalNegativePrompt
  }
}

export function normalizeProjectState(input) {
  const state = asObj(input)
  const varsIn = Array.isArray(state.vars) ? state.vars : []
  const vars = varsIn
    .map((v) => asObj(v))
    .map((v) => ({
      name: asStr(v.name).trim(),
      type: asStr(v.type).trim() || 'string',
      default: Object.prototype.hasOwnProperty.call(v, 'default') ? v.default : ''
    }))
    .filter((v) => Boolean(v.name))
  return {
    ...state,
    vars,
    aiBackground: normalizeAiBackgroundState(state.aiBackground)
  }
}

export function normalizeProjectDoc(input) {
  const project = asObj(input)
  return {
    ...project,
    state: normalizeProjectState(project.state)
  }
}
