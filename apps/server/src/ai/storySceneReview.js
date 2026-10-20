/**
 * GS-53 场景图审核（守护台审图中心接入，V1.2）。
 *
 * 故事复核验收阶段：逐场景把「整图 + 场景描述 + 身份锚点 + 全局规则」提交到
 * 守护台审图中心（control image-reviews），拿回 score/issues/suggestions/verdict，
 * 逐场景落 <project>/reviews/scene_reviews.jsonl（review/feedback_pending/human_confirmed 三类记录），
 * 供编辑器「场景图审核」面板展示与打回重出。
 *
 * 整图来源优先级：
 * ① 最新走查报告（walkthrough/report_*.json + 同目录 p*_*.png 截图）能映射到 sceneId 的截图
 *   （走查路径确定性重枚举：截图序号 NN ↔ pathDef[NN-1].nodeId）；
 * ② 无则用场景绑定背景图（story 节点 visuals.backgroundAssetId -> project.assets[].uri），
 *   结果标注 imageSource:'background_only'（未合成摆位）。
 *
 * 失败语义：control 不可达/评审失败 -> 显式错误（不写假结论）；调用方把 ai task 标 failed。
 */

import fs from 'node:fs'
import path from 'node:path'
import { getCraftSkill } from './craftLibrary.js'

const CONTROL_DEFAULT_BASE_URL = 'http://127.0.0.1:2099'
const REVIEW_CHUNK_SIZE = 4 // 审图中心 ≤4 同步返回；>4 转 202 轮询
const REVIEW_POLL_INTERVAL_MS = 3000
const REVIEW_POLL_TIMEOUT_MS = 900000

function asStr(v) { return typeof v === 'string' ? v : '' }
function asList(v) { return Array.isArray(v) ? v : [] }

function controlBaseUrl() {
  return String(process.env.STUDIO_CONTROL_BASE_URL || CONTROL_DEFAULT_BASE_URL).replace(/\/+$/, '')
}

// 凭证读取照 resourceLease.js 约定（STUDIO_CONTROL_CLIENT_ID/KEY，缺省按本机操作员通道兜底）
function controlHeaders() {
  const clientId = String(process.env.STUDIO_CONTROL_CLIENT_ID || 'talkscene').trim()
  const key = String(process.env.STUDIO_CONTROL_CLIENT_KEY || '').trim()
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (key) {
    headers['x-client-id'] = clientId
    headers.Authorization = `Bearer ${key}`
  }
  return headers
}

