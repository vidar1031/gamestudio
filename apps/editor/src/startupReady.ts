// 2026-08-26 启动覆盖层真实就绪信号：
// 各工作室在"初始数据加载完成（成功或失败）"后调用 markStartupReady()，
// StartupOverlay 监听该事件收尾——展示时长由真实加载耗时决定，不再写死秒数。
// 重复调用安全（覆盖层只响应首次事件）。
export const STARTUP_READY_EVENT = 'gamestudio:startup-ready'

export function markStartupReady() {
  try {
    window.dispatchEvent(new Event(STARTUP_READY_EVENT))
  } catch {
    // 非浏览器环境（如测试）直接忽略
  }
}
