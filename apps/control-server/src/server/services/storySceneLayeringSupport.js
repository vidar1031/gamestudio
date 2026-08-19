// AUTO-E04：背景+立绘分层合成的 control 侧支撑逻辑。
// E03 批量场景队列（apps/server/src/ai/sceneBatchQueue.js）是异步的：提交即返回 batchId，
// per-scene checkpoint 落盘，control step 必须轮询直至批次终结并做确定性汇总。
// 本模块独立出来以便注入假 fetchBatch/sleep 做确定性单测；可观测事件由调用方
// （controlServerCore 的 observeGameStudioOperation）包裹。

// 与服务端 runSceneBatch 状态机对齐：批次非终态 = queued/running
export const SCENE_BATCH_OPEN_STATUS = new Set(['queued', 'running'])

export function isSceneBatchFinished(batch) {
  return Boolean(batch) && !SCENE_BATCH_OPEN_STATUS.has(String(batch?.status || ''))
}

// per-scene 结果汇总：completed/skipped 视为落定，waiting_review 待人工，failed/blocked 为失败
export function summarizeSceneBatch(batch) {
  const items = Array.isArray(batch?.items) ? batch.items : []
  const failedItems = items.filter((it) => ['failed', 'blocked'].includes(String(it?.status || '')))
  const waitingItems = items.filter((it) => String(it?.status || '') === 'waiting_review')
  const doneItems = items.filter((it) => ['completed', 'skipped'].includes(String(it?.status || '')))
  return {
    batchId: String(batch?.batchId || ''),
    status: String(batch?.status || ''),
    total: items.length,
    doneCount: doneItems.length,
    waitingCount: waitingItems.length,
    failedCount: failedItems.length,
    failedScenes: failedItems.map((it) => ({
      sceneId: String(it?.sceneId || ''),
      status: String(it?.status || ''),
      error: String(it?.error || ''),
      errorCategory: String(it?.errorCategory || '')
    })),
    waitingScenes: waitingItems.map((it) => String(it?.sceneId || '')),
    // 任一失败 item 被 E03 归类为临时故障时，整批失败视为可重试
    retryable: failedItems.some((it) => String(it?.errorCategory || '') === 'retryable')
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询批量队列直至终结。
 * fetchBatch() 返回 gameStudioServerClient.getStorySceneBatch 的形状：{ ok, data: { batch }, error, message, retryable }
 * 返回 { finished, batch, summary, polls, error, message, retryable }：
 * - finished=true：批次到达终态（含 partial/failed，成败由 summary 判定）
 * - finished=false：拉取失败或等待超时，error 显式区分 scene_batch_poll_failed / scene_batch_wait_timeout
 */
export async function waitForSceneBatchTerminal({ fetchBatch, timeoutMs, intervalMs = 10000, sleep = defaultSleep, onProgress }) {
  const budgetMs = Math.max(1000, Number(timeoutMs || 0) || 3600000)
  const interval = Math.max(500, Number(intervalMs || 10000))
  const deadlineAt = Date.now() + budgetMs
  let polls = 0
  let lastBatch = null
  while (Date.now() < deadlineAt) {
    await sleep(interval)
    const result = await fetchBatch()
    polls += 1
    if (!result?.ok) {
      return {
        finished: false,
        batch: lastBatch,
        summary: summarizeSceneBatch(lastBatch),
        polls,
        error: String(result?.error || 'scene_batch_poll_failed'),
        message: String(result?.message || result?.error || '批量渲染进度拉取失败'),
        retryable: result?.retryable !== false
      }
    }
    lastBatch = result?.data?.batch || lastBatch
    const summary = summarizeSceneBatch(lastBatch)
    if (onProgress) onProgress({ polls, batch: lastBatch, summary })
    if (isSceneBatchFinished(lastBatch)) {
      return { finished: true, batch: lastBatch, summary, polls, error: '', message: '', retryable: false }
    }
  }
  return {
    finished: false,
    batch: lastBatch,
    summary: summarizeSceneBatch(lastBatch),
    polls,
    error: 'scene_batch_wait_timeout',
    message: `等待批量渲染终结超时（${budgetMs}ms）`,
    retryable: true
  }
}

/**
 * 背景-only 批量渲染步骤的确定性结果评估（执行器 ok/fail 语义集中在此，便于单测）。
 * 输入 submitResult（POST batch）与 waitOutcome（waitForSceneBatchTerminal），
 * 输出 { passed, failedStage, retryable, summaryText }。
 */
export function evaluateSceneBackgroundsOutcome({ submitResult, waitOutcome }) {
  const batchId = String(submitResult?.data?.batchId || waitOutcome?.summary?.batchId || '')
  const summary = waitOutcome?.summary || null
  const passed = Boolean(
    submitResult?.ok &&
    waitOutcome?.finished &&
    summary &&
    summary.total > 0 &&
    summary.failedCount === 0 &&
    summary.waitingCount === 0
  )
  let failedStage = null
  if (!passed) {
    if (!submitResult?.ok) failedStage = 'scene_backgrounds_batch_api'
    else if (!waitOutcome?.finished) failedStage = waitOutcome?.error === 'scene_batch_wait_timeout' ? 'scene_backgrounds_batch_timeout' : 'scene_backgrounds_batch_poll'
    else if (summary?.failedCount) failedStage = 'scene_backgrounds_render'
    else failedStage = 'scene_backgrounds_review'
  }
  const failedSceneText = (summary?.failedScenes || []).map((x) => `${x.sceneId}(${x.status}${x.error ? `:${x.error}` : ''})`).join('、')
  const summaryText = passed
    ? `场景背景批量渲染完成（background-only）：${summary.doneCount}/${summary.total}，批次 ${batchId}`
    : `场景背景批量渲染未完成：${submitResult?.ok
      ? (waitOutcome?.message || failedSceneText || (summary?.waitingCount ? `待人工审核：${summary.waitingScenes.join('、')}` : '') || 'scene_backgrounds_batch_failed')
      : (submitResult?.message || submitResult?.error || 'scene_backgrounds_batch_api_failed')}`
  return {
    passed,
    failedStage,
    summaryText,
    retryable: Boolean(submitResult?.ok ? (waitOutcome?.retryable || summary?.retryable) : submitResult?.retryable)
  }
}

/**
 * 立绘 placements 步骤的确定性结果评估。
 * 通过条件：API 成功 + 无场景级错误 +（有 placements 写入/刷新，或没有任何被跳过的未锁定角色）。
 * 全部角色未锁定（written=0 且 skippedCharacters 非空）显式失败，提示先完成锁定。
 */
export function evaluateScenePlacementsOutcome(serverResult) {
  const summaryData = serverResult?.data?.summary || null
  const scenes = Array.isArray(serverResult?.data?.scenes) ? serverResult.data.scenes : []
  const sceneErrors = scenes.filter((item) => item && item.ok === false)
  const skippedCharacters = Array.isArray(serverResult?.data?.skippedCharacters) ? serverResult.data.skippedCharacters : []
  const skippedProps = Array.isArray(serverResult?.data?.skippedProps) ? serverResult.data.skippedProps : []
  const created = Number(summaryData?.placementsCreated || 0)
  const updated = Number(summaryData?.placementsUpdated || 0)
  const written = created + updated
  const passed = Boolean(serverResult?.ok && summaryData && sceneErrors.length === 0 && (written > 0 || skippedCharacters.length === 0))
  const failedStage = passed ? null : (serverResult?.ok ? 'scene_placements_evaluator' : 'scene_placements_api')
  const summaryText = passed
    ? `立绘分层站位已写回：placements 新建 ${created} / 刷新 ${updated}，角色立绘同步 ${Number(summaryData?.charactersCreated || 0) + Number(summaryData?.charactersUpdated || 0)} 个` +
      `${skippedCharacters.length ? `，${skippedCharacters.length} 个未锁定角色跳过` : ''}${skippedProps.length ? `，${skippedProps.length} 个 prop 暂不合成` : ''}`
    : `立绘分层站位生成未完成：${serverResult?.message || serverResult?.error ||
      (skippedCharacters.length ? `存在未锁定角色：${skippedCharacters.map((x) => x.name || x.assetId).join('、')}` : '') ||
      (sceneErrors.length ? `场景节点缺失：${sceneErrors.map((x) => x.sceneId).join('、')}` : '') ||
      'scene_placements_failed'}`
  return {
    passed,
    failedStage,
    summaryText,
    retryable: Boolean(serverResult?.retryable),
    stats: { summary: summaryData, scenes, sceneErrors, skippedCharacters, skippedProps, written }
  }
}
