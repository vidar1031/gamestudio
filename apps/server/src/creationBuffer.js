// 创作过程缓冲（2026-08-31 用户指令）：每个故事项目独立的磁盘缓冲文件，不依赖浏览器缓存。
// 组成：
//   creation-buffer/journal.jsonl          —— 追加式创作事件日志（锁定/线稿/出图/绑定/导出等关键时刻）
//   creation-buffer/snapshots/<ts>_<原因>/ —— 写前快照（project.json / story.json / story-assets/plan.json）
// 快照保留最近 20 份，超出自动清理最旧。任何恢复需求都可从快照找回提示词/计划/摆放等创作过程数据。
import { copyFile, mkdir, readdir, stat, writeFile, rm } from 'fs/promises'
import path from 'path'

const BUFFER_DIR_NAME = 'creation-buffer'
const TRUTH_FILES = ['project.json', 'story.json', path.join('story-assets', 'plan.json')]
const MAX_SNAPSHOTS = 20
const lastSnapshotAt = new Map() // dir -> ms

function nowIso() {
  return new Date().toISOString()
}

function safeSlug(v) {
  return String(v || 'event').replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 48) || 'event'
}

// 追加式创作事件日志（只增不改）
export async function recordCreationEvent(dir, { type, summary = '', actor = 'system', data = null } = {}) {
  try {
    const bufDir = path.join(dir, BUFFER_DIR_NAME)
    await mkdir(bufDir, { recursive: true })
    const line = JSON.stringify({
      ts: nowIso(),
      type: String(type || 'event'),
      summary: String(summary || '').slice(0, 300),
      actor: String(actor || 'system'),
      data: data && typeof data === 'object' ? data : null
    })
    await writeFile(path.join(bufDir, 'journal.jsonl'), line + '\n', { flag: 'a' })
  } catch (_) { /* 缓冲写入失败不阻断业务 */ }
}

// 写前快照：复制真相文件到 creation-buffer/snapshots/<ts>_<reason>/
// minIntervalMs 内的重复调用跳过（高频写路径防抖）
export async function snapshotCreationState(dir, { reason = 'write', minIntervalMs = 5000 } = {}) {
  try {
    const key = String(dir)
    const now = Date.now()
    const last = lastSnapshotAt.get(key) || 0
    if (now - last < minIntervalMs) return null
    const files = []
    for (const rel of TRUTH_FILES) {
      const abs = path.join(dir, rel)
      try {
        const st = await stat(abs)
        if (st.isFile() && st.size > 0) files.push(rel)
      } catch (_) { /* 文件不存在则跳过 */ }
    }
    if (!files.length) return null
    lastSnapshotAt.set(key, now)
    const stamp = `${nowIso().replace(/[:.]/g, '-')}_${safeSlug(reason)}`
    const snapDir = path.join(dir, BUFFER_DIR_NAME, 'snapshots', stamp)
    for (const rel of files) {
      const to = path.join(snapDir, rel)
      await mkdir(path.dirname(to), { recursive: true })
      await copyFile(path.join(dir, rel), to)
    }
    await rotateSnapshots(dir)
    return { snapshotDir: snapDir, files }
  } catch (_) {
    return null
  }
}

async function rotateSnapshots(dir) {
  try {
    const root = path.join(dir, BUFFER_DIR_NAME, 'snapshots')
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    const excess = dirs.length - MAX_SNAPSHOTS
    if (excess <= 0) return
    for (const name of dirs.slice(0, excess)) {
      await rm(path.join(root, name), { recursive: true, force: true }).catch(() => {})
    }
  } catch (_) { /* 轮转失败不影响业务 */ }
}
