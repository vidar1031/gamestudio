// ---------------------------------------------------------------------------
// registerStorySpritesRoutes（模块化拆分机械迁出，字义未改；协议层+族内编排，域算法引自 ../ai/*，index 本地辅助经 ctx 注入）
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { createTraceId, logStage } from '../ai/runtime.js'
import { createAiTask, updateAiTask } from '../ai/taskProgress.js'
import { buildPoseStateExtractionInput, extractStoryPoseStates } from '../ai/storyPoseStates.js'
import { buildPoseVariantPrompt, generatePoseVariantForGroup, groupPoseRequirements, isAnimalLikeAnchor, loadPoseLibraryManifest } from '../ai/storyPoseVariants.js'
import { generateBackgroundImage, generateComfyuiCutoutFromReference } from '../ai/background.js'
import { optimizeGeneratedImage, IMAGE_KIND } from '../ai/imageOptimize.js'
import { sniffImageMetaFromBytes } from '../ai/storyAssetReferenceGate.js'
import { translatePromptText } from '../ai/translate.js'
import { generateCharacterFingerprint, generateCharacterPosePrompt } from '../ai/characterPrompt.js'
import { getEffectiveStudioConfig } from '../studio/settings.js'
import { serveStatic } from '@hono/node-server/serve-static'

