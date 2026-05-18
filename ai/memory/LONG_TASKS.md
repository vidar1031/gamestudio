# LONG_TASKS - 长任务方向

## 主线：GameStudio 端到端互动故事生产闭环

### 阶段 1：P0 文本故事闭环 ✅ 已达标
- 目标：不依赖图片资产，稳定完成可编辑、可校验、可导出的文本互动故事。
- 状态：**已完成**。`productionTest` + `requireModelAnswer=true` 可完整执行 13 步无阻塞。
- 关键成果：
  - OMLX `response_format` workaround 稳定工作
  - Story Bible 可生成真实内容（characters=4, locations=2）
  - `generateScriptsCandidate` maxTokens 提升到 8192
  - `productionTest` review bypass 完整实现
  - Story Bible 持久化到 `project.json`

### 阶段 2：P1 图片资产闭环 🔄 进行中
- 目标：在 P0 基础上生成真实图片资产，落盘并回填引用，重新校验和导出。
- 状态：**未达标**。`image_provider_not_ready` 阻塞资产生成。
- 关键阻塞：ComfyUI 未集成/未运行。
- 下一步：安装 ComfyUI 或实现 mock provider，打通 asset plan → 资产生成 → 引用回填 → 重新导出。

### 阶段 3：S3 生产运维闭环 📋 待启动
- 目标：长任务、模型异常、服务器重启、测试进程和人工审核都有可取消、可恢复、可追溯的边界。
- 状态：**部分达标**。已具备模型任务队列、heartbeat、session artifacts、review records。
- 缺失：完整任务状态机、checkpoint 恢复、orphan session 收敛、批量生产队列。

## 维护规则

- 只保留稳定多 session 追踪项，移除已完成的里程碑。
- 每个阶段必须标明：目标、当前状态、关键阻塞、下一步。
