// GameStudio 事件执行历史只读查询。
// 数据源：state/events/events.jsonl（eventDispatcher 每次分发追加一条 trace 记录）。
// 支持按 eventId / code（如 GS-02）过滤，返回最近 limit 条（新的在前）。
// 文件位置可用 HERMES_EVENT_RUNS_FILE 覆盖（测试用）。

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'

export function getEventRunsFile() {
  const override = process.env.HERMES_EVENT_RUNS_FILE
  if (override && String(override).trim()) return String(override)
  return path.join(GAMESTUDIO_ROOT, 'state', 'events', 'events.jsonl')
}

export function readGameStudioEventRuns({ eventRef = '', limit = 10 } = {}) {
  const max = Math.max(1, Math.min(50, Number(limit) || 10))
  const ref = String(eventRef || '').trim().toLowerCase()
  const runs = []
  try {
    const file = getEventRunsFile()
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (let index = lines.length - 1; index >= 0 && runs.length < max; index -= 1) {
        const line = lines[index].trim()
        if (!line) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          // 损坏行跳过，不猜测内容
          continue
        }
        if (ref) {
          const eventId = String(record?.eventId || '').toLowerCase()
          const code = String(record?.code || '').toLowerCase()
          if (eventId !== ref && code !== ref) continue
        }
        runs.push(record)
      }
    }
  } catch {
    // 读取失败按空列表处理，由页面呈现空态
  }
  return runs
}