export function registerStorySpritesRoutes(app, ctx) {
// ---------------------------------------------------------------------------
// 2026-10-10 姿势变体自动编排（asset.poseVariants.autoGenerate，GS-51；自动化②落地）：
// 提取剧情姿势需求（storyPoseStates LLM）→ 按（角色×姿势）分组 → 匹配公共姿势库骨架
// → 骨架驱动生成变体（generateComfyuiPoseVariantSprite）→ layered-produce 登记绑场景。
// 全程 aiTask 进度 + logStage；站立类不出变体；无骨架匹配记 unmatched（姿势库扩展线索）。
// 幂等：同名「自动·<poseKey>」变体已存在则跳过。审图留痕 lock_confirm decidedBy=auto-pose。
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ai/story/pose-variants/auto', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)

  const bundle = await ctx.readProjectBundle(id)
  const storyBible = ctx.readStoryBibleFromProjectDoc(bundle.project)
  if (!storyBible || typeof storyBible !== 'object') return c.json({ success: false, error: 'missing_story_bible', message: '请先生成 Story Bible。' }, 400)
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const traceId = createTraceId()
  const task = createAiTask(id, 'story.pose_variants.auto', { total: 1, message: '姿势需求提取中…' })
  logStage({ stage: 'story.pose_variants.auto', event: 'start', traceId, project: id })

  ;(async () => {
    const errors = []
    const generated = []
    try {
      // 1) LLM 提取逐场景姿势需求
      const input = buildPoseStateExtractionInput({ project: bundle.project, story: bundle.story, storyBible })
      if (!input.scenes.length) throw new Error('no_scenes_with_characters')
      const { result: poseStates } = await extractStoryPoseStates({
        provider: studio.effective.prompt.provider,
        model: studio.effective.prompt.model,
        apiUrl: studio.effective.prompt.apiUrl,
        proxyUrl: studio.effective.network.proxyUrl,
        timeoutMs: ctx.clampInt(body?.timeoutMs, 60_000, 600_000, 300_000),
        input
      })

      // 2) 分组 + 骨架匹配
      const { libDir, poses } = await loadPoseLibraryManifest(ctx.ROOT)
      if (!Object.keys(poses).length) throw new Error('pose_library_manifest_missing')
      const { groups, unmatched } = groupPoseRequirements(poseStates, poses)
      updateAiTask(task.taskId, { total: groups.length, stage: 'generating', message: `姿势需求 ${groups.length} 组（未匹配 ${unmatched.length}），开始生成变体` })
      logStage({ stage: 'story.pose_variants.auto', event: 'extracted', traceId, project: id, item: `groups:${groups.length} unmatched:${unmatched.length}` })

      const bibleNameByCharId = new Map((Array.isArray(storyBible.characters) ? storyBible.characters : []).map((x) => [String(x && x.id || '').trim(), String(x && x.name || '').trim()]))
      const normKey = (s) => ctx.asStr(s).trim().toLowerCase().replace(/[\s《》「」]/g, '')
      const planAssets = Array.isArray(plan.assets) ? plan.assets : []
      const findPlanCharacter = (characterId) => {
        const name = bibleNameByCharId.get(characterId) || ''
        return planAssets.find((a) => String(a?.category || '') === 'character' && (String(a?.id || '').trim() === characterId || (name && normKey(a?.name) === normKey(name)))) || null
      }

      const globalStyleEn = String(plan.worldAnchor || '').trim()
      let cursor = 0
      for (const group of groups) {
        cursor += 1
        const asset = findPlanCharacter(group.characterId)
        const label = `${asset ? asset.name : group.characterId}·${group.poseKey}`
        if (!asset) { errors.push({ group: label, error: 'character_not_in_plan' }); continue }
        const lockName = `自动·${group.poseKey}`
        if (ctx.asList(asset.poseVariants).some((v) => String(v?.name || '').trim() === lockName)) {
          updateAiTask(task.taskId, { current: cursor, message: `已存在跳过：${label}` })
          continue
        }
        const identityRel = ctx.asStr(asset.primaryReferenceAssetUri).trim()
        const identityAbs = identityRel ? path.resolve(dir, identityRel) : ''
        if (!identityAbs || !identityAbs.startsWith(path.resolve(dir) + path.sep) || !(await ctx.existsFile(identityAbs))) {
          errors.push({ group: label, error: 'identity_reference_missing' })
          updateAiTask(task.taskId, { current: cursor, message: `缺主参考跳过：${label}` })
          continue
        }
        const poseDef = poses[group.poseKey]
        try {
          updateAiTask(task.taskId, { stage: 'generating', current: cursor - 1, message: `生成姿势变体：${label}（${group.sceneIds.length} 场景）` })
          const identityBytes = await readFile(identityAbs)
          const prompt = buildPoseVariantPrompt({ asset, poseDef, group, globalStyleEn })
          const animalBoost = isAnimalLikeAnchor(`${prompt} ${ctx.asStr(asset.name)}`)
          const gen = await generatePoseVariantForGroup({
            root: ctx.ROOT,
            libDir,
            poseDef,
            identityBytes,
            identityFilename: path.basename(identityAbs),
            prompt,
            comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
            timeoutMs: 300_000,
            prefix: `talkscene_pose/auto_${String(asset.id).replace(/[^a-z0-9_-]/gi, '_')}`,
            ipadapterWeight: animalBoost ? 0.95 : 0.85
          })
          // 产物落项目资产目录 → layered-produce 正式链登记（抠图/审核留痕/场景绑定）
          const outRel = `assets/ai/story_assets/character/${String(asset.id).replace(/[^a-z0-9_-]/gi, '_')}/pose_auto_${group.poseKey}_${Date.now()}.png`
          const outAbs = path.resolve(dir, outRel)
          await mkdir(path.dirname(outAbs), { recursive: true })
          await writeFile(outAbs, gen.bytes)
          const resp = await app.request(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(group.sceneIds[0])}/layered-produce`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' },
            body: JSON.stringify({
              poses: [{
                lockName,
                planAssetId: String(asset.id).trim(),
                characterId: String(asset.id).trim(),
                spriteAssetPath: outRel,
                posePrompt: prompt,
                promptZh: `${ctx.asStr(group.action).trim()} ${ctx.asStr(group.expression).trim()}`.trim(),
                sceneIds: group.sceneIds
              }]
            })
          })
          const json = await resp.json().catch(() => ({}))
          const okEntry = Array.isArray(json?.poses) && json.poses[0] && json.poses[0].projectAssetId
          if (!resp.ok || !okEntry) throw new Error(`register_failed:${String(json?.poses?.[0]?.error || json?.error || resp.status)}`)
          generated.push({ group: label, poseKey: group.poseKey, scenes: group.sceneIds.length, projectAssetId: json.poses[0].projectAssetId })
          updateAiTask(task.taskId, { current: cursor, message: `完成：${label}` })
          logStage({ stage: 'story.pose_variants.auto', event: 'generated', traceId, project: id, item: label })
        } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e)
          errors.push({ group: label, error: msg.slice(0, 200) })
          updateAiTask(task.taskId, { current: cursor, message: `失败：${label}（${msg.slice(0, 60)}）` })
          logStage({ stage: 'story.pose_variants.auto', event: 'fail', traceId, project: id, item: `${label} / ${msg.slice(0, 160)}` })
        }
      }
      updateAiTask(task.taskId, {
        stage: 'done',
        done: true,
        current: groups.length,
        message: `姿势变体编排完成：生成 ${generated.length}，失败 ${errors.length}，未匹配骨架 ${unmatched.length}`,
        result: { generated, errors, unmatched }
      })
      logStage({ stage: 'story.pose_variants.auto', event: 'done', traceId, project: id, item: `generated:${generated.length} failed:${errors.length} unmatched:${unmatched.length}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      console.error('[story.pose_variants.auto]', e && e.stack ? e.stack : msg)
      updateAiTask(task.taskId, { stage: 'error', done: true, error: msg, message: `姿势变体编排失败：${msg}` })
      logStage({ stage: 'story.pose_variants.auto', event: 'error', traceId, project: id, item: msg.slice(0, 300) })
    }
  })()

  return c.json({ success: true, taskId: task.taskId, message: '姿势变体自动编排已启动，进度见 /ai/tasks' }, 202)
})

// AI：提取角色外观指纹（全局锁定）
app.post('/api/projects/:id/ai/character/fingerprint', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterName = String(body?.characterName || '').trim()
  if (!characterName) return c.json({ success: false, error: 'missing_characterName', message: 'characterName 不能为空' }, 400)
  const storyTitle = String(body?.storyTitle || '').trim()
  const contextText = String(body?.contextText || '').trim()
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const style = ctx.normalizeStyleEnum(body?.style)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }

  const startedAt = Date.now()
  try {
    console.log(
      `[talkscene] ch.fp:start project=${id} provider=${studio.effective.prompt.provider || 'localoxml'} model=${studio.effective.prompt.model || '-'} name=${characterName} storyChars=${storyTitle.length} ctxChars=${contextText.length} globalChars=${globalPrompt.length} style=${style}`
    )
  } catch (_) {}

  try {
    const { result, meta } = await generateCharacterFingerprint({
      storyTitle,
      characterName,
      contextText,
      globalPrompt,
      style,
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl
    })

    try {
      console.log(`[talkscene] ch.fp:ok project=${id} ms=${Math.max(0, Date.now() - startedAt)} provider=${meta?.provider || '-'} model=${meta?.model || '-'}`)
    } catch (_) {}
    return c.json({ success: true, result, meta })
  } catch (e) {
    try {
      console.log(`[talkscene] ch.fp:fail project=${id} ms=${Math.max(0, Date.now() - startedAt)} err=${e && e.message ? String(e.message) : String(e)}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: e && e.message ? String(e.message) : String(e) }, 502)
  }
})

// AI：生成角色绿幕图（前端自动抠图得到透明 PNG）
app.post('/api/projects/:id/ai/character/sprite', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const fingerprintPrompt = String(body?.fingerprintPrompt || '').trim()
  const posePrompt = String(body?.posePrompt || body?.prompt || '').trim()
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const negativePromptIn = String(body?.negativePrompt || '').trim()
  const style = ctx.normalizeStyleEnum(body?.style)

  const width = Number(body?.width || 720)
  const height = Number(body?.height || 1280)
  if (!fingerprintPrompt && !posePrompt) return c.json({ success: false, error: 'missing_prompt', message: 'fingerprintPrompt/posePrompt 至少填写一个' }, 400)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()

  // 2026-09-01 身份锁定（IPAdapter）：characterId → 角色锁定主参考（ai.referenceAssetId，回退 imageAssetId）。
  // 背景：纯文本指纹在动作词干扰下会丢角色（实测"大哥指着稻草堆"生成人类少年+宠物猪），
  // 必须用锁定主参考图像锚定身份；ComfyUI 侧 ipadapter 能力已由 capability-check 确认可用。
  const characterId = String(body?.characterId || '').trim()
  // 2026-09-01 IPAdapter 默认关闭（A/B 实测定论）：IPAdapter 各权重/区间档都会锚死主参考的站姿，
  // 动作词完全不生效；纯文本（指纹前置+去人类化+动物主语+动作强调）身份与动作双达标。
  // 仅当纯文本身份不稳时才用 STUDIO_SPRITE_IPADAPTER=on 打开。
  // 2026-09-01 档位入参：body.ipadapter={enabled,weight,startAt,endAt}——enabled=true 时强制走主参考
  // IPAdapter 链（无视 env 默认 off），weight/startAt/endAt 覆盖 env 默认（姿势变体管理区高级参数）。
  const ipaBody = body && typeof body.ipadapter === 'object' && body.ipadapter ? body.ipadapter : null
  const ipadapterOn = ipaBody && ipaBody.enabled === true
    ? true
    : String(process.env.STUDIO_SPRITE_IPADAPTER || '').trim().toLowerCase() === 'on'
  let referenceImages = []
  // 2026-09-16 道具泛化：body.planAssetId（道具状态变体）同样经 IPAdapter 锚定计划资产锁定主参考。
  // 实测无图锚时道具文本锚点会被模型先验带跑（细颈圆腹瓶变红盖圆柱瓶、评分 0）。
  const planAssetIdIn = String(body?.planAssetId || '').trim()
  let ipaRel = ''
  if (ipadapterOn && characterId) {
    try {
      const proj = await ctx.readJson(path.join(dir, 'project.json'))
      const ch = (proj && Array.isArray(proj.characters) ? proj.characters : []).find((x) => x && x.id === characterId) || null
      const refId = String((ch && ch.ai && ch.ai.referenceAssetId) || (ch && ch.imageAssetId) || '').trim()
      const asset = refId && proj && Array.isArray(proj.assets) ? proj.assets.find((a) => a && a.id === refId) || null : null
      ipaRel = String((asset && asset.uri) || '').trim()
    } catch (_) {}
  } else if (ipadapterOn && planAssetIdIn) {
    try {
      const planDoc = await ctx.readStoryAssetPlanIfExists(id)
      const pa = (planDoc && Array.isArray(planDoc.assets) ? planDoc.assets : []).find((a) => String(a && a.id || '').trim() === planAssetIdIn) || null
      ipaRel = String((pa && (pa.primaryReferenceAssetUri || pa.latestRecommendedReferenceAssetUri)) || '').trim()
    } catch (_) {}
  }
  ipaRel = ipaRel
    .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
    .replace(/^\/project-assets\/[^/]+\//, '')
  if (ipaRel && ipadapterOn) {
    try {
      const rel = ipaRel
      if (rel.startsWith('assets/')) {
        // 2026-09-01 实测根因：锁定主参考是 RMBG 透明底 cutout，CLIP vision 对透明区的编码是脏的，
        // IPAdapter 身份锚定完全失效（候选变成人类女性、评分 5/100）。喂给 IPAdapter 前一律合成白底
        // （python3+PIL 本机可用；失败回退原图）。产物缓存为 <原名>_flatwhite.png，源文件较新才重算。
        // 2026-09-16 修复：webp 透明 cutout 同样要合成白底（原仅 .png 生效，乌鸦主参考 webp 直通导致锚定失效生成人类少女）。
        let refAbs = path.join(dir, rel)
        if (/\.(png|webp)$/i.test(refAbs)) {
          try {
            const flatAbs = refAbs.replace(/\.(png|webp)$/i, '') + '_flatwhite.png'
            const s0 = await stat(refAbs)
            const s1 = await stat(flatAbs).catch(() => null)
            if (!(s1 && s1.mtimeMs >= s0.mtimeMs)) {
              await new Promise((resolve, reject) => {
                const py = spawn('python3', ['-c',
                  "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGBA'); bg=Image.new('RGBA', im.size, (255,255,255,255)); bg.alpha_composite(im); bg.convert('RGB').save(sys.argv[2])",
                  refAbs, flatAbs])
                py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('flatten_exit_' + code))))
                py.on('error', reject)
              })
            }
            refAbs = flatAbs
          } catch (e) {
            try { console.log(`[talkscene] ch.sprite:ipadapter_flatten_fail err=${e && e.message ? e.message : e}`) } catch (_) {}
          }
        }
        const bytes = await readFile(refAbs)
        // 权重/区间可调：全程 [0,1] + 0.85 会把主参考站姿锚死；start_at>0 放开早期构图步让动作词生效
        const w = ipaBody && Number.isFinite(Number(ipaBody.weight)) ? Number(ipaBody.weight) : Number(process.env.STUDIO_SPRITE_IPADAPTER_WEIGHT || 0.7)
        const startAt = ipaBody && Number.isFinite(Number(ipaBody.startAt)) ? Number(ipaBody.startAt) : Number(process.env.STUDIO_SPRITE_IPADAPTER_START_AT || 0.25)
        const endAt = ipaBody && Number.isFinite(Number(ipaBody.endAt)) ? Number(ipaBody.endAt) : Number(process.env.STUDIO_SPRITE_IPADAPTER_END_AT || 0.9)
        referenceImages = [{
          bytes,
          filename: `${characterId || planAssetIdIn || 'ref'}_reference.png`,
          characterId,
          weight: Number.isFinite(w) ? w : 0.7,
          startAt: Number.isFinite(startAt) ? startAt : 0.25,
          endAt: Number.isFinite(endAt) ? endAt : 0.9
        }]
      }
    } catch (e) {
      try {
        console.log(`[talkscene] ch.sprite:ipadapter_ref_fail project=${id} ch=${characterId || planAssetIdIn} err=${e && e.message ? e.message : e}`)
      } catch (_) {}
    }
  }

  // Enforce chroma background for later client-side matting.
  // 2026-09-01 修复：绿幕提示改英文并放 prompt 前部（中文提示模型读不懂、位置靠后被世界锚点压掉，实测出橙底）
  // 2026-09-01 道具模式（kind:'prop'）：角色版提示里的 "single character or single animal / no props"
  // 会把道具生成带成人类少女（实测稻草堆/木柴堆/泥土地全变女孩），道具必须明确 "single object, no character"。
  const spriteKind = String(body?.kind || '').trim().toLowerCase()
  const isPropSprite = spriteKind === 'prop'
  const chromaHint = isPropSprite
    ? `solid pure green screen background (RGB 0,255,0 chroma key green), flat uniform green, no gradient, no texture, no scene, no environment, no ground, no shadow, single object centered, no character, no animal, no person, no face, clean sharp edges`
    : `solid pure green screen background (RGB 0,255,0 chroma key green), flat uniform green, no gradient, no texture, no scene, no environment, no ground, no shadow, no props, single character or single animal centered, full body, clean sharp edges`

  // 2026-09-01 动作描述为中文时先翻译成英文（生图模型读不懂中文，实测中文动作词完全不生效，出来全是站姿）
  let poseUse = posePrompt
  if (/[\u4e00-\u9fff]/.test(poseUse)) {
    try {
      const { result: tr } = await translatePromptText({
        provider: studio.effective.prompt.provider,
        model: studio.effective.prompt.model || undefined,
        apiUrl: studio.effective.prompt.apiUrl || undefined,
        proxyUrl: studio.effective.network.proxyUrl || undefined,
        timeoutMs: 60_000,
        text: poseUse,
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      const t = String(tr && tr.translatedText || '').trim()
      if (t) poseUse = t
    } catch (_) { /* 翻译失败保留原文，不阻断生成 */ }
  }

  // 2026-09-16 修复：身份指纹为中文时同样先翻译成英文。
  // 实测根因（乌鸦喝水 2026-09-16）：plan 锚定词是中文「一只普通的黑色乌鸦…」，
  // 生图模型读不懂中文 → 身份锚点失效，姿势候选直接漂移成人类少女。
  let fingerprintUse = fingerprintPrompt
  if (/[一-鿿]/.test(fingerprintUse)) {
    try {
      const { result: tr } = await translatePromptText({
        provider: studio.effective.prompt.provider,
        model: studio.effective.prompt.model || undefined,
        apiUrl: studio.effective.prompt.apiUrl || undefined,
        proxyUrl: studio.effective.network.proxyUrl || undefined,
        timeoutMs: 60_000,
        text: fingerprintUse,
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      const t = String(tr && tr.translatedText || '').trim()
      if (t) fingerprintUse = t
    } catch (_) { /* 翻译失败保留原文，不阻断生成 */ }
  }

  // 2026-09-01 去人类化 + 动物主语包裹（拟人动物角色专用）。
  // 实测根因：指纹/动作里的 "eldest brother" 等人类称谓 + 缺主语的动作句（"pointing at the haystack"），
  // 会把组合构图拉向人类（生成人类少年+宠物猪）。称谓替换为动物角色，动作句补上动物主语。
  // 2026-09-16：物种词表补鸟类（crow/raven/bird 等）——原词表无 crow，乌鸦喝水项目主语只剩 "the character"。
  const speciesHit = String(fingerprintUse || '').match(/pig|wolf|cat|dog|rabbit|fox|bear|duck|chicken|goat|mouse|lion|tiger|panda|monkey|crow|raven|bird|sparrow|owl|eagle|goose|parrot|penguin|swan|crane/i)
  const species = speciesHit ? speciesHit[0].toLowerCase() : ''
  const dehumanize = (s) =>
    String(s || '')
      .replace(/eldest\s+brother|oldest\s+brother|second\s+brother|third\s+brother|big\s+brother|little\s+brother|younger\s+brother/gi, species || 'character')
      .replace(/\b(brother|sister|boy|girl|man|woman|kid|child|children)\b/gi, species ? `${species} character` : 'character')
  const fpUse = isPropSprite ? fingerprintUse : dehumanize(fingerprintUse)
  if (poseUse && !isPropSprite) {
    poseUse = dehumanize(poseUse)
    // 2026-09-01 动作强调：去掉 "pig:" 标签头，动作句加 (…:1.25) 权重（ComfyUI 支持权重语法）。
    // 实测普通语序下动作词会被指纹/绿幕词压掉，出来全是站桩姿势。
    poseUse = poseUse.replace(/^[^:：]{1,40}[:：]\s*/, '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
    if (poseUse) {
      const subject = species ? `the ${species} character` : 'the character'
      // 2026-09-16 物种解剖锚点：动作句内补物种解剖词，防止无鸟类词的动作（盘旋/撞击等）被动漫模型先验拽成人类少女
      // （实测乌鸦「原地盘旋」出人类女孩、评审 0 分；带 wings 的动作句则稳定出鸟）。
      const SPECIES_ANATOMY = {
        crow: 'crow wings, black beak, feathered body, bird claws',
        raven: 'raven wings, black beak, feathered body, bird claws',
        bird: 'bird wings, beak, feathered body, bird claws',
        sparrow: 'sparrow wings, small beak, feathered body',
        owl: 'owl wings, hooked beak, feathered body, owl eyes',
        eagle: 'eagle wings, hooked beak, feathered body, talons',
        goose: 'goose wings, flat beak, feathered body',
        duck: 'duck wings, flat beak, feathered body, webbed feet',
        chicken: 'chicken wings, small beak, feathered body, comb',
        parrot: 'parrot wings, curved beak, colorful feathers',
        penguin: 'penguin flippers, beak, feathered body',
        swan: 'swan wings, long neck, feathered body',
        crane: 'crane wings, long legs, long beak, feathered body',
        pig: 'pig snout, pig ears, hooves, curly tail',
        wolf: 'wolf snout, wolf ears, fur, tail',
        cat: 'cat ears, cat tail, fur, whiskers',
        dog: 'dog ears, dog snout, fur, tail',
        rabbit: 'long rabbit ears, rabbit tail, fur',
        fox: 'fox ears, fox snout, bushy tail, fur',
        bear: 'bear ears, bear snout, fur, paws',
        mouse: 'mouse ears, long tail, fur',
        lion: 'lion mane, lion tail, fur, paws',
        tiger: 'tiger stripes, tiger tail, fur, paws',
        panda: 'panda ears, black-and-white fur, round body',
        monkey: 'monkey tail, fur, monkey face',
        goat: 'goat horns, goat beard, hooves, fur'
      }
      const anatomy = species ? (SPECIES_ANATOMY[species] || `${species} anatomy, species-correct body`) : ''
      poseUse = `${subject} (${[poseUse, anatomy].filter(Boolean).join(', ')}:1.25)`
    }
  }

  const prompt = [
    // 2026-09-01 身份锚点放最前：SD 类模型前段 token 权重更高，实测指纹放第 4 位会丢角色（猪变人类少年）
    fpUse,
    chromaHint,
    poseUse,
    `style: ${style}`,
    globalPrompt
  ]
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('，')

  const negBase = [
    'text', 'watermark', 'low quality', 'blurry', 'deformed',
    'complex background', 'scenery', 'landscape', 'indoor',
    'multiple people', 'multiple animals',
    // 2026-09-01 修复：绿幕图必须排除人类与绿色元素（中文负向模型读不懂，实测出绿发绿衣人类少女）
    'human', 'person', 'human girl', 'human boy', 'anime human', 'human face', 'human skin',
    'green clothes', 'green hair', 'green hat', 'green accessories', 'green skin', 'green fur',
    'shadow', 'ground', 'environment',
    // 道具模式：角色版 chromaHint 的人类先验极强，负向必须补死（实测全出人类少女）
    ...(isPropSprite ? ['character', 'animal', 'girl', 'boy', 'woman', 'man', 'face', 'fairy', 'wings', 'person sitting', 'holding book'] : [])
  ].join(', ')

  const negativePrompt = [negativePromptIn, negBase]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(', ')

  const startedAt = Date.now()
  try {
    console.log(
      `[talkscene] ch.sprite:start project=${id} provider=${imgProvider} model=${studio.effective.image.model || '-'} w=${Math.floor(width || 0)} h=${Math.floor(height || 0)} style=${style} promptChars=${prompt.length} negChars=${negativePrompt.length} ipadapter=${referenceImages.length ? 'on' : 'off'}`
    )
  } catch (_) {}

  try {
    const gen = await generateBackgroundImage({
      prompt,
      negativePrompt,
      width,
      height,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      guidanceScale: body?.guidanceScale,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      continuity: referenceImages.length ? { ipadapterEnabled: true } : undefined,
      referenceImages,
      // 2026-09-01 动作立绘用通用 plus 模型（plus-face 人脸模型会把猪锚成人类少年，实测）
      ipadapterModel: String(process.env.STUDIO_SPRITE_IPADAPTER_MODEL || 'ip-adapter-plus_sdxl_vit-h.safetensors').trim(),
      provider: imgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: studio.effective.image.model,
      loras: studio.effective.image.loras,
      proxyUrl: studio.effective.network.proxyUrl
    })

    const buf = gen.bytes
    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const sniff = sniffImageMetaFromBytes(buf)
    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'

    const relDir = path.join('assets', 'ai', 'characters')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const fname = `ch_${Date.now()}.${ext}`
    const abs = path.join(outDir, fname)
    await writeFile(abs, buf)

    let assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    { // 2026-09-09 出图即压：姿势候选绿幕图 WebP q92
      const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.CANDIDATE).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== abs) assetPath = String(ctx.assetPathFromAbsolute(id, opt.outPath) || assetPath)
    }
    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : imgProvider
    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
    try {
      console.log(`[talkscene] ch.sprite:ok project=${id} provider=${provider} bytes=${buf.length} ext=${ext} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, provider, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`, remoteUrl, prompt, negativePrompt })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : null
    try {
      console.log(`[talkscene] ch.sprite:fail project=${id} provider=${imgProvider} status=${status == null ? '-' : status} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    if (status === 501) return c.json({ success: false, error: 'provider_not_configured', message: msg }, 501)
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// AI：绿幕图抠图（RMBG 语义分割，透明 PNG）。
// 2026-09-01:替代前端 chroma key——按颜色抠图对衣服撞色/渐变底完全不可控（实测衣服被挖穿），
// RMBG 是项目故事资产立绘已在用的成熟路径（capability-check rmbg:ok）。
app.post('/api/projects/:id/ai/character/cutout', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const relIn = String(body?.assetPath || '').trim().replace(/^\/+/, '')
  if (!relIn || !relIn.startsWith('assets/')) {
    return c.json({ success: false, error: 'missing_assetPath', message: 'assetPath 必须是项目内 assets/ 相对路径' }, 400)
  }
  const abs = path.join(dir, relIn)
  if (!abs.startsWith(dir)) return c.json({ success: false, error: 'invalid_path' }, 400)
  if (!(await ctx.existsFile(abs))) return c.json({ success: false, error: 'file_not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  const comfyuiBaseUrl = String(studio?.effective?.image?.comfyuiBaseUrl || '').trim()
  if (!comfyuiBaseUrl) return c.json({ success: false, error: 'provider_not_configured', message: 'ComfyUI 未配置' }, 501)

  const startedAt = Date.now()
  try {
    const bytes = await readFile(abs)
    const post = await generateComfyuiCutoutFromReference({
      referenceBytes: bytes,
      referenceFilename: `ch_sprite_${Date.now()}.png`,
      comfyuiBaseUrl,
      processRes: 1024,
      prefix: 'talkscene_ch_sprite/cutout_alpha',
      transparent: true
    })
    const ext = String(post.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const relDir = path.join('assets', 'ai', 'characters')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const fname = `ch_cut_${Date.now()}.${ext}`
    await writeFile(path.join(outDir, fname), post.bytes)
    let assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    { // 2026-09-09 出图即压：抠图立绘无损 WebP（真相源零质量损失）
      const absCut = path.join(outDir, fname)
      const opt = await optimizeGeneratedImage(absCut, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== absCut) assetPath = String(ctx.assetPathFromAbsolute(id, opt.outPath) || assetPath)
    }
    try {
      console.log(`[talkscene] ch.cutout:ok project=${id} bytes=${post.bytes.length} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}` })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    try {
      console.log(`[talkscene] ch.cutout:fail project=${id} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// [拆分] POST /api/projects/:id/ai/character/pose-review 已迁至 apps/server/src/routes/review.routes.js
app.post('/api/projects/:id/ai/character/pose-prompt', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterName = String(body?.characterName || '').trim()
  if (!characterName) return c.json({ success: false, error: 'missing_characterName', message: 'characterName 不能为空' }, 400)
  const fingerprintPrompt = String(body?.fingerprintPrompt || '').trim()
  const sceneText = String(body?.sceneText || '').trim()
  const userHint = String(body?.userHint || '').trim()
  // 2026-09-02 评分反馈闭环：可选评审理由，生成指令里让模型针对性改进
  const reviewFeedback = String(body?.reviewFeedback || '').trim()

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }

  const startedAt = Date.now()
  try {
    console.log(
      `[talkscene] ch.pose_prompt:start project=${id} provider=${studio.effective.prompt.provider || 'localoxml'} model=${studio.effective.prompt.model || '-'} name=${characterName} sceneChars=${sceneText.length} hintChars=${userHint.length}`
    )
  } catch (_) {}

  try {
    // 2026-09-01 实测：OMLX 偶发把 token 烧进 reasoning 导致空输出（empty_ai_output），串行重试一次兜底（不并行，守 KV 护栏）
    let gen = null
    let lastErr = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        gen = await generateCharacterPosePrompt({
          characterName,
          fingerprintPrompt,
          sceneText,
          userHint,
          reviewFeedback,
          provider: studio.effective.prompt.provider,
          model: studio.effective.prompt.model,
          apiUrl: studio.effective.prompt.apiUrl,
          proxyUrl: studio.effective.network.proxyUrl
        })
        break
      } catch (e) {
        lastErr = e
        try {
          console.log(`[talkscene] ch.pose_prompt:retry project=${id} attempt=${attempt} err=${e && e.message ? String(e.message) : String(e)}`)
        } catch (_) {}
      }
    }
    if (!gen) throw lastErr || new Error('pose_prompt_failed')
    const promptZhRaw = String(gen.result?.posePromptZh || '').trim()
    if (!promptZhRaw) throw new Error('invalid_pose_prompt_response')
    // 2026-09-01 轻量清洗：剥掉漏网的背景词（指令已禁背景，模型偶尔仍带「纯白背景」尾巴，会与绿幕提示词打架）
    const promptZh = promptZhRaw
      .replace(/[，,、；;\s]*(纯白|纯绿|纯色|单色|简洁|干净|简单)?背景[^，,、；;]*/g, '')
      .replace(/[，,、；;]{2,}/g, '，')
      .replace(/^[，,、；;\s]+|[，,、；;\s]+$/g, '')
      .trim()
    if (!promptZh) throw new Error('invalid_pose_prompt_response')
    // 中文稿 → 英文稿（生图链路只认英文；与主流程同一翻译 helper）
    const tr = await translatePromptText({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model || undefined,
      apiUrl: studio.effective.prompt.apiUrl || undefined,
      proxyUrl: studio.effective.network.proxyUrl || undefined,
      timeoutMs: 60_000,
      text: promptZh,
      sourceLang: 'zh',
      targetLang: 'en',
      mode: 'prompt'
    })
    const promptEn = String(tr.result?.translatedText || '').trim()
    if (!promptEn) throw new Error('pose_prompt_translate_empty')
    try {
      console.log(`[talkscene] ch.pose_prompt:ok project=${id} ms=${Math.max(0, Date.now() - startedAt)} zhChars=${promptZh.length} enChars=${promptEn.length}`)
    } catch (_) {}
    return c.json({ success: true, result: { promptZh, promptEn }, meta: gen.meta || null })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    try {
      console.log(`[talkscene] ch.pose_prompt:fail project=${id} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// AI：生成角色参考图（用于 IP-Adapter 锁定角色一致性；不做绿幕/抠图）
app.post('/api/projects/:id/ai/character/reference', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterName = String(body?.characterName || '').trim()
  if (!characterName) return c.json({ success: false, error: 'missing_characterName', message: 'characterName 不能为空' }, 400)
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const fingerprintPrompt = String(body?.fingerprintPrompt || '').trim()
  const negativePromptIn = String(body?.negativePrompt || '').trim()
  const style = ctx.normalizeStyleEnum(body?.style)
  const width = ctx.clampInt(body?.width, 256, 1536, 768)
  const height = ctx.clampInt(body?.height, 256, 1536, 768)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()

  const refHint =
    `Reference portrait for a single character,` +
    ` clean simple background (light neutral),` +
    ` chest-up or half-body,` +
    ` looking at camera,` +
    ` consistent outfit and face,` +
    ` no extra characters, no props unless described,` +
    ` no scene environment`

  const prompt = [
    globalPrompt,
    `风格：${ctx.styleNameZh(style)}（${style}）`,
    `角色名：${characterName}`,
    fingerprintPrompt,
    refHint
  ]
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('，')

  const negBase = [
    'text',
    'watermark',
    'logo',
    'qr code',
    'low quality',
    'blurry',
    'deformed',
    'photorealistic',
    'realistic skin texture',
    'multiple characters',
    'crowd',
    'complex background',
    'busy environment'
  ].join(', ')

  const negativePrompt = [negativePromptIn, negBase].map((s) => String(s || '').trim()).filter(Boolean).join(', ')

  const startedAt = Date.now()
  try {
    console.log(
      `[talkscene] ch.ref:start project=${id} provider=${imgProvider} model=${studio.effective.image.model || '-'} name=${characterName} w=${width} h=${height} style=${style} promptChars=${prompt.length}`
    )
  } catch (_) {}

  try {
    const gen = await generateBackgroundImage({
      prompt,
      negativePrompt,
      width,
      height,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      guidanceScale: body?.guidanceScale,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      provider: imgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: studio.effective.image.model,
      loras: studio.effective.image.loras,
      proxyUrl: studio.effective.network.proxyUrl
    })

    const buf = gen.bytes
    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const sniff = sniffImageMetaFromBytes(buf)
    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'

    const relDir = path.join('assets', 'ai', 'character_refs')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const safe = String(characterName || 'character').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_').slice(0, 24) || 'character'
    const fname = `ref_${safe}_${Date.now()}.${ext}`
    const abs = path.join(outDir, fname)
    await writeFile(abs, buf)

    let assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    { // 2026-09-09 出图即压：角色主参考无损 WebP（真相源零质量损失）
      const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== abs) assetPath = String(ctx.assetPathFromAbsolute(id, opt.outPath) || assetPath)
    }
    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : imgProvider
    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
    try {
      console.log(`[talkscene] ch.ref:ok project=${id} provider=${provider} bytes=${buf.length} ext=${ext} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, provider, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`, remoteUrl, prompt, negativePrompt })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : null
    try {
      console.log(`[talkscene] ch.ref:fail project=${id} provider=${imgProvider} status=${status == null ? '-' : status} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    if (status === 501) return c.json({ success: false, error: 'provider_not_configured', message: msg }, 501)
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// 2026-10-05 编辑器生产构建托管：apps/editor/dist 由本服务直接伺服（入口 / 与 /assets/*）。
// 以后编辑器改动 = 构建 + 本服务重启；前端 buildId 探针发现变化即自动刷新——
// 日常不再需要 Vite dev 服务器，也不再有"改了界面浏览器不更新"的缓存纠缠。
// [拆分回收] 辅助定义 已回 index.js
const editorDistReady = existsSync(path.join(ctx.EDITOR_DIST, 'index.html'))
if (editorDistReady) {
  app.use('/assets/*', serveStatic({ root: ctx.EDITOR_DIST }))
  app.get('/', async (c) => {
    const html = await readFile(path.join(ctx.EDITOR_DIST, 'index.html'), 'utf-8').catch(() => null)
    if (!html) return c.text('talkscene_server')
    return c.html(html)
  })
} else {
  app.get('/', (c) => c.text('talkscene_server'))
}
}