async function postControl(pathname, body, timeoutMs = 120000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 120000))
  try {
    const res = await fetch(`${controlBaseUrl()}${pathname}`, {
      method: 'POST',
      headers: controlHeaders(),
      body: JSON.stringify(body || {}),
      signal: controller.signal
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) {
      const err = new Error(String(payload?.detail || payload?.error || `control_http_${res.status}`))
      err.code = 'control_request_failed'
      throw err
    }
    return payload
  } catch (error) {
    if (error?.code === 'control_request_failed') throw error
    const err = new Error(`control_unreachable:${error instanceof Error ? error.message : String(error)}`)
    err.code = 'control_unreachable'
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function getControl(pathname, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 30000))
  try {
    const res = await fetch(`${controlBaseUrl()}${pathname}`, { headers: controlHeaders(), signal: controller.signal })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.ok) {
      const err = new Error(String(payload?.detail || payload?.error || `control_http_${res.status}`))
      err.code = 'control_request_failed'
      throw err
    }
    return payload
  } catch (error) {
    if (error?.code === 'control_request_failed') throw error
    const err = new Error(`control_unreachable:${error instanceof Error ? error.message : String(error)}`)
    err.code = 'control_unreachable'
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 走查截图 -> sceneId 映射（确定性重枚举同一批路径：截图序号 NN ↔ pathDef[NN-1].nodeId）
// ---------------------------------------------------------------------------
function enumerateStoryPaths(nodes, maxPaths = 8) {
  const list = asList(nodes)
  const byId = new Map(list.map((n) => [asStr(n && n.id).trim(), n]).filter(([id]) => id))
  const startNode = list.find((n) => n && n.kind === 'scene' && asStr(n.id).trim()) || list[0]
  const startId = asStr(startNode && startNode.id).trim()
  if (!startId) return []
  const paths = []
  const dfs = (nodeId, acc, depth) => {
    if (paths.length >= maxPaths) return
    if (depth > 24) return
    const node = byId.get(nodeId)
    if (!node) return
    const nextAcc = acc.concat([{ nodeId, name: asStr(node.name || '').trim() }])
    const choices = asList(node && node.choices)
    if (!choices.length) {
      paths.push(nextAcc)
      return
    }
    for (const ch of choices) {
      if (paths.length >= maxPaths) break
      const toNodeId = asStr(ch && ch.toNodeId).trim()
      if (!toNodeId) continue
      if (nextAcc.some((x) => x.nodeId === toNodeId)) continue // 防环
      dfs(toNodeId, nextAcc.concat([{ viaChoice: asStr(ch.text || '').trim(), nodeId: toNodeId }]), depth + 1)
    }
  }
  dfs(startId, [], 0)
  return paths
}

function collectWalkthroughShotsByScene({ dir, story, sceneIds }) {
  const outDir = path.join(dir, 'walkthrough')
  let reportFile = null
  try {
    const files = fs.readdirSync(outDir).filter((f) => /^report_.*\.json$/.test(f)).sort()
    reportFile = files.length ? files[files.length - 1] : null
  } catch {
    return new Map()
  }
  if (!reportFile) return new Map()
  let report = null
  try {
    report = JSON.parse(fs.readFileSync(path.join(outDir, reportFile), 'utf8'))
  } catch {
    return new Map()
  }
  const reports = asList(report && report.reports)
  const sceneSet = new Set(sceneIds)
  const bySceneId = new Map()
  for (let i = 0; i < reports.length; i += 1) {
    const shots = asList(reports[i] && reports[i].screenshots)
    // 2026-10-15 根修 v2：按路径节点名对位（报告的 pathNames 与内容截图天然同序同数），
    // 不再依赖 pathDef 重枚举（枚举会带中间节点导致错位；实证四岁抉择被错配到 hold_6）。
    // choice 截图为选项界面不入评（只取 start/hold 内容截图）。
    const contentShots = shots.filter((shot) => !String(shot || '').includes('_choice_'))
    const pathNames = asList(reports[i] && reports[i].pathNames)
    const nameToNode = new Map(asList(story && story.nodes).map((n) => [asStr(n && n.name || '').trim(), n]).filter(([nm]) => nm))
    for (let k = 0; k < contentShots.length; k += 1) {
      const shot = contentShots[k]
      const sceneName = asStr(pathNames[k] || '').trim()
      const node = sceneName ? nameToNode.get(sceneName) : null
      const nodeId = asStr(node && node.id).trim()
      if (!nodeId || !sceneSet.has(nodeId) || bySceneId.has(nodeId)) continue
      const absPath = path.join(outDir, shot)
      if (!fs.existsSync(absPath)) continue
      bySceneId.set(nodeId, { absPath, file: shot, reportFile, pathId: `p${i + 1}` })
    }
  }
  return bySceneId
}

// 场景绑定背景图回退：story 节点 visuals.backgroundAssetId -> project.assets[].uri
function resolveSceneBackgroundPath({ dir, story, project, sceneId }) {
  const nodes = asList(story && story.nodes)
  const node = nodes.find((n) => asStr(n && n.id).trim() === sceneId)
  const backgroundAssetId = asStr(node && node.visuals && node.visuals.backgroundAssetId).trim()
  if (!backgroundAssetId) return null
  const assets = asList(project && project.assets)
  const asset = assets.find((a) => asStr(a && a.id).trim() === backgroundAssetId)
  const uri = asStr(asset && asset.uri).trim().replace(/^\/+/, '')
  if (!uri) return null
  const absPath = path.join(dir, uri)
  return fs.existsSync(absPath) ? absPath : null
}

/**
 * 收集逐场景评审输入（图片 + 描述 + 锚点）。
 * 返回 { inputs: [{sceneId, sceneName, imagePath, imageSource}], anchors, globalRules }
 */
export function collectSceneReviewInputs({ dir, projectId, story, plan, project, sceneIds }) {
  void projectId
  const scenes = asList(plan && plan.scenes)
  const wanted = asList(sceneIds).map((s) => asStr(s).trim()).filter(Boolean)
  const targetScenes = wanted.length ? scenes.filter((s) => wanted.includes(asStr(s.sceneId).trim())) : scenes
  const storyNodes = asList(story && story.nodes)
  const shotsBySceneId = collectWalkthroughShotsByScene({ dir, story, sceneIds: targetScenes.map((s) => asStr(s.sceneId).trim()) })
  const inputs = []
  const acceptanceCriteriaSet = []
  for (const scene of targetScenes) {
    const sceneId = asStr(scene && scene.sceneId).trim()
    if (!sceneId) continue
    const node = storyNodes.find((n) => asStr(n && n.id).trim() === sceneId)
    const shot = shotsBySceneId.get(sceneId)
    const backgroundPath = shot ? null : resolveSceneBackgroundPath({ dir, story, project, sceneId })
    const imagePath = shot ? shot.absPath : backgroundPath
    if (!imagePath) continue // 无图场景跳过（不编造评审对象）
    const body = node && node.body && typeof node.body === 'object' ? node.body : {}
    const composition = scene.composition && typeof scene.composition === 'object' ? scene.composition : null
    const compositionText = composition
      ? [
          asStr(composition.cameraNote).trim(),
          ...asList(composition.items).slice(0, 8).map((item) => {
            const subject = asStr(item && (item.subjectId || item.name)).trim()
            const blocking = asStr(item && item.blocking).trim()
            return [subject, blocking].filter(Boolean).join('：')
          })
        ].filter(Boolean).join('；')
      : ''
    // V1.3 验收标准注入：构图项带 skillIds 时，把对应技能件的 acceptance[] 逐条注入评审描述
    const acceptanceLines = []
    if (composition) {
      const seenSkill = new Set()
      for (const item of asList(composition.items)) {
        for (const skillId of asList(item && item.skillIds).map((x) => asStr(x).trim()).filter(Boolean)) {
          if (seenSkill.has(skillId)) continue
          seenSkill.add(skillId)
          const skill = getCraftSkill(skillId)
          const acceptance = asList(skill && skill.acceptance).map((x) => asStr(x).trim()).filter(Boolean)
          if (skill && acceptance.length) {
            const line = `该场景使用了技能件：${asStr(skill.name).trim() || skillId}。验收标准：${acceptance.join('；')}`
            acceptanceLines.push(line)
            // V1.2 双通道：验收标准同时进 control context.acceptanceCriteria（批次级并集核查）
            for (const criterion of acceptance) {
              if (!acceptanceCriteriaSet.includes(criterion)) acceptanceCriteriaSet.push(criterion)
            }
          }
        }
      }
    }
    // 2026-10-18 剧情状态一致性维：把该场景的状态期望（每资产剧情状态）注入评审描述与验收标准。
    // 例："盘：空盘（empty_plate）；孔融：持小梨（holding_small_pear）"——评审据此判状态违例（结局二盘应为空等）。
    const stateLines = []
    const sceneAssets = asList(plan && plan.assets)
    for (const asset of sceneAssets) {
      for (const req of asList(asset && asset.stateRequirements)) {
        const sceneIdsOfReq = asList(req && req.sceneIds).map((x) => asStr(x).trim())
        if (!sceneIdsOfReq.includes(sceneId)) continue
        const stateKey = asStr(req && req.stateKey).trim()
        if (!stateKey || stateKey === 'unchanged') continue
        const stateLabel = asStr(req && req.stateLabel).trim() || stateKey
        stateLines.push(`${asStr(asset && asset.name).trim() || asStr(asset && asset.id).trim()}：应呈现状态「${stateLabel}」（${stateKey}）`)
        acceptanceCriteriaSet.push(`剧情状态一致性：${asStr(asset && asset.name).trim() || asStr(asset && asset.id).trim()} 应呈现状态「${stateLabel}」（${stateKey}），不一致即为状态违例`)
      }
    }
    inputs.push({
      sceneId,
      sceneName: asStr(scene.sceneName).trim() || asStr(body.title).trim() || sceneId,
      imagePath,
      imageSource: shot ? 'walkthrough' : 'background_only',
      description: [
        `场景「${asStr(scene.sceneName).trim() || sceneId}」`,
        asStr(scene.summary).trim() || asStr(body.text).trim().slice(0, 600),
        compositionText ? `导演构图：${compositionText}` : '',
        ...acceptanceLines,
        ...(stateLines.length ? [`剧情状态期望：${stateLines.join('；')}`] : [])
      ].filter(Boolean).join('。').slice(0, 1500)
    })
  }

  // 身份锚点：plan 资产（character/prop）name + anchorPrompt
  const anchors = asList(plan && plan.assets)
    .filter((asset) => ['character', 'prop'].includes(asStr(asset && asset.category).trim()))
    .map((asset) => `${asStr(asset.name).trim() || asStr(asset.id).trim()}：${asStr(asset.anchorPrompt).trim()}`)
    .filter((line) => !line.endsWith('：'))
    .join('\n')
    .slice(0, 3000)
  // 全局规则：世界锚点 + 绘本风约定
  const globalRules = [
    asStr(plan && plan.worldAnchor).trim(),
    '统一画风：卡通童话绘本插画，平面 2D，干净粗描边，赛璐璐上色，温暖柔和色彩；无现代元素、无水印、无乱码文字'
  ].filter(Boolean).join('\n').slice(0, 3000)

  return { inputs, anchors, globalRules, acceptanceCriteria: acceptanceCriteriaSet }
}

async function submitAndWaitReview({ projectId, images, context }) {
  // 2026-10-15 实测：4 张同步评审在 LLM  contention 下单张 50-60s（合计 200s+），
  // 180s 超时被中止（control_unreachable: aborted 三连根因）；评审属分钟级长任务，放宽到 600s。
  const payload = await postControl('/api/control/image-reviews', {
    images,
    context,
    projectId
  }, 600000)
  if (!payload.reviewId) {
    const err = new Error('control_review_missing_id')
    err.code = 'control_review_missing_id'
    throw err
  }
  if (payload.status === 'done' && Array.isArray(payload.results)) {
    return { reviewId: payload.reviewId, results: payload.results }
  }
  // >4 张：202 异步，轮询详情直到 done（审图中心内部已串行，调用方简单轮询）
  const deadline = Date.now() + REVIEW_POLL_TIMEOUT_MS
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, REVIEW_POLL_INTERVAL_MS))
    const detail = await getControl(`/api/control/image-reviews/${encodeURIComponent(payload.reviewId)}`)
    const review = detail && detail.review
    if (review && review.status === 'done') {
      return { reviewId: payload.reviewId, results: asList(review.results) }
    }
    if (review && review.status === 'failed') {
      const err = new Error(`control_review_failed:${asStr(review.error).trim() || 'unknown'}`)
      err.code = 'control_review_failed'
      throw err
    }
    if (Date.now() >= deadline) {
      const err = new Error('control_review_timeout')
      err.code = 'control_review_timeout'
      throw err
    }
  }
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * 执行逐场景评审：收集 -> 提交审图中心（分片 ≤4/张，>4 自动走 202 轮询）-> 落盘 -> 汇总。
 * onProgress(message) 供 ai task 逐场景进度。失败显式抛出（不写假结论）。
 */
