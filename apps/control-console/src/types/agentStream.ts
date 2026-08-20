// agent 流式咨询（聊天页「边想边做边展示」）的展示类型。
// 事件由 control-server agent-stream 桥聚合后 SSE 推来（含 stepIndex），console 只负责按步分组渲染。
export type AgentStreamAction = {
  actionId: string
  tool: string
  actionLabel: string
  target: string
  status: 'running' | 'done' | 'failed' | 'blocked'
  error?: string
}

export type AgentStreamStep = {
  stepIndex: number
  thinking: string[]
  actions: AgentStreamAction[]
}
