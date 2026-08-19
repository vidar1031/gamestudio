// 图片生成审核记录：出图前（pre_generate）、锁定确认（lock_confirm）、场景绑定（scene_bind）
// 存储于 <project>/reviews/image_reviews.jsonl，人工 approve 后才执行生成或写回。
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'

function nowIso() {
  return new Date().toISOString()
}

function asStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function reviewsFilePath(projectDirPath) {
  return path.join(projectDirPath, 'reviews', 'image_reviews.jsonl')
}

async function readAllReviews(projectDirPath) {
  try {
    const raw = await readFile(reviewsFilePath(projectDirPath), 'utf-8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) } catch (_) { return null }
      })
      .filter((item) => item && typeof item === 'object')
  } catch (_) {
    return []
  }
}

async function writeAllReviews(projectDirPath, list) {
  const file = reviewsFilePath(projectDirPath)
  await mkdir(path.dirname(file), { recursive: true })
  const body = list.map((item) => JSON.stringify(item)).join('\n') + '\n'
  await writeFile(file, body)
}

export async function listImageReviews(projectDirPath, { status = '' } = {}) {
  const all = await readAllReviews(projectDirPath)
  const filtered = status ? all.filter((item) => item.status === status) : all
  return filtered.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

export async function findPendingReview(projectDirPath, { phase, targetKey }) {
  const all = await readAllReviews(projectDirPath)
  return all.find((item) => item.status === 'pending' && item.phase === phase && asStr(item.targetKey) === asStr(targetKey)) || null
}

export async function getImageReview(projectDirPath, reviewId) {
  const all = await readAllReviews(projectDirPath)
  return all.find((item) => asStr(item.reviewId) === asStr(reviewId)) || null
}

export async function createImageReview(projectDirPath, {
  phase,
  targetKey = '',
  assetId = '',
  sceneId = '',
  prompt = '',
  negativePrompt = '',
  referenceImages = [],
  params = {},
  execute = null,
  resultImagePath = '',
  aiReview = null
}) {
  const all = await readAllReviews(projectDirPath)
  const review = {
    reviewId: `imgrev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    schemaVersion: '1.0',
    phase: asStr(phase),
    targetKey: asStr(targetKey),
    assetId: asStr(assetId),
    sceneId: asStr(sceneId),
    prompt: asStr(prompt),
    negativePrompt: asStr(negativePrompt),
    referenceImages: Array.isArray(referenceImages) ? referenceImages : [],
    params: params && typeof params === 'object' ? params : {},
    execute: execute && typeof execute === 'object' ? execute : null,
    resultImagePath: asStr(resultImagePath),
    aiReview: aiReview && typeof aiReview === 'object' ? aiReview : null,
    status: 'pending',
    createdAt: nowIso(),
    decidedAt: '',
    decidedBy: '',
    rejectReason: ''
  }
  all.push(review)
  await writeAllReviews(projectDirPath, all)
  return review
}

export async function attachImageReviewResult(projectDirPath, reviewId, { resultImagePath = '', aiReview = null }) {
  const all = await readAllReviews(projectDirPath)
  const idx = all.findIndex((item) => asStr(item.reviewId) === asStr(reviewId))
  if (idx < 0) return null
  if (resultImagePath) all[idx].resultImagePath = asStr(resultImagePath)
  if (aiReview) all[idx].aiReview = aiReview
  await writeAllReviews(projectDirPath, all)
  return all[idx]
}

export async function decideImageReview(projectDirPath, reviewId, { approved, decidedBy = 'user', rejectReason = '' }) {
  const all = await readAllReviews(projectDirPath)
  const idx = all.findIndex((item) => asStr(item.reviewId) === asStr(reviewId))
  if (idx < 0) return null
  if (all[idx].status !== 'pending') return all[idx]
  all[idx].status = approved ? 'approved' : 'rejected'
  all[idx].decidedAt = nowIso()
  all[idx].decidedBy = asStr(decidedBy) || 'user'
  all[idx].rejectReason = approved ? '' : asStr(rejectReason)
  await writeAllReviews(projectDirPath, all)
  return all[idx]
}
