// 项目级 AI 事件总线（SSE 推送方案的发布端）：进程内发布订阅，按 key（projectId 或项目目录路径）分桶。
// 只发轻量信号 { type, at }，不携带数据——数据真相源仍是 GET /ai/tasks|reviews|coverage，
// 推送只负责告诉客户端"该重拉哪个接口"。publish 同步调用，异常不阻塞主链；
// 任务侧以 projectId 为 key（taskProgress.js），审核侧以项目目录路径为 key（imageReviewStore.js 只感知路径），
// SSE 路由订阅时与各自写入侧使用同一 key 即可。
const subscribers = new Map() // key -> Set<listener>

function keyOf(v) {
  return String(v || '').trim()
}

export function subscribeProjectEvents(key, listener) {
  const k = keyOf(key)
  if (!k || typeof listener !== 'function') return () => {}
  if (!subscribers.has(k)) subscribers.set(k, new Set())
  subscribers.get(k).add(listener)
  return () => {
    const set = subscribers.get(k)
    if (!set) return
    set.delete(listener)
    if (!set.size) subscribers.delete(k)
  }
}

export function publishProjectEvent(key, signal) {
  const k = keyOf(key)
  if (!k) return
  const set = subscribers.get(k)
  if (!set || !set.size) return
  const evt = signal && typeof signal === 'object' ? signal : {}
  for (const listener of set) {
    try {
      listener(evt)
    } catch (_) { /* 单个订阅者异常不影响其他订阅者与主链 */ }
  }
}
