# HERMES-G03：聊天提交前确认可用性

## 任务目标

修复守护台聊天页在人工全审模式打开提交前确认后未渲染弹窗、导致发送无反应的问题。

## 范围内

- Chat 页面、提交 gate 渲染与 approve/reject/cancel 交互。
- 人工全审与自动直跑两种模式的最小回归验证。

## 范围外

- 不改变 review gate 的授权边界。
- 不移除自动直跑模式。

## 必须满足

1. 人工全审模式下发送会显示可操作的提交前确认界面。
2. 确认、返回/取消与拒绝均有明确 UI 和后端结果。
3. 自动直跑模式不受回归影响。
4. Console typecheck 及关键交互 smoke 通过。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by:
