// 2026-09-09 生成图压缩治理（用户指令：ComfyUI 出图即压，禁止大图无限爆涨）。
// 分层策略：
// - sprite/立绘/道具（透明真相源，IPAdapter/线稿/RMBG 反复引用）：无损 WebP（零质量损失，体积 ~40-60%）
// - 场景背景（无透明需求）：JPEG q90
// - 候选/线稿/测试图（中间产物，选图用）：WebP q92
// 统一走 python3+PIL（项目既有依赖，与 ch.sprite 白底合成同款）。
import { spawn } from 'node:child_process'
import { stat, readFile, writeFile, unlink, rename, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

export const IMAGE_KIND = Object.freeze({
  SPRITE_LOSSLESS: 'sprite_lossless', // 立绘/道具/cutout：无损 WebP
  SCENE_BG: 'scene_bg',               // 场景背景：JPEG q90
  CANDIDATE: 'candidate'              // 候选/绿幕/线稿/测试图：WebP q92
})

function targetPathFor(absPath, kind) {
  if (kind === IMAGE_KIND.SCENE_BG) return absPath.replace(/\.(png|jpe?g|webp)$/i, '.jpg')
  return absPath.replace(/\.(png|jpe?g|webp)$/i, '.webp')
}

// 压缩单个文件：按 kind 转格式并原地替换（原文件删除，新文件同路径新扩展名）。
// 返回 { ok, outPath?, srcBytes, dstBytes, skipped?, reason? }；已是目标格式或小于阈值则 skipped。
export async function optimizeImageFile(absPath, kind, { minBytes = 200 * 1024, force = false } = {}) {
  const st = await stat(absPath).catch(() => null)
  if (!st || !st.isFile()) return { ok: false, reason: 'file_not_found' }
  const extOk = kind === IMAGE_KIND.SCENE_BG ? /\.jpg$/i.test(absPath) : /\.webp$/i.test(absPath)
  if (!force && extOk) return { ok: true, skipped: true, reason: 'already_optimized', srcBytes: st.size, dstBytes: st.size, outPath: absPath }
  if (!force && st.size < minBytes && extOk) return { ok: true, skipped: true, reason: 'below_threshold', srcBytes: st.size, dstBytes: st.size, outPath: absPath }

  const outPath = targetPathFor(absPath, kind)
  const pyScript = `
import sys
from PIL import Image
kind, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
im = Image.open(src)
if kind == 'bg':
    im.convert('RGB').save(dst, 'JPEG', quality=90, optimize=True)
elif kind == 'lossless':
    im.convert('RGBA').save(dst, 'WEBP', lossless=True, quality=100, method=6)
else:
    im.convert('RGBA').save(dst, 'WEBP', quality=92, method=4)
`
  await new Promise((resolve, reject) => {
    const pyKind = kind === IMAGE_KIND.SCENE_BG ? 'bg' : (kind === IMAGE_KIND.SPRITE_LOSSLESS ? 'lossless' : 'candidate')
    const py = spawn('python3', ['-c', pyScript, pyKind, absPath, outPath])
    let err = ''
    py.stderr.on('data', (c) => { err += c })
    py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`optimize_exit_${code}:${err.slice(0, 240)}`))))
    py.on('error', reject)
  })
  const dst = await stat(outPath)
  if (path.resolve(outPath) !== path.resolve(absPath)) {
    // 新扩展名落盘成功后再删原图（失败已在上面 reject，原图保留）
    await unlink(absPath).catch(() => {})
  }
  return { ok: true, outPath, srcBytes: st.size, dstBytes: dst.size }
}

// 生成写盘点统一入口：写完图后调用，返回压缩后的新文件名（调用方据此改写 assetPath/uri）。
export async function optimizeGeneratedImage(absPath, kind) {
  const result = await optimizeImageFile(absPath, kind, { force: false })
  return result
}

// 存量批压：扫描目录下全部 PNG/JPG（不递归 _originals），按规则分类压缩。
// 返回 { total, compressed, skipped, failed, srcBytes, dstBytes, rewrites:[{from,to}] }
export async function optimizeDirectoryTree(rootDir, { minBytes = 200 * 1024 } = {}) {
  const result = { total: 0, compressed: 0, skipped: 0, failed: 0, srcBytes: 0, dstBytes: 0, rewrites: [] }
  const walk = async (dir) => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const item of items) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) {
        if (item.name === '_originals') continue
        await walk(full)
        continue
      }
      if (!/\.(png|jpe?g)$/i.test(item.name)) continue
      result.total += 1
      // 分类：story_scenes→背景 JPEG；selected_cutout/立绘/cutout（名字含 cut 或路径含 story_assets/character|prop 的 selected_）→无损；其余→q92
      const isScene = /story_scenes/i.test(full)
      const isCutoutOrSelected = /_cut_|selected_cutout|ch_cut_|_flatwhite/i.test(item.name)
      const kind = isScene ? IMAGE_KIND.SCENE_BG : (isCutoutOrSelected ? IMAGE_KIND.SPRITE_LOSSLESS : IMAGE_KIND.CANDIDATE)
      try {
        const r = await optimizeImageFile(full, kind, { minBytes })
        result.srcBytes += r.srcBytes || 0
        result.dstBytes += r.dstBytes || 0
        if (r.skipped) { result.skipped += 1; continue }
        result.compressed += 1
        if (path.resolve(r.outPath) !== path.resolve(full)) {
          result.rewrites.push({ from: full, to: r.outPath })
        }
      } catch (e) {
        result.failed += 1
        result.rewrites.push({ from: full, error: String(e && e.message ? e.message : e) })
      }
    }
  }
  await walk(rootDir)
  return result
}
