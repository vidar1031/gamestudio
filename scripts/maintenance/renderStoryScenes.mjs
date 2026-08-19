#!/usr/bin/env node
/**
 * 串行渲染故事全部场景图（Step2）。
 * 用法: node scripts/maintenance/renderStoryScenes.mjs <projectId> [--timeout=600000] [--width=768] [--height=1024]
 * 逐场景调用 POST /api/projects/:id/ai/story/scenes/:sceneId/render，
 * 单场景失败不中断，最后输出渲染统计。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SERVER = process.env.SERVER_BASE_URL || 'http://127.0.0.1:1999'
const projectId = process.argv[2]
const timeoutMs = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 600000
const width = Number((process.argv.find((a) => a.startsWith('--width=')) || '').split('=')[1]) || 768
const height = Number((process.argv.find((a) => a.startsWith('--height=')) || '').split('=')[1]) || 1024

if (!projectId) {
  console.error('用法: node scripts/maintenance/renderStoryScenes.mjs <projectId>')
  process.exit(1)
}

const storyPath = path.join('storage', 'projects', projectId, 'story.json')
const story = JSON.parse(fs.readFileSync(storyPath, 'utf8'))
const sceneIds = (story.nodes || []).map((n) => n.id).filter(Boolean)

console.log(`渲染 ${sceneIds.length} 个场景，project=${projectId}，timeout=${timeoutMs}ms，size=${width}x${height}`)

let ok = 0
let fail = 0
const results = []

for (const sceneId of sceneIds) {
  const startedAt = Date.now()
  try {
    const res = await fetch(`${SERVER}/api/projects/${projectId}/ai/story/scenes/${encodeURIComponent(sceneId)}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width, height, timeoutMs })
    })
    const j = await res.json().catch(() => null)
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    if (res.ok && j?.success) {
      ok += 1
      results.push({ sceneId, ok: true, assetPath: j.assetPath, elapsed })
      console.log(`✓ ${sceneId} (${elapsed}s) -> ${j.assetPath}`)
    } else {
      fail += 1
      results.push({ sceneId, ok: false, error: j?.error || `http_${res.status}`, elapsed })
      console.log(`✗ ${sceneId} (${elapsed}s) error=${j?.error || res.status}`)
    }
  } catch (e) {
    fail += 1
    results.push({ sceneId, ok: false, error: e.message })
    console.log(`✗ ${sceneId} exception=${e.message}`)
  }
}

console.log(`\n完成: ok=${ok} fail=${fail} total=${sceneIds.length}`)
process.exit(fail > 0 && ok === 0 ? 1 : 0)
