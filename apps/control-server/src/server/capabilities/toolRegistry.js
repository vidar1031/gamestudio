export const REASONING_TOOLS = {
  'context.recent': {
    tool: 'context.recent',
    title: '读取最近上下文',
    category: 'context',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '重放最近 Hermes 对话并注入当前 memory、skill、context pool。',
    routes: ['internal:reasoning/context.recent']
  },
  'project.locate': {
    tool: 'project.locate',
    title: '定位项目目录',
    category: 'workspace',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '解析当前 GameStudio 工作区与关键根目录。',
    routes: ['internal:reasoning/project.locate']
  },
  'workspace.listDirectory': {
    tool: 'workspace.listDirectory',
    title: '列出目录内容',
    category: 'workspace',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '列出工作区内指定目录的直接子项，作为可观测证据返回。',
    routes: ['internal:reasoning/workspace.listDirectory']
  },
  'workspace.readFile': {
    tool: 'workspace.readFile',
    title: '读取文件内容',
    category: 'workspace',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '读取工作区文件内容并注入 artifacts，可用于定位入口和生成后续修改。',
    routes: ['internal:reasoning/workspace.readFile']
  },
  'workspace.searchText': {
    tool: 'workspace.searchText',
    title: '搜索工作区文本',
    category: 'workspace',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '在工作区内按文本搜索匹配结果，用于快速定位符号、提示词或配置项。',
    routes: ['internal:reasoning/workspace.searchText']
  },
  'workspace.editFile': {
    tool: 'workspace.editFile',
    title: '编辑工作区文件',
    category: 'workspace',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '基于当前文件内容和修改意图生成候选改写，必须人工审核后才会落盘。',
    routes: ['internal:reasoning/workspace.editFile']
  },
  'workspace.createFile': {
    tool: 'workspace.createFile',
    title: '创建工作区文件',
    category: 'workspace',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '基于目标内容创建新文件或覆盖不存在的文件，必须人工审核后才会落盘。',
    routes: ['internal:reasoning/workspace.createFile']
  },
  'workspace.renamePath': {
    tool: 'workspace.renamePath',
    title: '重命名工作区路径',
    category: 'workspace',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '重命名或移动工作区内文件/目录，必须人工审核后才会执行。',
    routes: ['internal:reasoning/workspace.renamePath']
  },
  'workspace.deletePath': {
    tool: 'workspace.deletePath',
    title: '删除工作区路径',
    category: 'workspace',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '删除工作区内文件或目录，必须人工审核后才会执行。',
    routes: ['internal:reasoning/workspace.deletePath']
  },
  'project.inspectServerImageEntrypoints': {
    tool: 'project.inspectServerImageEntrypoints',
    title: '检查图片服务端入口',
    category: 'observable',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '定位 apps/server/src 中图片生成相关后端入口。',
    routes: ['internal:reasoning/project.inspectServerImageEntrypoints']
  },
  'project.inspectControlBackendSurfaces': {
    tool: 'project.inspectControlBackendSurfaces',
    title: '检查 control 后端入口',
    category: 'observable',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '定位 apps/control-server/src 中 chat、reasoning、runtime 入口。',
    routes: ['internal:reasoning/project.inspectControlBackendSurfaces']
  },
  'memory.write': {
    tool: 'memory.write',
    title: '写入记忆文件',
    category: 'write',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '写入 ai/ 下记忆文件，必须人工审核后应用。',
    routes: ['internal:reasoning/memory.write']
  },
  'memory.taskQueue': {
    tool: 'memory.taskQueue',
    title: '更新任务队列',
    category: 'write',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '更新 ai/memory/TASK_QUEUE.md，必须人工审核后应用。',
    routes: ['internal:reasoning/memory.taskQueue']
  },
  'runtime.script': {
    tool: 'runtime.script',
    title: '执行生命周期脚本',
    category: 'invoke',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '执行白名单 lifecycle 脚本，确认后才允许触发。',
    routes: ['internal:reasoning/runtime.script']
  },
  'runtime.workspaceScript': {
    tool: 'runtime.workspaceScript',
    title: '执行工作区脚本',
    category: 'invoke',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '执行工作区内允许范围的脚本路径，确认后才允许触发。',
    routes: ['internal:reasoning/runtime.workspaceScript']
  },
  'gamestudio.bootstrap.ensureRunning': {
    tool: 'gamestudio.bootstrap.ensureRunning',
    title: '启动或确认 GameStudio',
    category: 'gamestudio-bootstrap',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '确认 GameStudio Server/Editor 可用；服务未启动时调用白名单启动脚本 start_project.sh --detached。若 image provider 为 comfyui，还会自动检测并启动 ComfyUI。',
    routes: ['internal:gamestudio/bootstrap.ensureRunning']
  },
  'gamestudio.bootstrap.openEditor': {
    tool: 'gamestudio.bootstrap.openEditor',
    title: '打开 GameStudio Editor',
    category: 'gamestudio-bootstrap',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '返回 GameStudio Editor URL，并在本机 macOS 上尝试打开浏览器。',
    routes: ['internal:gamestudio/bootstrap.openEditor']
  },
  'gamestudio.bootstrap.readSettings': {
    tool: 'gamestudio.bootstrap.readSettings',
    title: '读取 Studio Settings',
    category: 'gamestudio-bootstrap',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '读取 GameStudio 当前 settings 与 effective 配置。',
    routes: ['internal:gamestudio/studio.settings.get']
  },
  'gamestudio.bootstrap.configureLocalProduction': {
    tool: 'gamestudio.bootstrap.configureLocalProduction',
    title: '写入本地生产配置',
    category: 'gamestudio-bootstrap',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '写入本地 OMLX 文本模型与 ComfyUI 图片 provider 的非密钥生产默认配置。',
    routes: ['internal:gamestudio/studio.settings.put']
  },
  'gamestudio.bootstrap.selfCheck': {
    tool: 'gamestudio.bootstrap.selfCheck',
    title: '执行 GameStudio 自检',
    category: 'gamestudio-bootstrap',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '调用 GameStudio health、settings、diagnose 和 image preflight，并把结果回写 Control artifacts。',
    routes: ['internal:gamestudio/studio.diagnose']
  },
  'gamestudio.bootstrap.answer': {
    tool: 'gamestudio.bootstrap.answer',
    title: '汇总 GameStudio 打开结果',
    category: 'gamestudio-bootstrap',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '基于已观测的 GameStudio bootstrap artifacts 生成确定性汇总。',
    routes: ['internal:gamestudio/bootstrap.answer']
  },
  'gamestudio.story.createProject': {
    tool: 'gamestudio.story.createProject',
    title: '创建互动故事项目',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '通过 GameStudio Server 创建标准互动故事项目骨架，并返回 storage/projects 证据。',
    routes: ['internal:gamestudio/projects.create']
  },
  'gamestudio.story.createAiProject': {
    tool: 'gamestudio.story.createAiProject',
    title: 'AI 创建故事草稿',
    category: 'story-workflow',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '由 Control 调用 GameStudio Server 的 AI 创建故事接口，生成 scripts 与 blueprint 证据。',
    routes: ['internal:gamestudio/projects.aiCreate']
  },
  'gamestudio.story.configureProject': {
    tool: 'gamestudio.story.configureProject',
    title: '写入故事生成配置',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '把题材、风格、受众、输出语言和结构公式写入项目配置并读回验证。',
    routes: ['internal:gamestudio/projects.update']
  },
  'gamestudio.story.inspectProject': {
    tool: 'gamestudio.story.inspectProject',
    title: '检查故事项目证据',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '读取项目目录、配置、故事、脚本、蓝图、资源和导出产物摘要。',
    routes: ['internal:gamestudio/projects.inspect']
  },
  'gamestudio.story.generateScriptsCandidate': {
    tool: 'gamestudio.story.generateScriptsCandidate',
    title: '生成故事脚本候选',
    category: 'story-workflow',
    executionMode: 'model-assisted',
    reviewPolicy: 'auto',
    description: '通过 Hermes/OMLX 生成受 schema 约束的 scripts.json 候选。',
    routes: ['internal:hermes/story.scripts.candidate']
  },
  'gamestudio.story.writeScripts': {
    tool: 'gamestudio.story.writeScripts',
    title: '写入故事脚本',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '把已验证脚本候选写入 GameStudio 项目 scripts.json，并读回验证。',
    routes: ['internal:gamestudio/projects.scripts.put']
  },
  'gamestudio.story.compileBlueprint': {
    tool: 'gamestudio.story.compileBlueprint',
    title: '编译故事蓝图',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '调用 GameStudio Server 将脚本层编译为蓝图层，并返回校验报告。',
    routes: ['internal:gamestudio/projects.compileBlueprint']
  },
  'gamestudio.story.analyzeScripts': {
    tool: 'gamestudio.story.analyzeScripts',
    title: '分析故事脚本',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '调用 GameStudio Server 分析 scripts，并返回蓝图分支建议和结构检查。',
    routes: ['internal:gamestudio/projects.analyzeScripts']
  },
  'gamestudio.story.reviewBlueprintAgent': {
    tool: 'gamestudio.story.reviewBlueprintAgent',
    title: '智能体评审蓝图',
    category: 'story-workflow',
    executionMode: 'model-assisted',
    reviewPolicy: 'auto',
    description: 'Control 结合 GameStudio 规则、确定性门禁和 Hermes/OMLX 评分评审交互故事蓝图。',
    routes: ['internal:hermes/story.blueprint.review']
  },
  'gamestudio.story.repairBlueprintIfNeeded': {
    tool: 'gamestudio.story.repairBlueprintIfNeeded',
    title: '必要时修复蓝图',
    category: 'story-workflow',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '当蓝图智能体评审要求修复时，调用 GameStudio AI 修复脚本并重新编译蓝图。',
    routes: ['internal:gamestudio/projects.fixScripts']
  },
  'gamestudio.story.compileCompose': {
    tool: 'gamestudio.story.compileCompose',
    title: '编译可运行故事',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '调用 GameStudio Server 将蓝图层编译为 project/story 合成层。',
    routes: ['internal:gamestudio/projects.compileCompose']
  },
  'gamestudio.story.generateAssetCandidate': {
    tool: 'gamestudio.story.generateAssetCandidate',
    title: '生成故事资产候选',
    category: 'story-workflow',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '检查图片 provider 并尝试生成背景或角色资产候选；失败时返回明确阶段。',
    routes: ['internal:gamestudio/projects.assets.generate']
  },
  'gamestudio.story.preflightImageProvider': {
    tool: 'gamestudio.story.preflightImageProvider',
    title: '检查图片 Provider 前置条件',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '调用 GameStudio Server 的 image preflight，确认 ComfyUI/provider、节点和模型条件。',
    routes: ['internal:gamestudio/studio.image.preflight']
  },
  'gamestudio.story.createBible': {
    tool: 'gamestudio.story.createBible',
    title: '生成 Story Bible',
    category: 'story-workflow',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '调用 GameStudio Server 显式生成 Story Bible，并将结果写回项目 state.aiBackground。',
    routes: ['internal:gamestudio/projects.story.bible', 'internal:gamestudio/projects.update']
  },
  'gamestudio.story.createAssetPlan': {
    tool: 'gamestudio.story.createAssetPlan',
    title: '创建故事资产计划',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '基于项目和 Story Bible 创建并保存故事资产计划，缺少 Story Bible 时明确阻断。',
    routes: ['internal:gamestudio/projects.assets.plan']
  },
  'gamestudio.story.generateLockAssetReferences': {
    tool: 'gamestudio.story.generateLockAssetReferences',
    title: '绘制锁定事物参考图',
    category: 'story-workflow',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '基于故事资产计划逐个生成并选择必须锁定事物的主参考图。',
    routes: ['internal:gamestudio/projects.assets.reference', 'internal:gamestudio/projects.assets.reference.select']
  },
  'gamestudio.story.lockTest': {
    tool: 'gamestudio.story.lockTest',
    title: '执行事物锁定出图测试',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '通过 ComfyUI SDXL 对故事资产计划中的目标事物执行锁定出图测试，验证 checkpoint/LoRA/IP-Adapter 组合可用性。',
    routes: ['internal:gamestudio/projects.story.lock.test']
  },
  'gamestudio.story.renderScene': {
    tool: 'gamestudio.story.renderScene',
    title: '渲染故事场景图',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '调用 GameStudio Server 对指定 scene 执行场景图渲染，使用已锁定的 reference assets 保证角色/道具/地点一致性。',
    routes: ['internal:gamestudio/projects.story.scenes.render']
  },
  'gamestudio.story.renderSceneBackgrounds': {
    tool: 'gamestudio.story.renderSceneBackgrounds',
    title: '批量渲染场景背景（分层合成）',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '调用 GameStudio Server E03 批量队列以 background-only 模式渲染全部场景背景（人物/事物不进背景图），轮询批次直至终结并汇总 per-scene 成败。',
    routes: ['internal:gamestudio/projects.story.scenes.batch']
  },
  'gamestudio.story.generateScenePlacements': {
    tool: 'gamestudio.story.generateScenePlacements',
    title: '生成场景立绘分层站位',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '调用 GameStudio Server 按资产计划为各场景写回立绘 placements 并同步 characters[].imageAssetId，供运行时（PixiJS）分层合成。',
    routes: ['internal:gamestudio/projects.story.scenes.placements']
  },
  'gamestudio.story.generateLineart': {
    tool: 'gamestudio.story.generateLineart',
    title: '生成资产线稿',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '对已锁定主参考的资产逐个生成 ControlNet 线稿（hint+final），写回资产计划的 lineart 字段。',
    routes: ['internal:gamestudio/projects.story.assets.lineart']
  },
  'gamestudio.story.validateProject': {
    tool: 'gamestudio.story.validateProject',
    title: '校验互动故事项目',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '校验蓝图、合成层和最小项目文件集合，输出 deterministic evaluator verdict。',
    routes: ['internal:gamestudio/projects.validate']
  },
  'gamestudio.story.exportProject': {
    tool: 'gamestudio.story.exportProject',
    title: '导出互动故事项目',
    category: 'story-workflow',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '调用 GameStudio Server 导出 H5，并返回 distUrl 与本地产物证据。',
    routes: ['internal:gamestudio/projects.export']
  },
  'planner.default': {
    tool: 'planner.default',
    title: '整理问题',
    category: 'planner',
    executionMode: 'model-assisted',
    reviewPolicy: 'auto',
    description: '结合上下文规划后续动作。',
    routes: ['internal:reasoning/planner.default']
  },
  'web.search': {
    tool: 'web.search',
    title: '搜索网页',
    category: 'web',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '使用 Tavily 或 Brave Search 搜索网页，返回标题、URL 和摘要。',
    routes: ['internal:web/search']
  },
  'web.extract': {
    tool: 'web.extract',
    title: '提取网页内容',
    category: 'web',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '提取指定网页或 PDF 的文本内容，返回 Markdown 或纯文本。',
    routes: ['internal:web/extract']
  },
  'shell.execute': {
    tool: 'shell.execute',
    title: '执行 Shell 命令',
    category: 'invoke',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '在工作区内执行 shell 命令（如 npm test、git status、tsc 等），必须人工审核后执行。',
    routes: ['internal:shell/execute']
  },
  'vision.analyze': {
    tool: 'vision.analyze',
    title: '分析图片',
    category: 'vision',
    executionMode: 'model-assisted',
    reviewPolicy: 'auto',
    description: '使用视觉模型分析图片内容（本地路径或 URL），回答关于图片的具体问题。',
    routes: ['internal:vision/analyze']
  },
  'git.status': {
    tool: 'git.status',
    title: 'Git 状态',
    category: 'git',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '执行 git status 查看当前工作区的修改状态。',
    routes: ['internal:git/status']
  },
  'git.diff': {
    tool: 'git.diff',
    title: 'Git 差异',
    category: 'git',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '执行 git diff 查看修改差异，可指定文件或范围。',
    routes: ['internal:git/diff']
  },
  'git.log': {
    tool: 'git.log',
    title: 'Git 日志',
    category: 'git',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '执行 git log 查看提交历史，可指定行数。',
    routes: ['internal:git/log']
  },
  'git.branch': {
    tool: 'git.branch',
    title: 'Git 分支',
    category: 'git',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '执行 git branch 查看当前分支列表。',
    routes: ['internal:git/branch']
  },
  'test.run': {
    tool: 'test.run',
    title: '运行测试',
    category: 'test',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '运行项目测试命令（如 npm test、pytest 等），解析并返回测试结果。',
    routes: ['internal:test/run']
  },
  'mcp.call': {
    tool: 'mcp.call',
    title: '调用 MCP 工具',
    category: 'mcp',
    executionMode: 'deterministic',
    reviewPolicy: 'required',
    description: '调用已配置的 MCP（Model Context Protocol）外部工具。需要先在 config/hermes/mcp.json 中配置服务器。',
    routes: ['internal:mcp/call']
  },
  'model.metaAnalysis': {
    tool: 'model.metaAnalysis',
    title: '系统元分析',
    category: 'planner',
    executionMode: 'model-assisted',
    reviewPolicy: 'auto',
    description: '调用右脑 Kimi 模型对 Control 系统运行状态进行元分析，聚合日志、session 统计、失败模式等数据，并给出优化建议。',
    routes: ['internal:reasoning/model.metaAnalysis']
  },
  'model.supervisionEvaluate': {
    tool: 'model.supervisionEvaluate',
    title: '监督评估',
    category: 'planner',
    executionMode: 'model-assisted',
    reviewPolicy: 'auto',
    description: '调用右脑 Kimi 模型对左脑任务执行质量进行监督评估，生成评分卡和可执行的修正指令。',
    routes: ['internal:reasoning/model.supervisionEvaluate']
  },
  'model.answer': {
    tool: 'model.answer',
    title: '生成最终回答',
    category: 'answer',
    executionMode: 'model-assisted',
    reviewPolicy: 'auto',
    description: '基于当前 artifacts 生成最终回答或结构化总结，并在结果准备好后直接返回。',
    routes: ['internal:reasoning/model.answer']
  }
}

export function buildReasoningToolCatalog() {
  return Object.values(REASONING_TOOLS)
}