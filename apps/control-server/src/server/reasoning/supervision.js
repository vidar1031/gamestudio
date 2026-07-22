import fs from 'node:fs'
import path from 'node:path'

function safeParseJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtime.getTime()
  } catch {
    return 0
  }
}

function fileAgeHours(filePath) {
  const mtime = fileMtimeMs(filePath)
  if (!mtime) return Infinity
  return (Date.now() - mtime) / (1000 * 60 * 60)
}

async function probeHttp(url, timeoutMs = 3000) {
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(t)
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

/**
 * 聚合左脑执行数据，用于监督评估
 * @param {object} options
 * @param {string} options.gamestudioRoot
 * @param {string} options.sessionsDir
 * @param {number} options.maxSessions
 */
export async function aggregateSupervisionData(options = {}) {
  const {
    gamestudioRoot = process.cwd(),
    sessionsDir = path.join(gamestudioRoot, 'state', 'reasoning-sessions'),
    maxSessions = 30,
  } = options

  const now = Date.now()
  const data = {
    timestamp: new Date().toISOString(),
    gamestudioRoot,
    sessionsDir,
  }

  // ── 1. reasoning sessions 统计 ──
  let sessions = []
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).map((f) => path.join(sessionsDir, f))
    for (const file of files) {
      const s = safeParseJSON(file)
      if (s && s.sessionId) sessions.push(s)
    }
    sessions.sort((a, b) => {
      try { return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() } catch { return 0 }
    })
  }

  const recentSessions = sessions.slice(0, maxSessions)
  const totalCount = sessions.length
  const successCount = sessions.filter((s) => s.status === 'completed').length
  const failedCount = sessions.filter((s) => s.status === 'failed').length
  const runningCount = sessions.filter((s) => s.status === 'running' || s.status === 'in_progress').length

  // 最近 24h 的 sessions
  const last24h = sessions.filter((s) => {
    try { return now - new Date(s.updatedAt).getTime() < 24 * 60 * 60 * 1000 } catch { return false }
  })

  // action 分布
  const actionCounts = {}
  for (const s of recentSessions) {
    const steps = s.runtimeTaskGraph?.plan?.steps || s.plan?.steps || []
    for (const step of steps) {
      const a = step.action || 'unknown'
      actionCounts[a] = (actionCounts[a] || 0) + 1
    }
  }

  // 失败原因聚类
  const failureReasons = []
  for (const s of sessions.filter((s) => s.status === 'failed').slice(0, 10)) {
    const error = s.error || s.runtimeTaskGraph?.error || ''
    failureReasons.push({ sessionId: s.sessionId, error: String(error).slice(0, 200) })
  }

  data.sessions = {
    totalCount,
    successCount,
    failedCount,
    runningCount,
    last24hCount: last24h.length,
    last24hSuccess: last24h.filter((s) => s.status === 'completed').length,
    last24hFailed: last24h.filter((s) => s.status === 'failed').length,
    actionDistribution: Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 10),
    failureReasons,
    avgDurationMs: sessions.length > 0
      ? Math.round(sessions.reduce((sum, s) => {
          try { return sum + (new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime()) } catch { return sum }
        }, 0) / sessions.length)
      : 0,
  }

  // ── 2. 服务健康探测 ──
  data.services = {
    omlx: await probeHttp('http://127.0.0.1:18888/health'),
    gamestudioServer: await probeHttp('http://127.0.0.1:1999/api/health'),
    controlServer: await probeHttp('http://127.0.0.1:2099/api/health'),
    comfyui: await probeHttp('http://127.0.0.1:8188/system_stats'),
  }

  // ── 3. 记忆文件状态 ──
  const memoryDir = path.join(gamestudioRoot, 'ai', 'memory')
  const memoryFiles = ['STATUS.md', 'TASK_QUEUE.md', 'DECISIONS.md', 'LONG_TASKS.md']
  data.memory = {}
  for (const name of memoryFiles) {
    const fp = path.join(memoryDir, name)
    data.memory[name] = {
      exists: fs.existsSync(fp),
      ageHours: fileAgeHours(fp),
      size: fs.existsSync(fp) ? fs.statSync(fp).size : 0,
    }
  }

  // ── 4. 配置状态 ──
  const configPath = path.join(gamestudioRoot, 'config', 'hermes', 'manager.left-brain.json')
  data.config = { exists: fs.existsSync(configPath), valid: false }
  if (data.config.exists) {
    const cfg = safeParseJSON(configPath)
    if (cfg) {
      data.config.valid = true
      data.config.defaultRoute = cfg.workflow?.modelRouting?.defaultRoute?.provider || 'unknown'
      data.config.hasMetaAnalysisRoute = Boolean(cfg.workflow?.modelRouting?.actionRoutes?.meta_analysis)
      data.config.rightBrainEnabled = Boolean(cfg.brains?.rightBrainEnabled)
    }
  }

  // ── 5. 日志与事件 ──
  const eventsPath = path.join(gamestudioRoot, 'state', 'agent-runtime-events.jsonl')
  data.events = {
    exists: fs.existsSync(eventsPath),
    ageHours: fileAgeHours(eventsPath),
  }

  // ── 6. 项目存储 ──
  const projectsDir = path.join(gamestudioRoot, 'storage', 'projects')
  data.projects = {
    exists: fs.existsSync(projectsDir),
    count: fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir).filter((d) => {
      const stat = fs.statSync(path.join(projectsDir, d))
      return stat.isDirectory() && !d.startsWith('.')
    }).length : 0,
  }

  // ── 7. 服务日志状态 ──
  const runDir = path.join(gamestudioRoot, '.run')
  data.logs = {
    server: { exists: fs.existsSync(path.join(runDir, 'server.log')), ageHours: fileAgeHours(path.join(runDir, 'server.log')) },
    controlServer: { exists: fs.existsSync(path.join(runDir, 'control-server.log')), ageHours: fileAgeHours(path.join(runDir, 'control-server.log')) },
  }

  return data
}

