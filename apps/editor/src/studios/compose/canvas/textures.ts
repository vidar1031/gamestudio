import { Texture } from 'pixi.js'

export const textureCache = new Map<string, Promise<Texture> | Texture>()

// 场景编排器：像素级命中的 alpha 查找图（按 Texture 实例缓存，会话内复用；null 表示构建失败→回退矩形命中）
export type AlphaMap = { data: Uint8ClampedArray; width: number; height: number }
export const alphaMapCache = new WeakMap<Texture, AlphaMap | null>()

export function getAlphaMap(tex: Texture): AlphaMap | null {
  if (alphaMapCache.has(tex)) return alphaMapCache.get(tex) || null
  let result: AlphaMap | null = null
  try {
    const src: any = (tex as any).source?.resource || (tex as any).source?.resource?.source
    const w = Math.floor(Number(src?.naturalWidth || src?.width || 0))
    const h = Math.floor(Number(src?.naturalHeight || src?.height || 0))
    if (src && w > 0 && h > 0) {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        ctx.drawImage(src, 0, 0, w, h)
        const img = ctx.getImageData(0, 0, w, h)
        const data = new Uint8ClampedArray(w * h)
        for (let i = 0; i < w * h; i += 1) data[i] = img.data[i * 4 + 3]
        result = { data, width: w, height: h }
      }
    }
  } catch {
    result = null
  }
  alphaMapCache.set(tex, result)
  return result
}

export async function loadTexture(url: string): Promise<Texture | null> {
  const key = String(url || '').trim()
  if (!key) return null

  const cached = textureCache.get(key)
  if (cached) {
    try {
      return cached instanceof Promise ? await cached : cached
    } catch {
      textureCache.delete(key)
    }
  }

  const p = new Promise<Texture>((resolve, reject) => {
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        try {
          resolve(Texture.from(img))
        } catch (e) {
          reject(e)
        }
      }
      img.onerror = () => reject(new Error(`图片加载失败: ${key}`))
      img.src = key
    } catch (e) {
      reject(e)
    }
  })

  textureCache.set(key, p)

  try {
    const tex = await p
    textureCache.set(key, tex)
    return tex
  } catch (e) {
    textureCache.delete(key)
    try {
      console.warn('[talkscene] loadTexture failed:', key, e instanceof Error ? e.message : String(e))
    } catch {}
    return null
  }
}
