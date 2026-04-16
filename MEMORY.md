# MEMORY - GameStudio项目记忆

## 使命
稳定生产 H5 交互小故事，保证主链路可持续推进。

## 标准运行基线
- 启动: bash scripts/lifecycle/start_project.sh --detached
- 状态: bash scripts/lifecycle/status_project.sh
- 停止: bash scripts/lifecycle/stop_project.sh
- Server: http://127.0.0.1:1999
- Editor: http://localhost:8868

## 当前主链路
故事创建 -> 脚本转蓝图 -> 连续性约束 -> 场景图生成 -> 合成与导出 -> 测试与验收

## 当前配置基线
- 运行环境: 宿主机模式
- 工具边界: 禁用 web/browser 工具
- 模型策略: 单模型、低并发
- 启动协同: team_checkin + BOOT 触发

## 记忆维护规则
- 仅保留当前进行中的目标、阻塞和下一步
- 历史完成项不保留在主记忆文件
- 每日只维护一份最新进展日志

## 当前焦点
- 团队签到机制已验证可用
- 四个 agent 的 main 会话已可见
- 正在推进正式场景出图验证与 assetRefs 稳定性
