// 故事资产主参考写入门禁（S4-01）。
// 规则：仅「视觉评审真实通过」且「候选文件真实存在且为有效图片」的候选，
// 才允许写入 primaryReferenceAssetUri；其余路径显式失败（FAIL/BLOCKED），禁止写假引用。
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// 从字节 sniff 图片格式（PNG/JPEG/GIF/WEBP），无法识别返回 null。
// 该判定与生成/线稿链路共用，保证「写入引用」与「生成落盘」使用同一格式标准。
export function sniffImageMetaFromBytes(buf) {
  try {
    if (!buf || typeof buf.length !== 'number') return null
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' }
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    )
      return { ext: 'png', contentType: 'image/png' }
    // GIF: GIF87a / GIF89a
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', contentType: 'image/gif' }
    // WEBP: RIFF....WEBP
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    )
      return { ext: 'webp', contentType: 'image/webp' }
  } catch (_) {}
  return null
}

// 校验候选文件：必须位于项目目录内、真实存在、非空且为可识别图片。
// 返回 { ok: true, absPath, relPath, sniff } 或 { ok: false, code, message }。
export async function verifyStoryAssetReferenceFile({ dir, assetPath }) {
  const rel = String(assetPath || '').trim().replace(/^\/+/, '')
  if (!rel) return { ok: false, code: 'reference_file_missing', message: '主参考文件路径为空，禁止写入引用。' }
  const root = path.resolve(dir)
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, code: 'reference_path_outside_project', message: `主参考路径越出项目目录，已拒绝：${rel}` }
  }
  let buf = null
  try {
    buf = await readFile(abs)
  } catch (_) {
    return { ok: false, code: 'reference_file_missing', message: `主参考文件不存在，禁止写入引用：${rel}` }
  }
  if (!buf || !buf.length) {
    return { ok: false, code: 'reference_file_empty', message: `主参考文件为空，禁止写入引用：${rel}` }
  }
  const sniff = sniffImageMetaFromBytes(buf)
  if (!sniff) {
    return { ok: false, code: 'reference_file_invalid', message: `主参考文件不是有效图片，禁止写入引用：${rel}` }
  }
  return { ok: true, absPath: abs, relPath: rel, sniff }
}

// 判定评审记录是否真实通过。
// 无记录 / 评审被跳过（skipped，含「未启用视觉判定」的兜底假通过）/ 评审未通过，均视为不可写入。
export function evaluateStoryAssetReferenceReview(analysis) {
  const review = analysis && typeof analysis === 'object' ? analysis : null
  if (!review) {
    return { passed: false, code: 'review_record_missing', message: '候选图缺少可追溯评审记录，禁止写入主参考。' }
  }
  if (review.skipped) {
    const reason = String(
      review.reviewError ||
      (Array.isArray(review.issues) ? review.issues.filter(Boolean).join('；') : '') ||
      review.summary ||
      '视觉评审未执行'
    ).trim()
    return { passed: false, code: 'review_unavailable', message: `视觉评审未真实执行，禁止写入主参考。原因：${reason}` }
  }
  if (!review.passed) {
    const scoreText = Number.isFinite(Number(review.score)) ? `（${Math.round(Number(review.score))} 分）` : ''
    const summary = String(review.summary || '').trim()
    return {
      passed: false,
      code: 'review_not_passed',
      message: `视觉评审未通过${scoreText}，禁止写入主参考。${summary}`
    }
  }
  return { passed: true, code: '', message: '' }
}
