// Hermes 历史会话只读检索：直接查 state.db 的 FTS5 索引，与 hermes 内建 session_search 同一数据源。
//
// 设计决定（为什么不代理到网关 8742）：
// - 只读 SQLite（readOnly 打开）零 LLM 成本、零 token 消耗，检索语义与 hermes 一致（FTS5/trigram/LIKE 三分支）；
// - 代理到网关会让一次只读检索变成一次完整 agent 推理（约 33K tokens/次），且把 control 的查询暴露给提示注入面；
// - hermes 的 session_search 本身自 PR #27590 起就不再使用辅助 LLM，直接查库无损真。
//
// 安全边界：readOnly 连接 + 参数化查询 + 用户输入分词加引号（不支持 FTS5 操作符，防语法注入）；
// 只返回摘要片段（snippet）与限量条目，不回传整段会话内容。

import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { HERMES_HOME } from '../../config/paths.js'

const MAX_LIMIT = 20
const DEFAULT_LIMIT = 8

function containsCjk(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)
}

function countCjk(text) {
  const matches = String(text).match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)
  return matches ? matches.length : 0
}

// 与 hermes_state.py 相同的分词加引号策略：空白分词后逐token双引号包裹，保留大小写操作符禁用
function quoteTokens(rawQuery) {
  return String(rawQuery)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ')
}

function toIso(timestamp) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return null
  return new Date(value * 1000).toISOString()
}

function mapRow(row) {
  return {
    messageId: row.id,
    sessionId: row.session_id,
    role: row.role,
    source: row.source || null,
    toolName: row.tool_name || null,
    timestamp: toIso(row.timestamp),
    sessionStartedAt: toIso(row.session_started),
    snippet: String(row.snippet || ''),
    // 供卡片展开：截断到 500 字符，避免整段回传
    contentPreview: String(row.content || '').slice(0, 500)
  }
}

export function searchHermesSessions({ query, limit } = {}) {
  const q = String(query || '').trim()
  if (!q) {
    return { ok: false, error: 'missing_query', detail: '缺少检索关键词 q。' }
  }
  const effectiveLimit = Math.min(Math.max(Number.parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)

  const dbPath = path.join(HERMES_HOME, 'state.db')
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: 'state_db_missing', detail: `未找到 Hermes 会话库：${dbPath}` }
  }

  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return { ok: false, error: 'state_db_open_failed', detail: error instanceof Error ? error.message : String(error) }
  }

  try {
    const isCjk = containsCjk(q)
    const tokens = q.split(/\s+/).filter(Boolean)
    const anyShortCjkToken = tokens.some((token) => containsCjk(token) && countCjk(token) < 3)

    let rows
    let mode
    if (isCjk && anyShortCjkToken) {
      // 短 CJK（1-2 字）trigram 无法匹配（需 ≥3 CJK 字符），退化为 LIKE 子串
      mode = 'like'
      const likeNeedle = `%${q.replace(/[%_]/g, (ch) => `\\${ch}`)}%`
      rows = db.prepare(`
        SELECT m.id, m.session_id, m.role, m.content, m.timestamp, m.tool_name, s.source, s.started_at AS session_started,
               substr(m.content, 1, 160) AS snippet
        FROM messages m
        LEFT JOIN sessions s ON s.id = m.session_id
        WHERE m.active = 1 AND m.content LIKE ? ESCAPE '\\'
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(likeNeedle, effectiveLimit)
    } else {
      // CJK 长查询走 trigram 表，非 CJK 走 unicode61 表；均与 hermes session_search 同表
      mode = isCjk ? 'trigram' : 'fts5'
      const ftsTable = isCjk ? 'messages_fts_trigram' : 'messages_fts'
      const matchQuery = quoteTokens(q)
      try {
        rows = db.prepare(`
          SELECT m.id, m.session_id, m.role, m.content, m.timestamp, m.tool_name, s.source, s.started_at AS session_started,
                 snippet(${ftsTable}, 0, '>>>', '<<<', '...', 32) AS snippet
          FROM ${ftsTable}
          JOIN messages m ON m.id = ${ftsTable}.rowid
          LEFT JOIN sessions s ON s.id = m.session_id
          WHERE ${ftsTable} MATCH ? AND m.active = 1
          ORDER BY m.timestamp DESC
          LIMIT ?
        `).all(matchQuery, effectiveLimit)
      } catch (error) {
        return { ok: false, error: 'fts_query_failed', detail: error instanceof Error ? error.message : String(error) }
      }
    }

    return {
      ok: true,
      query: q,
      mode,
      scannedDb: dbPath,
      hitCount: rows.length,
      hits: rows.map(mapRow)
    }
  } finally {
    try { db.close() } catch { /* 只读连接关闭失败忽略 */ }
  }
}
