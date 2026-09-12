export type ChromaKeyOptions = {
  key?: { r: number; g: number; b: number }
  threshold?: number
  feather?: number
  crop?: boolean
  padding?: number
}

function clampInt(n: unknown, min: number, max: number, fallback: number) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function clampFloat(n: unknown, min: number, max: number, fallback: number) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

async function decodeToImageBitmap(blob: Blob): Promise<ImageBitmap | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      return await createImageBitmap(blob)
    }
  } catch {}
  return null
}

async function decodeToHtmlImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const p = new Promise<HTMLImageElement>((resolve, reject) => {
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('image_decode_failed'))
    })
    img.src = url
    return await p
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

// 2026-09-01 角点采样底色：模型很少给出纯绿 (0,255,0)，实测偏青/蓝绿。
// 从四边中点与四角取 8 个 5x5 色块做分量中位数，作为实际底色；opts.key 显式传入时仍优先。
function sampleBorderKeyColor(data: Uint8ClampedArray, w: number, h: number): { r: number; g: number; b: number } {
  const pts: Array<[number, number]> = [
    [2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3],
    [Math.floor(w / 2), 2], [Math.floor(w / 2), h - 3],
    [2, Math.floor(h / 2)], [w - 3, Math.floor(h / 2)]
  ]
  const samples: number[][] = []
  for (const [cx, cy] of pts) {
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.min(w - 1, Math.max(0, cx + dx))
        const y = Math.min(h - 1, Math.max(0, cy + dy))
        const i = (y * w + x) * 4
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
        n++
      }
    }
    if (n > 0) samples.push([r / n, g / n, b / n])
  }
  if (!samples.length) return { r: 0, g: 255, b: 0 }
  const medianAt = (idx: number) => {
    const sorted = samples.map((s) => s[idx]).sort((a, b2) => a - b2)
    return sorted[Math.floor(sorted.length / 2)]
  }
  return { r: medianAt(0), g: medianAt(1), b: medianAt(2) }
}

export async function chromaKeyUrlToPng(
  imageUrl: string,
  opts?: ChromaKeyOptions
): Promise<{ blob: Blob; width: number; height: number }> {
  const url = String(imageUrl || '').trim()
  if (!url) throw new Error('missing_image_url')

  const threshold = clampFloat(opts?.threshold, 0, 255, 80)
  const feather = clampFloat(opts?.feather, 0, 255, 40)
  const crop = Boolean(opts?.crop ?? true)
  const padding = clampInt(opts?.padding, 0, 128, 12)

  const resp = await fetch(url, { method: 'GET' })
  if (!resp.ok) throw new Error(`download_failed:${resp.status}`)
  const srcBlob = await resp.blob()

  let w = 0
  let h = 0
  let draw: (ctx: CanvasRenderingContext2D) => void

  const bitmap = await decodeToImageBitmap(srcBlob)
  if (bitmap) {
    w = bitmap.width
    h = bitmap.height
    draw = (ctx) => {
      ctx.drawImage(bitmap, 0, 0)
      try {
        bitmap.close?.()
      } catch {}
    }
  } else {
    const img = await decodeToHtmlImage(srcBlob)
    w = img.naturalWidth || img.width
    h = img.naturalHeight || img.height
    draw = (ctx) => ctx.drawImage(img, 0, 0)
  }

  w = Math.max(1, Math.floor(w))
  h = Math.max(1, Math.floor(h))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas_context_missing')
  ctx.clearRect(0, 0, w, h)
  draw(ctx)

  const imgData = ctx.getImageData(0, 0, w, h)
  const data = imgData.data
  const key = opts?.key || sampleBorderKeyColor(data, w, h)
  const thr = threshold
  const fea = Math.max(0, feather)

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a0 = data[i + 3]
    if (a0 === 0) continue

    const dr = r - key.r
    const dg = g - key.g
    const db = b - key.b
    const dist = Math.sqrt(dr * dr + dg * dg + db * db)

    let a = 255
    if (dist <= thr) a = 0
    else if (fea > 0 && dist < thr + fea) a = Math.round((255 * (dist - thr)) / fea)
    if (a < a0) data[i + 3] = a
  }

  ctx.putImageData(imgData, 0, 0)

  let outCanvas = canvas
  if (crop) {
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = data[(y * w + x) * 4 + 3]
        if (a > 0) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }

    if (maxX >= 0 && maxY >= 0) {
      minX = Math.max(0, minX - padding)
      minY = Math.max(0, minY - padding)
      maxX = Math.min(w - 1, maxX + padding)
      maxY = Math.min(h - 1, maxY + padding)
      const cw = Math.max(1, maxX - minX + 1)
      const ch = Math.max(1, maxY - minY + 1)
      const c2 = document.createElement('canvas')
      c2.width = cw
      c2.height = ch
      const ctx2 = c2.getContext('2d')
      if (!ctx2) throw new Error('canvas_context_missing')
      ctx2.clearRect(0, 0, cw, ch)
      ctx2.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch)
      outCanvas = c2
      w = cw
      h = ch
    }
  }

  const outBlob = await new Promise<Blob>((resolve, reject) => {
    try {
      outCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob_failed'))), 'image/png')
    } catch (e) {
      reject(e)
    }
  })

  return { blob: outBlob, width: w, height: h }
}

