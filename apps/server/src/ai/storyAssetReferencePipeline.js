// 故事资产参考图管线（裁切/归档/生成/线稿/评审/主参考写回；2026-10-20 index.js 拆分收尾迁出；函数体逐字未改）
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { genId } from './scripts.js'
import { IMAGE_KIND, optimizeGeneratedImage } from './imageOptimize.js'
import { generateBackgroundImage, generateComfyuiCutoutFromReference } from './background.js'
import { getStoryAssetRenderProfile, summarizeStoryAssetPlan } from './storyAssets.js'
import { reviewStoryboardLockImageWithAi } from './storyLock.js'
import { sniffImageMetaFromBytes } from './storyAssetReferenceGate.js'
import { listAiTasks, updateAiTask } from './taskProgress.js'
import { listImageReviews } from '../review/imageReviewStore.js'
import { getStoryImageCoverage } from './storyCoverage.js'
import { existsFile, projectDir, readJson, readProjectBundle, writeJson } from '../studio/storeFs.js'
import { buildStoryAssetComfyPrefix, buildStoryAssetFileTarget, normalizeStoryAssetUri, storyAssetStr } from './storyAssetText.js'
import { saveStoryAssetPlan } from './storyAssetPlanStore.js'
import { buildStoryAssetPromptEnhancement } from './storyAssetGalleryPrompt.js'

// [拆分回收·补] 首轮回收脚本中途失败遗落的 18 个辅助定义（自备份还原）
export async function applyCutoutToStoryAssetReference({
  id,
  dir,
  plan,
  asset,
  sourceRef,
  studio,
  timeoutMs
}) {
  const category = String(asset?.category || '').trim()
  const comfyuiBaseUrl = String(studio?.effective?.image?.comfyuiBaseUrl || '').trim()
  if (!['character', 'prop'].includes(category) || !comfyuiBaseUrl) {
    return {
      plan,
      primaryReferenceAssetId: String(sourceRef?.projectAssetId || '').trim(),
      primaryReferenceAssetUri: String(sourceRef?.projectAssetUri || '').trim()
    }
  }

  const sourceUri = String(sourceRef?.projectAssetUri || '').trim().replace(/^\/+/, '')
  if (!sourceUri) {
    return {
      plan,
      primaryReferenceAssetId: String(sourceRef?.projectAssetId || '').trim(),
      primaryReferenceAssetUri: String(sourceRef?.projectAssetUri || '').trim()
    }
  }

  try {
    const abs = path.join(dir, sourceUri)
    const bytes = await readFile(abs)
    // character/prop 一律输出透明立绘（RMBG Alpha），供运行时分层合成
    const post = await generateComfyuiCutoutFromReference({
      referenceBytes: bytes,
      referenceFilename: `${String(asset?.id || 'asset').trim() || 'asset'}_selected.png`,
      comfyuiBaseUrl,
      processRes: Math.max(Number(sourceRef?.width) || 0, Number(sourceRef?.height) || 0, 1024),
      timeoutMs,
      prefix: buildStoryAssetComfyPrefix(asset, 'selected_cutout'),
      transparent: true
    })
    const postprocess = String(post?.meta?.postprocess || '').trim() || 'rmbg_alpha'

    const ext = String(post.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const target = buildStoryAssetFileTarget({
      dir,
      asset,
      prefix: 'selected_cutout',
      ext,
      seed: sourceRef && sourceRef.seed
    })
    await mkdir(target.outDir, { recursive: true })
    await writeFile(target.absPath, post.bytes)
    // 2026-09-09 出图即压：选定立绘无损 WebP（真相源零质量损失）
    const optSel = await optimizeGeneratedImage(target.absPath, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
    const relPath = optSel && optSel.outPath && optSel.outPath !== target.absPath
      ? String(assetPathFromAbsolute(id, optSel.outPath) || target.assetPath)
      : target.assetPath

    const projectAssetId = genId('asset')
    const projectAsset = {
      id: projectAssetId,
      kind: 'image',
      name: `故事资产立绘 ${String(asset?.name || asset?.id || projectAssetId).trim()}`,
      uri: relPath,
      source: {
        type: 'ai',
        prompt: String(sourceRef?.prompt || '').trim() || undefined,
        negativePrompt: String(sourceRef?.negativePrompt || '').trim() || undefined,
        provider: String(post?.meta?.provider || 'comfyui'),
        remoteUrl: String(post?.meta?.url || '').trim() || undefined,
        loras: Array.isArray(sourceRef?.loras) ? sourceRef.loras : undefined,
        seed: Number.isFinite(Number(sourceRef?.seed)) ? Number(sourceRef.seed) : undefined,
        postprocess
      }
    }

    const bundle = await readProjectBundle(id)
    const nextProject = {
      ...bundle.rawProject,
      assets: [...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []), projectAsset],
      updatedAt: new Date().toISOString()
    }
    await writeJson(path.join(dir, 'project.json'), nextProject)

    const nextPlan = {
      ...plan,
      generatedAt: new Date().toISOString(),
      assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
        if (String(item && item.id || '').trim() !== String(asset?.id || '').trim()) return item
        const prevRefs = Array.isArray(item.generatedRefs) ? item.generatedRefs : []
        return {
          ...item,
          generatedRefs: [
            ...prevRefs,
            {
              projectAssetId,
              projectAssetUri: relPath,
              createdAt: new Date().toISOString(),
              provider: String(post?.meta?.provider || 'comfyui'),
              remoteUrl: String(post?.meta?.url || '').trim() || undefined,
              loras: Array.isArray(sourceRef?.loras) ? sourceRef.loras : undefined,
              prompt: String(sourceRef?.prompt || '').trim(),
              negativePrompt: String(sourceRef?.negativePrompt || '').trim(),
              width: Number(sourceRef?.width) || undefined,
              height: Number(sourceRef?.height) || undefined,
              seed: Number.isFinite(Number(sourceRef?.seed)) ? Number(sourceRef.seed) : undefined,
              postprocess
            }
          ]
        }
      }) : plan.assets
    }
    nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
    await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    return { plan: nextPlan, primaryReferenceAssetId: projectAssetId, primaryReferenceAssetUri: relPath }
  } catch (_) {
    return {
      plan,
      primaryReferenceAssetId: String(sourceRef?.projectAssetId || '').trim(),
      primaryReferenceAssetUri: String(sourceRef?.projectAssetUri || '').trim()
    }
  }
}