export async function runStorySceneReview({ id, dir, story, plan, project, sceneIds, onProgress }) {
  const { inputs, anchors, globalRules, acceptanceCriteria } = collectSceneReviewInputs({ dir, projectId: id, story, plan, project, sceneIds })
  if (!inputs.length) {
    const err = new Error('无可评审的场景图片（走查截图与场景背景图均缺失）')
    err.code = 'scene_review_no_images'
    throw err
  }

  const reviewLogFile = path.join(dir, 'reviews', 'scene_reviews.jsonl')
  const results = []
  // 一轮运行一个 roundId（分片产生多个 control reviewId；面板按 roundId 聚合一轮完整结果）
  const roundId = `sround_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  // 分片提交（审图中心 ≤4 同步；>4 其内部转 202，本方轮询同等待）
  for (let offset = 0; offset < inputs.length; offset += REVIEW_CHUNK_SIZE) {
    const chunk = inputs.slice(offset, offset + REVIEW_CHUNK_SIZE)
    onProgress && onProgress(`评审中：第 ${offset + 1}-${Math.min(offset + chunk.length, inputs.length)} 个场景（共 ${inputs.length} 个）…`)
    const { reviewId, results: chunkResults } = await submitAndWaitReview({
      projectId: id,
      images: chunk.map((input) => ({ path: input.imagePath, description: input.description, sceneId: input.sceneId })),
      context: { globalRules, anchors, rubricTemplate: 'story_scene', ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}) }
    })
    for (let i = 0; i < chunk.length; i += 1) {
      const input = chunk[i]
      const result = chunkResults.find((r) => String(r?.sceneId || '') === input.sceneId) || chunkResults[i] || null
      if (!result || result.ok !== true) {
        const detail = asStr(result && (result.detail || result.error)).trim() || 'review_failed'
        const err = new Error(`场景「${input.sceneName}」评审失败：${detail}`)
        err.code = 'scene_review_item_failed'
        throw err
      }
      results.push({
        sceneId: input.sceneId,
        sceneName: input.sceneName,
        score: result.score,
        verdict: result.verdict,
        issues: asList(result.issues),
        suggestions: asList(result.suggestions),
        thumbnailDataUrl: result.thumbnailDataUrl || null,
        imageSource: input.imageSource,
        reviewId
      })
      appendJsonl(reviewLogFile, {
        at: new Date().toISOString(),
        kind: 'review',
        roundId,
        reviewId,
        sceneId: input.sceneId,
        sceneName: input.sceneName,
        score: result.score,
        verdict: result.verdict,
        issues: asList(result.issues),
        suggestions: asList(result.suggestions),
        imageSource: input.imageSource,
        imageFile: input.imagePath ? path.relative(dir, input.imagePath) : null
      })
      onProgress && onProgress(`场景「${input.sceneName}」评审完成：${result.score} 分 ${result.verdict}`)
    }
  }

  const summary = {
    pass: results.filter((r) => r.verdict === 'pass').length,
    suspect: results.filter((r) => r.verdict === 'suspect').length,
    fail: results.filter((r) => r.verdict === 'fail').length
  }
  const reviewIds = [...new Set(results.map((r) => r.reviewId).filter(Boolean))]
  return { results, summary, reviewIds, roundId, reviewLogFile }
}

/**
 * 写人工处置记录（打回重出反馈待处理 / 人工确认通过）。
 */
export function appendSceneReviewFeedback({ dir, sceneId, action, note, sceneName }) {
  const act = String(action || '').trim()
  if (!['feedback_pending', 'human_confirmed'].includes(act)) {
    const err = new Error(`未知处置动作：${act}`)
    err.code = 'scene_review_feedback_invalid'
    throw err
  }
  const record = {
    at: new Date().toISOString(),
    kind: act,
    sceneId: asStr(sceneId).trim(),
    sceneName: asStr(sceneName).trim() || null,
    note: asStr(note).trim() || null
  }
  appendJsonl(path.join(dir, 'reviews', 'scene_reviews.jsonl'), record)
  return record
}

/**
 * 读最新一轮审核记录（scene_reviews.jsonl 尾部 review 类按 reviewId 分组取最新 + 后续处置）。
 */
export function readLatestSceneReviewRound({ dir }) {
  const file = path.join(dir, 'reviews', 'scene_reviews.jsonl')
  let lines = []
  try {
    if (!fs.existsSync(file)) return { latest: null, rounds: [] }
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return { latest: null, rounds: [] }
  }
  const records = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch { /* 坏行跳过 */ }
  }
  const reviews = records.filter((r) => r && r.kind === 'review' && (r.roundId || r.reviewId))
  const roundKeyOf = (r) => String(r.roundId || r.reviewId)
  const roundIds = [...new Set(reviews.map(roundKeyOf))]
  const latestId = roundIds[roundIds.length - 1] || null
  if (!latestId) return { latest: null, rounds: [] }
  const latestRecords = reviews.filter((r) => roundKeyOf(r) === latestId)
  const feedback = records.filter((r) => r && (r.kind === 'feedback_pending' || r.kind === 'human_confirmed'))
  const summary = {
    pass: latestRecords.filter((r) => r.verdict === 'pass').length,
    suspect: latestRecords.filter((r) => r.verdict === 'suspect').length,
    fail: latestRecords.filter((r) => r.verdict === 'fail').length
  }
  return {
    latest: {
      reviewId: latestId,
      at: latestRecords[0]?.at || null,
      records: latestRecords,
      feedback,
      summary
    },
    rounds: roundIds
  }
}
