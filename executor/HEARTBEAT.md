# HEARTBEAT - 执行者的定期检查

## 轮询任务

当被触发轮询时，执行以下任务（仅在自动轮询中）：

### 1. 代码编译检查
- 运行 `npm run typecheck` 检查是否有新的 TypeScript 错误
- 如果有错误，记录数量与错误摘要

### 2. 依赖层检查
- 检查 node_modules 是否存在
- 如果缺失，标记为 "需要重新安装"

### 3. 最新改动验证
- 检查最近 1 小时内是否有新的 commit
- 如果有，对该 commit 运行前两项检查

## 输出格式

如果一切正常：
```
EXECUTOR_HEARTBEAT_OK
```

如果发现问题：
```
EXECUTOR_HEARTBEAT_ISSUES

- TypeScript 编译失败（3 个错误）
- 需要重新 npm install
```

## 重要说明

- 仅在自动轮询模式下执行
- 人类用户消息不触发轮询
- 轮询超时 10 分钟