export async function archiveExistingAssetForReplacement(projectId, uri) {
  const abs = resolveAssetPathFromUri(projectId, uri)
  if (!abs) return null
  if (!(await existsFile(abs))) return null
  const parsed = path.parse(abs)
  for (let i = 1; i <= 999; i += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_old${i}${parsed.ext}`)
    if (await existsFile(candidate)) continue
    await rename(abs, candidate)
    return candidate
  }
  throw new Error('archive_slot_exhausted')
}

export function assetPathFromAbsolute(projectId, absPath) {
  const id = String(projectId || '').trim()
  if (!id || !absPath) return null
  const base = path.resolve(projectDir(id))
  const abs = path.resolve(String(absPath))
  const rel = path.relative(base, abs).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}

export async function backfillStoryAssetPromptDraftZh({ id, dir, plan, asset }) {
  const assetId = storyAssetStr(asset && asset.id).trim()
  if (!assetId) return
  const bundle = await readProjectBundle(id)
  const doc = bundle.rawProject && typeof bundle.rawProject === 'object' ? bundle.rawProject : null
  if (!doc) return
  const state = doc.state && typeof doc.state === 'object' ? doc.state : {}
  const aiBg = state.aiBackground && typeof state.aiBackground === 'object' ? state.aiBackground : {}
  const drafts = aiBg.storyboardLockAssetPrompts && typeof aiBg.storyboardLockAssetPrompts === 'object' ? { ...aiBg.storyboardLockAssetPrompts } : {}
  const prev = drafts[assetId] && typeof drafts[assetId] === 'object' ? drafts[assetId] : {}
  if (storyAssetStr(prev.promptZh).trim()) return // 已有中文稿（人工/AI 生成）不覆盖
  const fallback = buildStoryAssetPromptEnhancement({ asset, plan })
  const promptZh = storyAssetStr(fallback && fallback.promptZh).trim()
  if (!promptZh) return
  drafts[assetId] = {
    ...prev,
    promptZh,
    promptEn: storyAssetStr(prev.promptEn).trim() || storyAssetStr(fallback.promptEn).trim(),
    negativePromptZh: storyAssetStr(prev.negativePromptZh).trim() || storyAssetStr(fallback.negativePromptZh).trim(),
    negativePrompt: storyAssetStr(prev.negativePrompt).trim() || storyAssetStr(fallback.negativePrompt).trim()
  }
  await writeJson(path.join(dir, 'project.json'), {
    ...doc,
    updatedAt: new Date().toISOString(),
    state: { ...state, aiBackground: { ...aiBg, storyboardLockAssetPrompts: drafts } }
  })
}

export function deriveStoryAssetReferenceStatus(item) {
  const primaryUri = String(item?.primaryReferenceAssetUri || '').trim()
  if (primaryUri) return 'ready'
  const batch = Array.isArray(item?.latestReferenceBatch) ? item.latestReferenceBatch : []
  const refs = Array.isArray(item?.generatedRefs) ? item.generatedRefs : []
  if (batch.length || refs.length) return 'candidates_ready'
  return String(item?.referenceStatus || 'missing').trim() || 'missing'
}

export async function generateAndPersistStoryAssetReference({
  id,
  dir,
  bundle,
  plan,
  asset,
  studio,
  imgProvider,
  style,
  width,
  height,
  steps,
  cfgScale,
  sampler,
  scheduler,
  model,
  loras,
  prompt,
  negativePrompt,
  timeoutMs,
  seed
}) {
  const renderProfile = getStoryAssetRenderProfile(asset)
  const gen = await generateBackgroundImage({
    prompt,
    negativePrompt,
    width,
    height,
    style,
    steps,
    cfgScale,
    sampler,
    scheduler,
    seed,
    provider: imgProvider,
    sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
    comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
    apiUrl: studio.effective.image.apiUrl,
    model,
    loras,
    workflowMode: String(renderProfile.workflowMode || '').trim() || undefined,
    lockProfile: String(renderProfile.profile || '').trim() || undefined,
    proxyUrl: studio.effective.network.proxyUrl,
    timeoutMs
  })

  const finalGen = gen
  const buf = finalGen.bytes
  const ext0 = String(finalGen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
  const sniff = sniffImageMetaFromBytes(buf)
  const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
  const target = buildStoryAssetFileTarget({
    dir,
    asset,
    prefix: 'reference',
    ext,
    seed
  })
  await mkdir(target.outDir, { recursive: true })
  await writeFile(target.absPath, buf)
  const assetPath = target.assetPath

  const projectAssetId = genId('asset')
  const projectAsset = {
    id: projectAssetId,
    kind: 'image',
    name: `故事资产 ${String(asset.name || asset.id || projectAssetId).trim()}`,
    uri: assetPath,
    source: {
      type: 'ai',
      prompt,
      negativePrompt,
      provider: String(finalGen?.meta?.provider || imgProvider || ''),
      model: String(finalGen?.meta?.model || model || '').trim() || undefined,
      remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
      loras: Array.isArray(loras) ? loras : undefined,
      seed: Number.isFinite(Number(seed)) ? Number(seed) : (Number.isFinite(Number(finalGen?.meta?.seed)) ? Number(finalGen.meta.seed) : undefined)
    }
  }
  const nextProject = {
    ...bundle.rawProject,
    assets: [...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []), projectAsset],
    updatedAt: new Date().toISOString()
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)

  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(asset.id || '').trim()) return item
      const prevRefs = Array.isArray(item.generatedRefs) ? item.generatedRefs : []
      const hasPrimary = Boolean(String(item?.primaryReferenceAssetUri || '').trim())
      return {
        ...item,
        referenceStatus: hasPrimary ? 'ready' : 'candidates_ready',
        generatedRefs: [
          ...prevRefs,
          {
            projectAssetId,
            projectAssetUri: assetPath,
            createdAt: new Date().toISOString(),
            provider: String(finalGen?.meta?.provider || imgProvider || ''),
            model: String(finalGen?.meta?.model || model || '').trim() || undefined,
            remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
            loras: Array.isArray(loras) ? loras : undefined,
            prompt,
            negativePrompt,
            width,
            height,
            seed: Number.isFinite(Number(seed)) ? Number(seed) : (Number.isFinite(Number(finalGen?.meta?.seed)) ? Number(finalGen.meta.seed) : undefined)
          }
        ]
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })

  return {
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => String(item && item.id || '').trim() === String(asset.id || '').trim()) : null) || null,
    projectAsset,
    assetPath,
    url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
    provider: String(finalGen?.meta?.provider || imgProvider || ''),
    model: String(finalGen?.meta?.model || model || '').trim() || undefined,
    remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
    prompt,
    negativePrompt,
    seed: Number.isFinite(Number(seed)) ? Number(seed) : (Number.isFinite(Number(finalGen?.meta?.seed)) ? Number(finalGen.meta.seed) : undefined),
    plan: nextPlan
  }
}

export function getStoryAssetRenderSize(asset, stylePreset) {
  const profile = getStoryAssetRenderProfile(asset && typeof asset === 'object' ? asset : { category: asset }, stylePreset)
  return { width: Number(profile.width || 768), height: Number(profile.height || 768) }
}

export function isExternallyReachableReferenceUrl(input) {
  const raw = String(input || '').trim()
  if (!/^https?:\/\//i.test(raw)) return false
  try {
    const u = new URL(raw)
    const host = String(u.hostname || '').trim().toLowerCase()
    if (!host) return false
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) return false
    if (/^127\./.test(host)) return false
    if (/^10\./.test(host)) return false
    if (/^192\.168\./.test(host)) return false
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false
    return true
  } catch (_) {
    return false
  }
}

export async function maybeCloseRenderAllBatchTask(id, dir) {
  try {
    const open = listAiTasks(id, { includeDone: false }).find((t) => t.kind === 'story.scenes.render_all' && String(t.stage || '') === 'pending_review')
    if (!open) return
    const pending = await listImageReviews(dir, { status: 'pending' })
    if ((pending || []).some((r) => r.phase === 'scene_bind')) return
    let coverage = null
    try { coverage = await getStoryImageCoverage(dir) } catch (_) { /* 总账失败不影响收敛 */ }
    const bound = coverage && coverage.scenes && Array.isArray(coverage.scenes.items)
      ? coverage.scenes.items.filter((s) => s.status !== 'pending').length
      : null
    updateAiTask(open.taskId, {
      done: true,
      stage: 'done',
      message: `批量渲染审核全部决断${bound != null ? `，已绑定 ${bound}/${coverage.scenes.items.length}` : ''}（被拒场景可重新渲染）`,
      result: { ...(open.result && typeof open.result === 'object' ? open.result : {}), reviewClosed: true, coverage }
    })
  } catch (_) { /* 收敛失败不阻断审核结果 */ }
}

export function openFolderOnHost(folder) {
  const target = String(folder || '').trim()
  if (!target) return Promise.reject(new Error('missing_folder'))
  return new Promise((resolve, reject) => {
    let cmd = ''
    let args = []
    if (process.platform === 'darwin') {
      cmd = 'open'
      args = [target]
    } else if (process.platform === 'win32') {
      cmd = 'explorer'
      args = [target]
    } else {
      cmd = 'xdg-open'
      args = [target]
    }
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
    p.on('error', (e) => reject(e))
    p.unref()
    resolve(true)
  })
}

export async function persistStoryAssetLineartResult({
  id,
  dir,
  plan,
  asset,
  hintBytes,
  hintExt,
  finalBytes,
  finalExt,
  meta,
  prompt,
  negativePrompt
}) {
  const hintTarget = buildStoryAssetFileTarget({
    dir,
    asset,
    prefix: 'lineart_hint',
    ext: String(hintExt || 'png'),
    seed: meta && meta.seed
  })
  const finalTarget = buildStoryAssetFileTarget({
    dir,
    asset,
    prefix: 'lineart_final',
    ext: String(finalExt || 'png'),
    seed: meta && meta.seed
  })
  await mkdir(hintTarget.outDir, { recursive: true })
  await writeFile(hintTarget.absPath, hintBytes)
  await writeFile(finalTarget.absPath, finalBytes)
  const hintPath = hintTarget.assetPath
  const finalPath = finalTarget.assetPath

  const hintAssetId = genId('asset')
  const finalAssetId = genId('asset')
  const hintProjectAsset = {
    id: hintAssetId,
    kind: 'image',
    name: `线稿提示 ${String(asset?.name || asset?.id || hintAssetId).trim()}`,
    uri: hintPath,
    source: {
      type: 'ai',
      prompt,
      provider: String(meta?.provider || 'comfyui'),
      remoteUrl: String(meta?.hintUrl || '').trim() || undefined
    }
  }
  const finalProjectAsset = {
    id: finalAssetId,
    kind: 'image',
    name: `线稿成品 ${String(asset?.name || asset?.id || finalAssetId).trim()}`,
    uri: finalPath,
    source: {
      type: 'ai',
      prompt,
      provider: String(meta?.provider || 'comfyui'),
      remoteUrl: String(meta?.finalUrl || '').trim() || undefined
    }
  }

  const bundle = await readProjectBundle(id)
  const nextProject = {
    ...bundle.rawProject,
    assets: [
      ...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []),
      hintProjectAsset,
      finalProjectAsset
    ],
    updatedAt: new Date().toISOString()
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)

  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(asset?.id || '').trim()) return item
      return {
        ...item,
        lineartHintAssetId: hintAssetId,
        lineartHintAssetUri: hintPath,
        lineartFinalAssetId: finalAssetId,
        lineartFinalAssetUri: finalPath,
        lineartStatus: 'ready',
        lineartPrompt: String(prompt || '').trim(),
        lineartNegativePrompt: String(negativePrompt || '').trim(),
        lineartMeta: meta && typeof meta === 'object' ? meta : null,
        lineartGeneratedAt: new Date().toISOString()
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  return {
    plan: nextPlan,
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => String(item && item.id || '').trim() === String(asset?.id || '').trim()) : null) || null,
    hintProjectAsset,
    finalProjectAsset,
    hintAssetPath: hintPath,
    finalAssetPath: finalPath,
    hintUrl: `/project-assets/${encodeURIComponent(String(id))}/${hintPath}`,
    finalUrl: `/project-assets/${encodeURIComponent(String(id))}/${finalPath}`
  }
}

export async function persistStoryAssetReferenceBatch({
  id,
  plan,
  assetId,
  latestReferenceBatch,
  recommendedReferenceAssetUri
}) {
  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(assetId || '').trim()) return item
      const batch = Array.isArray(latestReferenceBatch) ? latestReferenceBatch.filter((x) => x && typeof x === 'object') : []
      const refStatus = String(item?.primaryReferenceAssetUri || '').trim() ? 'ready' : (batch.length ? 'candidates_ready' : deriveStoryAssetReferenceStatus(item))
      return {
        ...item,
        referenceStatus: refStatus,
        latestReferenceBatch: batch,
        latestRecommendedReferenceAssetUri: String(recommendedReferenceAssetUri || '').trim(),
        latestReferenceReview: String(item?.primaryReferenceAssetUri || '').trim() ? item.latestReferenceReview || null : null
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  return nextPlan
}

export function resolveAssetPathFromUri(projectId, uri) {
  const id = String(projectId || '').trim()
  const raw = String(uri || '').trim()
  if (!id || !raw) return null
  let s = raw
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s)
      s = String(u.pathname || '')
    }
  } catch (_) {}
  s = s.replace(/\\/g, '/')
  const marker = `/project-assets/${encodeURIComponent(String(id))}/`
  if (s.startsWith(marker)) {
    s = s.slice(marker.length)
  } else if (/^\/project-assets\//.test(s)) {
    const pfx = `/project-assets/${encodeURIComponent(String(id))}/`
    if (!s.startsWith(pfx)) return null
    s = s.slice(pfx.length)
  } else if (s.startsWith('/')) {
    s = s.replace(/^\/+/, '')
  }
  if (!s) return null
  if (!/^assets\//.test(s)) {
    if (/^(uploads|ai)\//.test(s)) s = `assets/${s}`
    else if (!/^assets\//.test(s)) s = `assets/${s}`
  }
  const base = projectDir(id)
  const abs = path.resolve(path.join(base, s))
  const baseNorm = path.resolve(base) + path.sep
  if (!(abs + path.sep).startsWith(baseNorm) && abs !== path.resolve(base)) return null
  return abs
}

export async function reviewAndPersistStoryAssetReference({
  id,
  dir,
  studio,
  plan,
  asset,
  prompt,
  negativePrompt,
  assetPath
}) {
  const abs = path.join(dir, String(assetPath || '').replace(/^\/+/, ''))
  const buf = await readFile(abs)
  const sniff = sniffImageMetaFromBytes(buf)
  if (!sniff) {
    const e = new Error('invalid_story_asset_reference_image')
    e.status = 400
    throw e
  }
  const analysis = await reviewStoryboardLockImageWithAi({
    provider: process.env.MOONSHOT_API_KEY ? 'moonshot' : studio.effective.prompt.provider,
    model: process.env.MOONSHOT_API_KEY ? 'kimi-for-coding' : studio.effective.prompt.model,
    apiUrl: studio.effective.prompt.apiUrl,
    proxyUrl: studio.effective.network.proxyUrl,
    moonshotApiKey: process.env.MOONSHOT_API_KEY || '',
    moonshotBaseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.kimi.com/coding/v1',
    asset,
    prompt,
    negativePrompt,
    imageDataUrl: `data:${sniff.contentType};base64,${buf.toString('base64')}`,
    attempt: 1,
    maxAttempts: 1
  })

  const review = {
    reviewedAt: new Date().toISOString(),
    targetAssetUri: String(assetPath || '').trim(),
    prompt: String(prompt || '').trim(),
    negativePrompt: String(negativePrompt || '').trim(),
    passed: Boolean(analysis && analysis.passed),
    score: Number.isFinite(Number(analysis && analysis.score)) ? Math.max(0, Math.min(100, Math.round(Number(analysis.score)))) : null,
    summary: String(analysis && analysis.summary || '').trim(),
    issues: Array.isArray(analysis && analysis.issues) ? analysis.issues.map((x) => String(x || '').trim()).filter(Boolean) : [],
    revisedPrompt: String(analysis && analysis.revisedPrompt || '').trim(),
    revisedNegativePrompt: String(analysis && analysis.revisedNegativePrompt || '').trim(),
    skipped: Boolean(analysis && analysis.skipped)
  }
  const nextPlan = {
    ...plan,
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(asset.id || '').trim()) return item
      return { ...item, latestReferenceReview: review }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })

  return {
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => String(item && item.id || '').trim() === String(asset.id || '').trim()) : null) || null,
    analysis: review,
    plan: nextPlan
  }
}

export async function setPrimaryStoryAssetReference({
  id,
  plan,
  assetId,
  primaryReferenceAssetId,
  primaryReferenceAssetUri,
  latestReferenceReview,
  latestReferenceBatch,
  selectedBatchAssetPath,
  resetLineart = true
}) {
  const selectedBatchUri = normalizeStoryAssetUri(selectedBatchAssetPath)
  const normalizedPrimaryUri = normalizeStoryAssetUri(primaryReferenceAssetUri)
  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(assetId || '').trim()) return item
      const nextBatch = Array.isArray(latestReferenceBatch)
        ? latestReferenceBatch
          .filter((x) => x && typeof x === 'object')
          .map((entry) => {
            const entryPath = normalizeStoryAssetUri(entry && entry.assetPath)
            if (!selectedBatchUri || !normalizedPrimaryUri || entryPath !== selectedBatchUri) return entry
            return {
              ...entry,
              assetPath: normalizedPrimaryUri,
              url: `/project-assets/${encodeURIComponent(String(id || ''))}/${normalizedPrimaryUri}`
            }
          })
        : (Array.isArray(item.latestReferenceBatch) ? item.latestReferenceBatch : [])
      const nextItem = {
        ...item,
        primaryReferenceAssetId: String(primaryReferenceAssetId || '').trim(),
        primaryReferenceAssetUri: String(primaryReferenceAssetUri || '').trim(),
        primaryReferenceSelectedAt: new Date().toISOString(),
        referenceStatus: String(primaryReferenceAssetUri || '').trim() ? 'ready' : deriveStoryAssetReferenceStatus(item),
        latestReferenceReview: latestReferenceReview && typeof latestReferenceReview === 'object' ? latestReferenceReview : (item.latestReferenceReview || null),
        latestReferenceBatch: nextBatch
      }
      if (!resetLineart) return nextItem
      return {
        ...nextItem,
        lineartHintAssetId: '',
        lineartHintAssetUri: '',
        lineartFinalAssetId: '',
        lineartFinalAssetUri: '',
        lineartStatus: 'missing',
        lineartPrompt: '',
        lineartNegativePrompt: '',
        lineartMeta: null,
        lineartGeneratedAt: ''
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  return nextPlan
}

export function shouldDiscardStoryAssetReferenceCandidate(analysis) {
  // 2026-10-12 修复：评审跳过（skipped：配额耗尽/视觉不可用）不等于差评，不丢弃——
  // 灰姑娘批次实证：Kimi 周配额耗尽导致评审 skipped，7 张候选被误全丢。
  if (analysis && analysis.skipped) return false
  const score = storyAssetReviewScore(analysis)
  if (score >= 0 && score < 20) return true
  const summary = String(analysis && analysis.summary || '').trim()
  const issues = Array.isArray(analysis && analysis.issues) ? analysis.issues.map((x) => String(x || '').trim()).join(' | ') : ''
  const hay = `${summary} | ${issues}`.toLowerCase()
  if (!hay) return false
  if (/(主体类别错误|严重跑题|人形角色|人物而非|human|humanoid|android|cyborg|robot|person instead|body parts)/i.test(hay)) return true
  return false
}

export function storyAssetReviewScore(analysis) {
  const score = Number(analysis && analysis.score)
  if (Number.isFinite(score)) return Math.max(0, Math.min(100, Math.round(score)))
  return analysis && analysis.passed ? 100 : -1
}

export async function writeStoryAssetPrimaryToProject({ id, dir, asset, primaryReferenceAssetId }) {
  const bundle = await readProjectBundle(id)
  const nextProject = {
    ...bundle.rawProject,
    updatedAt: new Date().toISOString(),
    characters: Array.isArray(bundle.rawProject.characters) ? bundle.rawProject.characters.map((ch) => {
      if (String(asset?.category || '').trim() !== 'character') return ch
      if (String(ch && ch.id || '').trim() !== String(asset?.projectCharacterId || '').trim()) return ch
      return {
        ...ch,
        ai: {
          ...((ch && ch.ai && typeof ch.ai === 'object') ? ch.ai : {}),
          referenceAssetId: String(primaryReferenceAssetId || '').trim()
        }
      }
    }) : bundle.rawProject.characters
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)
}

// [拆分修复] readProjectJson：历史上被两个评审处理器引用却从未定义（潜藏 ReferenceError），此处补上定义
export async function readProjectJson(id) {
  return readJson(path.join(projectDir(id), 'project.json'))
}
