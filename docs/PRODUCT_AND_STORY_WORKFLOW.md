# GameStudio 产品与故事工作流

本文只说明 GameStudio 的产品定位、项目结构和新的故事生产任务流。历史设计稿、阶段复盘和测试流水已删除或并入 [系统生产级推进方案.md](系统生产级推进方案.md)。

## 产品定位

GameStudio 是 H5 互动故事生产工具。目标用户输入 brief 后，系统能产出可继续编辑、可校验、可导出的互动故事项目。

核心边界：

- 模型生成候选内容。
- Control 编排任务、审核动作、记录 artifacts、执行 evaluator。
- GameStudio Server 负责项目读写、编译、校验、资产和导出。
- `storage/projects` 是项目产物真相源。

## 项目结构

```text
storage/projects/<projectId>/
   meta.json       # 项目元信息和生成配置
   scripts.json    # 脚本层
   blueprint.json  # 蓝图层
   project.json    # 合成层项目数据
   story.json      # 运行时故事数据
   assets/         # 图片、角色、背景等真实资源
   builds/         # 导出产物
```

## 三层故事工作流

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 脚本层 | `scripts.json` | 表达故事文本、顺序、选择点和结局意图。 |
| 蓝图层 | `blueprint.json` | 把脚本卡片映射为可执行结构，锁定分支拓扑。 |
| 合成层 | `project.json` / `story.json` | 承载运行态结构、真实资源、视觉表现和导出配置。 |

脚本层可以由 AI 生成候选，但必须通过 schema/evaluator。蓝图层负责结构稳定，合成层负责真实资源和可运行表现。

## 新生产任务流

### 文本故事任务流

```text
brief
   -> create project
   -> configure project
   -> generate scripts candidate
   -> write scripts
   -> compile blueprint
   -> compile compose
   -> validate project
   -> export H5
```

当前简要状态：已具备主要链路，仍需持续回归模型候选质量和失败边界。

未实现：不依赖 fallback 的高质量稳定脚本生成还需要继续验证。

### 图文资产任务流

```text
文本故事项目
   -> image provider preflight
   -> Story Bible / asset plan
   -> generate image assets
   -> persist assets
   -> apply references
   -> validate resources
   -> reexport H5
```

当前简要状态：已具备 preflight 和资产计划门禁。

未实现：完整图片落盘、角色/背景引用回填、资源校验和重新导出闭环。

### 批量生产任务流

```text
task queue
   -> per-project workflow
   -> checkpoint
   -> retry / cancel / resume
   -> final artifact report
```

当前简要状态：尚未进入生产级实现。

未实现：批量队列、暂停、取消、续跑、失败分类和长期运行验收。