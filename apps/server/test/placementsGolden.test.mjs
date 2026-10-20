// 摆位黄金基线（W2 前置安全网）：真实服务端起跑 + 夹具项目 + placements 端点全链输出快照。
// 首次运行写基线文件（test/golden/placements_sc1.json），此后逐字节对照——摆位行为任何漂移即红。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SERVER_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PORT = 19191
const FIXTURE_ID = 'fixture-placement'
const GOLDEN = path.join(SERVER_DIR, 'test', 'golden', 'placements_sc1.json')

// 1x1 透明 PNG
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

let serverProc = null
let tmpRoot = ''

async function waitHealth(deadlineMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < deadlineMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('server_not_ready')
}

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gs-fixture-'))
  const projDir = path.join(tmpRoot, 'projects', FIXTURE_ID)
  await fsp.mkdir(path.join(projDir, 'story-assets'), { recursive: true })
  // 真相源图片（锁定主参考用）
  await fsp.mkdir(path.join(projDir, 'assets/ai/refs'), { recursive: true })
  await fsp.writeFile(path.join(projDir, 'assets/ai/refs/hero.png'), PNG_1PX)
  await fsp.writeFile(path.join(projDir, 'assets/ai/refs/plate.png'), PNG_1PX)

  await fsp.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    schemaVersion: '2.0', id: FIXTURE_ID, name: '摆位夹具', characters: [], assets: [
      { id: 'asset_hero', kind: 'image', name: '主角主参考', uri: 'assets/ai/refs/hero.png' },
      { id: 'asset_plate', kind: 'image', name: '盘子主参考', uri: 'assets/ai/refs/plate.png' }
    ], _rev: 1
  }, null, 2))
  await fsp.writeFile(path.join(projDir, 'story.json'), JSON.stringify({
    schemaVersion: '1.0', startNodeId: 'sc1',
    nodes: [{ id: 'sc1', name: '场景一', kind: 'normal', body: '开场', timeline: [], visuals: {}, choices: [] }]
  }, null, 2))
  await fsp.writeFile(path.join(projDir, 'story-assets/plan.json'), JSON.stringify({
    schemaVersion: '1.0', generatedAt: '2026-01-01T00:00:00.000Z',
    assets: [
      {
        id: 'hero', name: '主角', category: 'character', sceneIds: ['sc1'],
        referenceStatus: 'ready', primaryReferenceAssetId: 'asset_hero', primaryReferenceAssetUri: 'assets/ai/refs/hero.png',
        stateRequirements: [], poseVariants: []
      },
      {
        id: 'plate', name: '盘子', category: 'prop', sceneIds: ['sc1'],
        referenceStatus: 'ready', primaryReferenceAssetUri: 'assets/ai/refs/plate.png',
        stateRequirements: [], stateVariants: []
      }
    ],
    scenes: [{ sceneId: 'sc1', sceneIndex: 0 }]
  }, null, 2))

  serverProc = spawn('node', ['src/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, STUDIO_STORAGE_ROOT: tmpRoot, PORT: String(PORT) },
    stdio: 'ignore'
  })
  await waitHealth()
})

after(() => {
  if (serverProc) serverProc.kill('SIGTERM')
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('摆位黄金基线：夹具项目 placements 输出与基线逐字节一致', async () => {
  const resp = await fetch(`http://127.0.0.1:${PORT}/api/projects/${FIXTURE_ID}/ai/story/scenes/placements`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })
  const json = await resp.json()
  assert.equal(json.success, true, JSON.stringify(json).slice(0, 300))
  const story = JSON.parse(await fsp.readFile(path.join(tmpRoot, 'projects', FIXTURE_ID, 'story.json'), 'utf8'))
  const placements = story.nodes[0].visuals.placements
  assert.ok(Array.isArray(placements) && placements.length >= 2, '应至少摆入主角与盘子')

  // 归一化：去掉易变的生成 id（characterId 是运行时新建的角色 id），只留行为语义字段
  const normalized = placements.map((p) => ({
    isCharacter: Boolean(p.characterId), propAssetId: p.propAssetId || '',
    transform: p.transform, zIndex: p.zIndex, visible: p.visible !== false
  })).sort((a, b) => (a.propAssetId || 'character').localeCompare(b.propAssetId || 'character'))

  if (!fs.existsSync(GOLDEN)) {
    await fsp.mkdir(path.dirname(GOLDEN), { recursive: true })
    await fsp.writeFile(GOLDEN, JSON.stringify(normalized, null, 2))
    console.log('[golden] 基线已写入', GOLDEN)
  }
  const golden = JSON.parse(await fsp.readFile(GOLDEN, 'utf8'))
  assert.deepEqual(normalized, golden, '摆位输出与黄金基线不一致——行为漂移！')
})
