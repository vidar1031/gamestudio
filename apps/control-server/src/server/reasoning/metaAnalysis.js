import fs from 'fs'
import path from 'path'

const DEFAULT_SESSIONS_DIR = path.join(process.cwd(), 'state', 'reasoning-sessions')

function safeParseJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function durationMs(session) {
  try {
    return new Date(session.updatedAt).getTime() - new Date(session.createdAt).getTime()
  } catch {
    return 0
  }
}

function truncate(str, maxLen = 300) {
  if (!str) return ''
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60000)}m`
}

/**
 * 聚合 Control 系统 reasoning sessions 的运行数据
 * @param {string} scope - 分析范围: overview | sessions | errors | performance
 * @param {string|null} targetSessionId - 指定分析的 session ID
 * @param {number} maxSessions - 最大采样 session 数
 * @param {string} sessionsDir - sessions 目录路径
 */
export async function aggregateMetaAnalysisData(
  scope = 'overview',
  targetSessionId = null,
  maxSessions = 50,
  sessionsDir = DEFAULT_SESSIONS_DIR
) {
  if (!fs.existsSync(sessionsDir)) {
    return { error: 'reasoning_sessions_dir_not_found', path: sessionsDir }
  }

  const files = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(sessionsDir, f))

  const sessions = []
  for (const file of files) {
    const session = safeParseJSON(file)
    if (!session || !session.sessionId) continue
    sessions.push(session)
  }

  // 按 updatedAt 倒序
  sessions.sort((a, b) => {
    try {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    } catch {
      return 0
    }
  })

  const recentSessions = sessions.slice(0, maxSessions)
  const totalCount = sessions.length
  const successCount = sessions.filter((s) => s.status === 'completed').length
  const failedCount = sessions.filter((s) => s.status === 'failed').length
  const inProgressCount = sessions.filter(
    (s) => s.status === 'running' || s.status === 'in_progress'
  ).length
  const otherCount = totalCount - successCount - failedCount - inProgressCount

  // action 分布（仅统计 recentSessions）
  const actionCounts = {}
  for (const s of recentSessions) {
    const steps =
      s.runtimeTaskGraph?.plan?.steps || s.plan?.steps || []
    for (const step of steps) {
      const action = step.action || 'unknown'
      actionCounts[action] = (actionCounts[action] || 0) + 1
    }
  }
  const actionDistribution = Object.entries(actionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  // 失败 session 详情
  const allFailedSessions = sessions
    .filter((s) => s.status === 'failed')
    .slice(0, 20)
    .map((s) => {
      const steps =
        s.runtimeTaskGraph?.plan?.steps || s.plan?.steps || []
      const failedStep = steps.find(
        (st) => st.status === 'failed' || st.status === 'error'
      )
      return {
        sessionId: s.sessionId,
        userPrompt: truncate(s.userPrompt, 200),
        error: truncate(s.error, 500),
        action: failedStep?.action || steps[steps.length - 1]?.action || 'unknown',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        durationMs: durationMs(s),
      }
    })

  // 性能统计：按 action 分组计算平均耗时
  const actionDurations = {}
  for (const s of recentSessions) {
    const dur = durationMs(s)
    const steps =
      s.runtimeTaskGraph?.plan?.steps || s.plan?.steps || []
    const seenActions = new Set()
    for (const step of steps) {
      const action = step.action || 'unknown'
      if (seenActions.has(action)) continue
      seenActions.add(action)
      if (!actionDurations[action]) actionDurations[action] = []
      actionDurations[action].push(dur)
    }
  }
  const performanceStats = Object.entries(actionDurations)
    .map(([action, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b)
      const sum = sorted.reduce((a, b) => a + b, 0)
      return {
        action,
        count: sorted.length,
        avgMs: Math.round(sum / sorted.length),
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        avgFormatted: formatDuration(Math.round(sum / sorted.length)),
        minFormatted: formatDuration(sorted[0]),
        maxFormatted: formatDuration(sorted[sorted.length - 1]),
      }
    })
    .sort((a, b) => b.avgMs - a.avgMs)

  // 指定 session 详情
  let targetSession = null
  if (targetSessionId) {
    const found = sessions.find((s) => s.sessionId === targetSessionId)
    if (found) {
      const steps =
        found.runtimeTaskGraph?.plan?.steps || found.plan?.steps || []
      targetSession = {
        sessionId: found.sessionId,
        status: found.status,
        userPrompt: truncate(found.userPrompt, 300),
        createdAt: found.createdAt,
        updatedAt: found.updatedAt,
        durationMs: durationMs(found),
        durationFormatted: formatDuration(durationMs(found)),
        stepCount: steps.length,
        error: truncate(found.error, 500),
        actions: [
          ...new Set(steps.map((st) => st.action).filter(Boolean)),
        ],
      }
    }
  }

  // 基础数据
  const data = {
    totalCount,
    successCount,
    failedCount,
    inProgressCount,
    otherCount,
    successRate: totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0,
    failedRate: totalCount > 0 ? Math.round((failedCount / totalCount) * 100) : 0,
    recentSessionCount: recentSessions.length,
    sampledFrom: files.length,
    actionDistribution,
    failedSessions: allFailedSessions.slice(0, 5),
    performanceStats: performanceStats.slice(0, 10),
    targetSession,
  }

  if (scope === 'sessions') {
    data.recentSessions = recentSessions.slice(0, 20).map((s) => ({
      sessionId: s.sessionId,
      status: s.status,
      userPrompt: truncate(s.userPrompt, 200),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      durationMs: durationMs(s),
      durationFormatted: formatDuration(durationMs(s)),
      stepCount: (s.runtimeTaskGraph?.plan?.steps || s.plan?.steps || []).length,
    }))
  }

  if (scope === 'errors') {
    data.failedSessions = allFailedSessions
    const failureByAction = {}
    for (const f of allFailedSessions) {
      const a = f.action || 'unknown'
      failureByAction[a] = (failureByAction[a] || 0) + 1
    }
    data.failureByAction = Object.entries(failureByAction).sort(
      (a, b) => b[1] - a[1]
    )
  }

  if (scope === 'performance') {
    data.performanceStats = performanceStats
  }

  return data
}

/**
 * 构建发给 Kimi 的 meta-analysis prompt
 * @param {object} data - aggregateMetaAnalysisData 返回的数据
 * @param {string} scope - 分析范围
 * @param {string} userPrompt - 用户原始输入
 * @returns {Array<{role:string, content:string}>} messages 数组
 */
export function buildMetaAnalysisPrompt(data, scope, userPrompt = '') {
  const systemMessage =
    `你是一名 Control 系统运行分析专家。你的任务是基于系统运行数据进行深度元分析，识别问题、瓶颈和优化机会。

