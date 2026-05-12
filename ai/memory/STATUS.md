# GameStudio 当前状态

## 当前目标
- 通过 Control 侧驱动 Hermes + OMLX + GameStudio Server，形成可审核、可观测、可验收的互动故事生产闭环。
- 当前优先口径是文本互动故事闭环：项目创建、配置、脚本候选生成、脚本写入、蓝图编译、合成层编译、结构校验、H5 导出。
- 图片/角色资产闭环在图片 provider 稳定后再作为独立门禁推进。

## 当前结果
- 仓库已具备 `apps/server`、`apps/editor`、`apps/control-server`、`apps/control-console` 和 `storage/projects`。
- GameStudio Server 已提供项目创建、读取、保存、脚本、蓝图、合成、校验、导出和部分资产 API。
- Control Server 已新增 story workflow actions、GameStudio Server API client、P0 executor artifacts、deterministic evaluator、失败短路、资源引用校验和当前项目指针。
- Story workflow request classification 已优先路由到 deterministic `story_workflow_execute`，L4 短题不再调用 OMLX 分类。
- L4-08 已成功补齐“转换/最小 story/scripts”路径：可生成最小 6 卡 scripts、写入、编译 blueprint、compose、校验并导出。
- L1 仍要求最终 answer 阶段经过 Hermes/OMLX；该硬门禁不使用 deterministic answer 旁路。
- GameStudio 自检已完成，并已将结果反馈至 Control，所有接口可访问，Control Console UI (`http://localhost:8870/`) 通过 smoke 测试。
- OMLX 模型已在本地配置，ComfyUI 已启动并可正常调用。

## 当前阻塞
- Hermes gateway 仍出现 Telegram reconnect / OMLX connection fault 日志；deterministic L4 已被隔离，但 L1 和真实模型生成仍依赖 OMLX 稳定。
- 图片/角色资产生成仍依赖图片 provider；provider 未就绪时必须返回明确 `image_provider_preflight` 或对应失败阶段。
- L5 的人工驳回、质量失败、异常恢复、越权拒绝仍需专项样本验证。

## 下一步
- 保持 OMLX/Hermes runtime 可恢复，并继续观察 gateway fault 对 L1 的影响。
- 跑完整 L1 批次，确认所有硬门禁样本都有 Hermes/OMLX answer evidence。
- 跑 L5 边界样本，确认失败不会编造成成功。
- 图片 provider 稳定后推进资产门禁。