/**
 * 构建监督评分卡
 * @param {object} data aggregateSupervisionData 的输出
 */
export function buildSupervisionScorecard(data) {
  const categories = []
  let overallScore = 0
  let totalWeight = 0

  // 辅助函数
  const add = (id, name, weight, score, status, details) => {
    categories.push({ id, name, weight, score, status, details })
    overallScore += score * weight
    totalWeight += weight
  }

  // 1. 系统自检 (20%)
  {
    const s = data.services
    let score = 0
    const checks = []
    if (s.omlx.ok) { score += 25; checks.push('OMLX ✓') } else checks.push('OMLX ✗')
    if (s.gamestudioServer.ok) { score += 25; checks.push('Server ✓') } else checks.push('Server ✗')
    if (s.controlServer.ok) { score += 25; checks.push('Control ✓') } else checks.push('Control ✗')
    if (s.comfyui.ok) { score += 25; checks.push('ComfyUI ✓') } else checks.push('ComfyUI ✗')
    const status = score >= 75 ? 'passed' : score >= 50 ? 'warning' : 'critical'
    add('system_self_check', '系统自检', 0.20, score, status, `探测结果: ${checks.join(', ')}`)
  }

  // 2. 故事生产流水线 (30%)
  {
    let score = 100
    let details = '项目存储正常'
    if (!data.projects.exists || data.projects.count === 0) {
      score = 60
      details = '无项目数据，可能未执行过 story workflow'
    }
    if (!data.services.comfyui.ok) {
      score = Math.min(score, 40)
      details += '; ComfyUI 不可达，资产生成受阻'
    }
    const status = score >= 80 ? 'passed' : score >= 50 ? 'needs_improvement' : 'critical'
    add('story_production', '故事生产流水线', 0.30, score, status, details)
  }

  // 3. 推理任务执行 (25%)
  {
    const sess = data.sessions
    let score = 100
    let details = ''
    if (sess.totalCount === 0) {
      score = 50
      details = '无 reasoning session 记录'
    } else {
      const successRate = sess.totalCount > 0 ? (sess.successCount / sess.totalCount) * 100 : 0
      score = Math.round(successRate)
      details = `总计 ${sess.totalCount} 次，成功 ${sess.successCount} 次，成功率 ${score}%`
      if (sess.last24hFailed > 0) {
        details += `; 最近24h失败 ${sess.last24hFailed} 次`
        score = Math.max(0, score - sess.last24hFailed * 5)
      }
      if (sess.avgDurationMs > 10 * 60 * 1000) {
        details += `; 平均耗时 ${Math.round(sess.avgDurationMs / 60000)}m，偏长`
        score = Math.max(0, score - 10)
      }
    }
    const status = score >= 80 ? 'passed' : score >= 60 ? 'needs_improvement' : 'critical'
    add('reasoning_execution', '推理任务执行', 0.25, Math.min(100, Math.max(0, score)), status, details)
  }

  // 4. 记忆管理 (10%)
  {
    const mem = data.memory
    let score = 100
    const issues = []
    for (const [name, info] of Object.entries(mem)) {
      if (!info.exists) { score -= 20; issues.push(`${name} 不存在`) }
      else if (info.ageHours > 24) { score -= 10; issues.push(`${name} ${Math.round(info.ageHours)}h 未更新`) }
    }
    const status = score >= 80 ? 'passed' : score >= 50 ? 'warning' : 'critical'
    add('memory_management', '记忆管理', 0.10, Math.max(0, score), status, issues.length ? issues.join(', ') : '记忆文件状态良好')
  }

  // 5. 配置与路由 (10%)
  {
    let score = 100
    const issues = []
    if (!data.config.exists) { score = 0; issues.push('配置文件不存在') }
    else if (!data.config.valid) { score = 20; issues.push('配置文件格式错误') }
    else {
      if (data.config.defaultRoute !== 'omlx') { score -= 20; issues.push(`默认路由为 ${data.config.defaultRoute}，期望 omlx`) }
      if (!data.config.hasMetaAnalysisRoute) { score -= 20; issues.push('未配置 meta_analysis 路由') }
    }
    const status = score >= 80 ? 'passed' : score >= 50 ? 'warning' : 'critical'
    add('config_routing', '配置与路由', 0.10, Math.max(0, score), status, issues.length ? issues.join(', ') : '配置正确')
  }

  // 6. 可观测性 (5%)
  {
    let score = 100
    const issues = []
    if (!data.events.exists) { score -= 30; issues.push('agent-runtime-events.jsonl 不存在') }
    else if (data.events.ageHours > 1) { score -= 20; issues.push(`events ${Math.round(data.events.ageHours)}h 未更新`) }
    if (data.logs.controlServer.exists && data.logs.controlServer.ageHours > 2) {
      score -= 20; issues.push('control-server.log 2h+ 未更新')
    }
    const status = score >= 80 ? 'passed' : score >= 50 ? 'warning' : 'critical'
    add('observability', '日志与可观测性', 0.05, Math.max(0, score), status, issues.length ? issues.join(', ') : '日志正常')
  }

  overallScore = totalWeight > 0 ? Math.round(overallScore / totalWeight) : 0

  let overallStatus = 'excellent'
  if (overallScore < 90) overallStatus = 'passed'
  if (overallScore < 75) overallStatus = 'needs_improvement'
  if (overallScore < 60) overallStatus = 'critical'

  // 单项强制降级
  const criticalCategories = categories.filter((c) => c.status === 'critical')
  if (criticalCategories.length > 0 && overallStatus !== 'critical') {
    overallStatus = 'needs_improvement'
  }

  return {
    assessmentId: `supervision-${data.timestamp}`,
    assessedAt: data.timestamp,
    overallScore,
    overallStatus,
    categories,
    rawData: data,
  }
}

/**
 * 从右脑分析结果中解析修正计划
 * @param {string} analysisContent 右脑返回的文本内容
 */
export function parseCorrectionPlan(analysisContent) {
  // 尝试从分析文本中提取结构化修正指令
  // 如果右脑返回了 JSON 代码块，优先解析 JSON
  const jsonMatch = analysisContent.match(/```json\s*([\s\S]*?)\s*```/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      if (parsed.correctionId && Array.isArray(parsed.actions)) {
        return parsed
      }
    } catch {
      // ignore
    }
  }

  // 退化为简单文本记录
  return {
    correctionId: `corr-${Date.now()}`,
    source: 'text_extraction',
    actions: [
      {
        step: 1,
        type: 'review',
        description: '右脑生成的修正建议（文本格式）',
        content: analysisContent.slice(0, 4000),
        reviewRequired: true,
      },
    ],
    estimatedFixTime: 'unknown',
    rollbackPlan: '请查看原始分析文本',
  }
}