## 分析原则
1. 基于数据说话，不要猜测
2. 关注失败模式和错误根因
3. 识别性能瓶颈和高耗时操作
4. 给出具体、可执行的优化建议
5. 用中文回复

## 输出格式
请按以下结构输出分析结果：

### 1. 系统健康度评估
- 总体状态（健康/警告/严重）
- 关键指标摘要

### 2. 发现的问题
- 失败模式分析
- 错误根因推断

### 3. 性能瓶颈
- 高耗时操作识别
- 资源使用效率

### 4. 优化建议
- 短期可执行项（1-3天）
- 中期改进项（1-2周）
- 长期架构项（1月+）

### 5. 关键观察
- 数据中的异常或值得注意的趋势`

  const dataSnapshot = JSON.stringify(data, null, 2)
  const maxDataLength = 8000
  const truncatedData =
    dataSnapshot.length > maxDataLength
      ? dataSnapshot.slice(0, maxDataLength) + '\n...（数据已截断）'
      : dataSnapshot

  const scopeLabel =
    scope === 'overview'
      ? '全局概览'
      : scope === 'sessions'
        ? '会话统计'
        : scope === 'errors'
          ? '错误分析'
          : scope === 'performance'
            ? '性能瓶颈'
            : scope

  const userMessage = `请对以下 Control 系统运行数据进行元分析。

## 分析范围
${scopeLabel}

${userPrompt ? `## 用户具体问题\n${userPrompt}\n` : ''}

## 数据快照
\`\`\`json
${truncatedData}
\`\`\`

请基于以上数据进行分析。`

  return [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userMessage },
  ]
}
