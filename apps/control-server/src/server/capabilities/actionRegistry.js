import { REASONING_TOOLS } from './toolRegistry.js'

export const REASONING_ACTIONS = {
  read_recent_context: {
    title: '读取最近上下文',
    tool: REASONING_TOOLS['context.recent'].tool,
    category: 'context',
    description: '重放最近对话并加载当前已选 memory / skill / context pool。',
    paramsSpec: []
  },
  locate_project: {
    title: '定位项目目录',
    tool: REASONING_TOOLS['project.locate'].tool,
    category: 'workspace',
    description: '确定当前 GameStudio 工作区和关键目录根路径。',
    paramsSpec: []
  },
  list_directory_contents: {
    title: '列出目录内容',
    tool: REASONING_TOOLS['workspace.listDirectory'].tool,
    category: 'observable',
    description: '列出工作区内指定目录的直接子项，返回文件和子目录清单。',
    paramsSpec: [
      'dirPath: 工作区内相对路径或绝对路径，必须位于 GameStudio 工作区内。'
    ]
  },
  inspect_server_image_entrypoints: {
    title: '盘点图片生成服务端入口',
    tool: REASONING_TOOLS['project.inspectServerImageEntrypoints'].tool,
    category: 'observable',
    description: '检查 apps/server/src 中图片生成相关的入口和调用链。',
    paramsSpec: []
  },
  inspect_control_backend_surfaces: {
    title: '定位 control/Hermes 后端文件',
    tool: REASONING_TOOLS['project.inspectControlBackendSurfaces'].tool,
    category: 'observable',
    description: '检查 apps/control-server/src 中 Hermes 对话、reasoning 和控制路由入口。',
    paramsSpec: []
  },
  prepare_prompt: {
    title: '整理问题',
    tool: REASONING_TOOLS['planner.default'].tool,
    category: 'planner',
    description: '整理问题与证据，准备进入最终回答阶段。',
    paramsSpec: []
  },
  meta_analysis: {
    title: '系统元分析',
    tool: REASONING_TOOLS['model.metaAnalysis'].tool,
    category: 'planner',
    description: '调用右脑 Kimi 模型对 Control 系统运行状态进行深度元分析，识别瓶颈、错误模式并提供优化建议。',
    paramsSpec: [
      'scope?: 分析范围，可选值：overview(全局概览) / sessions(会话统计) / errors(错误分析) / performance(性能瓶颈)，默认 overview。',
      'sessionId?: 指定会话 ID，若提供则重点分析该会话。'
    ]
  },
  supervision_evaluate: {
    title: '监督评估',
    tool: REASONING_TOOLS['model.supervisionEvaluate'].tool,
    category: 'planner',
    description: '由右脑对左脑任务执行质量进行全面监督评估，生成评分卡和修正建议，并判断哪些修正可自动执行、哪些需人工确认。',
    paramsSpec: [
      'trigger?: 触发来源，可选 post_startup(启动后) / periodic(周期性) / manual(人工触发)，默认 manual。'
    ]
  },
  generate_default_answer: {
    title: '生成最终回答',
    tool: REASONING_TOOLS['model.answer'].tool,
    category: 'answer',
    description: '基于当前可观测 artifacts 生成最终回答。',
    paramsSpec: []
  },
  read_file_content: {
    title: '读取文件内容',
    tool: REASONING_TOOLS['workspace.readFile'].tool,
    category: 'observable',
    description: '读取工作区内指定文件的内容，作为可观测证据注入 artifacts。',
    paramsSpec: [
      'filePath: 工作区内相对路径或绝对路径，必须位于 GameStudio 工作区内。'
    ]
  },
  search_workspace_text: {
    title: '搜索工作区文本',
    tool: REASONING_TOOLS['workspace.searchText'].tool,
    category: 'observable',
    description: '在工作区中按文本查找匹配结果，适合定位函数、字段、注释或配置项。',
    paramsSpec: [
      'query: 要搜索的文本。',
      'startDir?: 工作区内起始目录，默认从仓库根目录搜索。',
      'maxResults?: 最多返回多少条匹配，默认 20。'
    ]
  },
  edit_workspace_file: {
    title: '编辑工作区文件',
    tool: REASONING_TOOLS['workspace.editFile'].tool,
    category: 'write',
    description: '对工作区代码或文档文件生成候选改写，适合加注释、局部修改、创建新文件，必须人工审核。',
    paramsSpec: [
      'filePath: 工作区内目标文件路径，可新建但不得越出工作区。',
      'content: 目标内容或修改意图，可直接给出完整内容，也可描述修改要求。'
    ]
  },
  create_workspace_file: {
    title: '创建工作区文件',
    tool: REASONING_TOOLS['workspace.createFile'].tool,
    category: 'write',
    description: '为工作区创建新文件内容，复用候选改写与人工审核流程。',
    paramsSpec: [
      'filePath: 工作区内新文件路径，不得越出工作区。',
      'content: 新文件内容或创建意图。'
    ]
  },
  rename_workspace_path: {
    title: '重命名工作区路径',
    tool: REASONING_TOOLS['workspace.renamePath'].tool,
    category: 'write',
    description: '重命名或移动工作区内文件/目录，必须人工审核。',
    paramsSpec: [
      'fromPath: 工作区内原路径。',
      'toPath: 工作区内目标路径。'
    ]
  },
  delete_workspace_path: {
    title: '删除工作区路径',
    tool: REASONING_TOOLS['workspace.deletePath'].tool,
    category: 'write',
    description: '删除工作区内文件/目录，必须人工审核。',
    paramsSpec: [
      'targetPath: 工作区内目标路径。'
    ]
  },
  write_memory_file: {
    title: '写入记忆文件',
    tool: REASONING_TOOLS['memory.write'].tool,
    category: 'write',
    description: '将 LLM 生成的内容写入指定的 ai/memory/*.md 文件，用于更新项目状态、任务队列、决策记录等。',
    paramsSpec: [
      'filePath: 相对工作区路径，必须位于 ai/ 目录下。',
      'content: 目标内容或修改意图。'
    ]
  },
  update_task_queue: {
    title: '更新任务队列',
    tool: REASONING_TOOLS['memory.taskQueue'].tool,
    category: 'write',
    description: '将新任务条目追加或替换到 ai/memory/TASK_QUEUE.md，推进多轮任务链。',
    paramsSpec: [
      'content: 要追加或替换的任务文本。',
      'replaceAll?: 是否整体替换 TASK_QUEUE.md。'
    ]
  },
  run_lifecycle_script: {
    title: '执行生命周期脚本',
    tool: REASONING_TOOLS['runtime.script'].tool,
    category: 'invoke',
    description: '执行 scripts/lifecycle/ 下已预设的生命周期脚本（如 restart_control.sh），只允许白名单内的脚本。',
    paramsSpec: [
      'scriptName: restart_control.sh | restart_server.sh | reporter.sh'
    ]
  },
  run_workspace_script: {
    title: '执行工作区脚本',
    tool: REASONING_TOOLS['runtime.workspaceScript'].tool,
    category: 'invoke',
    description: '执行工作区允许范围内的脚本文件，确认后才会真正运行。',
    paramsSpec: [
      'scriptPath: 工作区内脚本相对路径，允许 scripts/ 下脚本和仓库根目录常用 .sh/.js/.mjs/.cjs 文件。'
    ]
  },
  gamestudio_ensure_running: {
    title: '启动或确认 GameStudio',
    tool: REASONING_TOOLS['gamestudio.bootstrap.ensureRunning'].tool,
    category: 'gamestudio-bootstrap',
    description: '确认 GameStudio Server/Editor 可用；服务未启动时调用白名单启动脚本。',
    paramsSpec: ['startIfNeeded?: 是否在未运行时启动。', 'serverUrl?: Server URL。', 'editorUrl?: Editor URL。', 'comfyuiCheck?: 是否检测并自动启动 ComfyUI（默认 true）。']
  },
  gamestudio_open_editor: {
    title: '打开 GameStudio Editor',
    tool: REASONING_TOOLS['gamestudio.bootstrap.openEditor'].tool,
    category: 'gamestudio-bootstrap',
    description: '返回 Editor URL，并在本机 macOS 上尝试打开浏览器。',
    paramsSpec: ['editorUrl?: Editor URL。', 'openBrowser?: 是否尝试打开浏览器。', 'openTarget?: ai-create-story 时直接打开 AI 创建故事弹窗。', 'openNewTabFallback?: 找不到可复用标签时是否允许新开标签。']
  },
  gamestudio_read_settings: {
    title: '读取 Studio Settings',
    tool: REASONING_TOOLS['gamestudio.bootstrap.readSettings'].tool,
    category: 'gamestudio-bootstrap',
    description: '读取 GameStudio settings 与 effective 配置。',
    paramsSpec: []
  },
  gamestudio_configure_local_production: {
    title: '写入本地生产配置',
    tool: REASONING_TOOLS['gamestudio.bootstrap.configureLocalProduction'].tool,
    category: 'gamestudio-bootstrap',
    description: '写入本地 OMLX 与 ComfyUI 的非密钥生产默认配置。',
    paramsSpec: ['model?: OMLX 模型名。', 'localModelBaseUrl?: OMLX OpenAI-compatible base URL。', 'comfyuiBaseUrl?: ComfyUI URL。']
  },
  gamestudio_self_check: {
    title: '执行 GameStudio 自检',
    tool: REASONING_TOOLS['gamestudio.bootstrap.selfCheck'].tool,
    category: 'gamestudio-bootstrap',
    description: '调用 health、settings、diagnose 和 image preflight，并把结果反馈给 Control artifacts。',
    paramsSpec: ['imagePreflight?: 是否执行图片 preflight。', 'ensureComfyUi?: 是否在 preflight 前确保 ComfyUI 运行（默认 true）。', 'timeoutMs?: 自检超时时间。']
  },
  gamestudio_bootstrap_answer: {
    title: '汇总 GameStudio 打开结果',
    tool: REASONING_TOOLS['gamestudio.bootstrap.answer'].tool,
    category: 'gamestudio-bootstrap',
    description: '基于 Control 观测到的 GameStudio 启动、打开、自检结果生成确定性汇总。',
    paramsSpec: []
  },
  story_create_project: {
    title: '创建互动故事项目',
    tool: REASONING_TOOLS['gamestudio.story.createProject'].tool,
    category: 'story-workflow',
    description: '通过 GameStudio Server 创建标准项目骨架，并记录 storage/projects 证据。',
    paramsSpec: ['title: 项目标题。']
  },
  story_create_ai_project: {
    title: 'AI 创建故事草稿',
    tool: REASONING_TOOLS['gamestudio.story.createAiProject'].tool,
    category: 'story-workflow',
    description: 'Control 调用 GameStudio AI 创建故事接口，生成 scripts 与 blueprint 并记录证据。',
    paramsSpec: ['title: 项目标题。', 'prompt: 故事生成提示词。', 'choicePoints?: 选择点数量。', 'optionsPerChoice?: 每个选择点选项数。', 'endings?: 结局数量。']
  },
  story_configure_project: {
    title: '写入故事生成配置',
    tool: REASONING_TOOLS['gamestudio.story.configureProject'].tool,
    category: 'story-workflow',
    description: '写入题材、风格、目标受众、输出语言和结构公式，并读回验证。',
    paramsSpec: ['projectId?: 项目标识，缺省时使用当前 session 项目或最新项目。', 'config: 生成配置对象。']
  },
  story_inspect_project: {
    title: '检查故事项目证据',
    tool: REASONING_TOOLS['gamestudio.story.inspectProject'].tool,
    category: 'story-workflow',
    description: '读取项目目录、配置、故事、脚本、蓝图、资源和导出产物摘要。',
    paramsSpec: ['projectId?: 项目标识，缺省时使用当前 session 项目或最新项目。']
  },
  story_generate_scripts_candidate: {
    title: '生成故事脚本候选',
    tool: REASONING_TOOLS['gamestudio.story.generateScriptsCandidate'].tool,
    category: 'story-workflow',
    description: '通过 Hermes/OMLX 生成受 schema 约束的 scripts.json 候选。',
    paramsSpec: ['projectId?: 项目标识。', 'brief: 用户故事 brief。', 'title?: 项目标题。']
  },
  story_write_scripts: {
    title: '写入故事脚本',
    tool: REASONING_TOOLS['gamestudio.story.writeScripts'].tool,
    category: 'story-workflow',
    description: '将已验证脚本候选写入项目 scripts.json，并读回验证。',
    paramsSpec: ['projectId?: 项目标识。']
  },
  story_compile_blueprint: {
    title: '编译故事蓝图',
    tool: REASONING_TOOLS['gamestudio.story.compileBlueprint'].tool,
    category: 'story-workflow',
    description: '调用 GameStudio Server 将脚本层编译为蓝图层。',
    paramsSpec: ['projectId?: 项目标识。']
  },
  story_analyze_scripts: {
    title: '分析故事脚本',
    tool: REASONING_TOOLS['gamestudio.story.analyzeScripts'].tool,
    category: 'story-workflow',
    description: '调用 GameStudio Server 分析 scripts，并返回蓝图分支建议。',
    paramsSpec: ['projectId?: 项目标识。']
  },
  story_review_blueprint_agent: {
    title: '智能体评审蓝图',
    tool: REASONING_TOOLS['gamestudio.story.reviewBlueprintAgent'].tool,
    category: 'story-workflow',
    description: '结合 GameStudio 规则、Control 确定性门禁和 Hermes/OMLX 对蓝图进行交互故事评分。',
    paramsSpec: ['projectId?: 项目标识。']
  },
  story_repair_blueprint_if_needed: {
    title: '必要时修复蓝图',
    tool: REASONING_TOOLS['gamestudio.story.repairBlueprintIfNeeded'].tool,
    category: 'story-workflow',
    description: '蓝图评分不足时调用 GameStudio AI 修复脚本并重新编译蓝图；评分通过时跳过。',
    paramsSpec: ['projectId?: 项目标识。']
  },
  story_compile_compose: {
    title: '编译可运行故事',
    tool: REASONING_TOOLS['gamestudio.story.compileCompose'].tool,
    category: 'story-workflow',
    description: '调用 GameStudio Server 将蓝图层编译为可运行 story/project 合成层。',
    paramsSpec: ['projectId?: 项目标识。']
  },
  story_generate_asset_candidate: {
    title: '生成故事资产候选',
    tool: REASONING_TOOLS['gamestudio.story.generateAssetCandidate'].tool,
    category: 'story-workflow',
    description: '检查图片 provider 并尝试生成背景或角色资产候选，失败时返回明确阶段。',
    paramsSpec: ['projectId?: 项目标识。', 'assetKind: background | character。', 'prompt: 资产生成描述。']
  },
  story_preflight_image_provider: {
    title: '检查图片 Provider 前置条件',
    tool: REASONING_TOOLS['gamestudio.story.preflightImageProvider'].tool,
    category: 'story-workflow',
    description: '调用 GameStudio Server image preflight，确认 ComfyUI/provider、节点和模型条件。',
    paramsSpec: ['mode?: basic | storyboard。', 'timeoutMs?: 超时时间。']
  },
  story_create_bible: {
    title: '生成 Story Bible',
    tool: REASONING_TOOLS['gamestudio.story.createBible'].tool,
    category: 'story-workflow',
    description: '通过 GameStudio Server 显式生成 Story Bible，并将结果写回项目 state.aiBackground。',
    paramsSpec: ['projectId?: 项目标识。', 'timeoutMs?: 生成超时时间。']
  },
  story_create_asset_plan: {
    title: '创建故事资产计划',
    tool: REASONING_TOOLS['gamestudio.story.createAssetPlan'].tool,
    category: 'story-workflow',
    description: '基于项目和 Story Bible 创建并保存故事资产计划；缺少 Story Bible 时明确阻断。',
    paramsSpec: ['projectId?: 项目标识。', 'rebuild?: 是否重建资产计划。']
  },
  story_generate_lock_asset_references: {
    title: '绘制锁定事物参考图',
    tool: REASONING_TOOLS['gamestudio.story.generateLockAssetReferences'].tool,
    category: 'story-workflow',
    description: '基于资产计划逐个生成故事必须锁定事物的候选参考图，并自动选择主参考。',
    paramsSpec: ['projectId?: 项目标识。', 'maxAssets?: 最大锁定事物数量。', 'batchSize?: 每个事物候选图数量。']
  },
  story_lock_test: {
    title: '执行事物锁定出图测试',
    tool: REASONING_TOOLS['gamestudio.story.lockTest'].tool,
    category: 'story-workflow',
    description: '通过 ComfyUI SDXL 对故事资产计划中选出的事物执行锁定出图测试，验证 checkpoint/LoRA 组合可用并返回测试图像和评审结果。',
    paramsSpec: ['projectId?: 项目标识。', 'model?: ComfyUI checkpoint 文件名。', 'maxAttempts?: 最大尝试次数（1-4）。', 'style?: 风格（picture_book）。']
  },
  story_render_scene: {
    title: '渲染故事场景图',
    tool: REASONING_TOOLS['gamestudio.story.renderScene'].tool,
    category: 'story-workflow',
    description: '调用 GameStudio Server 对指定 scene 执行场景图渲染，使用已锁定的 reference assets 保证角色/道具/地点一致性。',
    paramsSpec: ['projectId?: 项目标识。', 'sceneId?: 场景标识。']
  },
  story_render_scene_backgrounds: {
    title: '批量渲染场景背景（分层合成）',
    tool: REASONING_TOOLS['gamestudio.story.renderSceneBackgrounds'].tool,
    category: 'story-workflow',
    description: '经 E03 批量队列以 background-only 模式渲染全部场景背景（人物/事物由立绘层承担），轮询批次直至终结并汇总 per-scene 成败。',
    paramsSpec: ['projectId?: 项目标识。', 'width?: 图宽。', 'height?: 图高。', 'pollIntervalMs?: 批次轮询间隔。']
  },
  story_generate_scene_placements: {
    title: '生成场景立绘分层站位',
    tool: REASONING_TOOLS['gamestudio.story.generateScenePlacements'].tool,
    category: 'story-workflow',
    description: '按资产计划为各场景写回立绘 placements 并同步 characters[].imageAssetId；未锁定角色跳过并报告，prop 暂不合成（已知限制）。',
    paramsSpec: ['projectId?: 项目标识。', 'sceneIds?: 指定场景子集。']
  },
  story_generate_lineart: {
    title: '生成资产线稿',
    tool: REASONING_TOOLS['gamestudio.story.generateLineart'].tool,
    category: 'story-workflow',
    description: '对已锁定主参考的必需资产逐个生成 ControlNet 线稿，写回资产计划 lineart 字段，供场景渲染作为附加一致性参考。',
    paramsSpec: ['projectId?: 项目标识。']
  },
  story_validate_project: {
    title: '校验互动故事项目',
    tool: REASONING_TOOLS['gamestudio.story.validateProject'].tool,
    category: 'story-workflow',
    description: '校验蓝图、合成层和最小项目文件集合，输出 deterministic evaluator verdict。',
    paramsSpec: ['projectId?: 项目标识。']
  },
  story_export_project: {
    title: '导出互动故事项目',
    tool: REASONING_TOOLS['gamestudio.story.exportProject'].tool,
    category: 'story-workflow',
    description: '调用 GameStudio Server 导出 H5，并返回 distUrl 与本地产物证据。',
    paramsSpec: ['projectId?: 项目标识。']
  },
  web_search: {
    title: '搜索网页',
    tool: REASONING_TOOLS['web.search'].tool,
    category: 'web',
    description: '使用搜索引擎查询网络信息，返回标题、链接和摘要列表。',
    paramsSpec: ['query: 搜索关键词。', 'limit?: 返回结果数量（1-20，默认 5）。']
  },
  web_extract: {
    title: '提取网页内容',
    tool: REASONING_TOOLS['web.extract'].tool,
    category: 'web',
    description: '提取指定网页或 PDF 的文本内容，用于获取外部文档、API 参考或技术方案。',
    paramsSpec: ['urls: 要提取的 URL 列表（最多 5 个）。']
  },
  shell_execute: {
    title: '执行 Shell 命令',
    tool: REASONING_TOOLS['shell.execute'].tool,
    category: 'invoke',
    description: '在工作区内执行 shell 命令，支持 npm test、git status、tsc、ls、cat 等常用命令。',
    paramsSpec: ['command: 要执行的 shell 命令字符串。', 'timeoutMs?: 超时时间（默认 30000ms）。']
  },
  vision_analyze: {
    title: '分析图片',
    tool: REASONING_TOOLS['vision.analyze'].tool,
    category: 'vision',
    description: '使用视觉模型分析图片（本地路径或 URL），回答关于图片内容的问题。',
    paramsSpec: ['imagePath: 图片本地路径或 URL。', 'question?: 关于图片的具体问题（默认"描述这张图片"）。']
  },
  git_status: {
    title: 'Git 状态',
    tool: REASONING_TOOLS['git.status'].tool,
    category: 'git',
    description: '查看当前 Git 工作区的修改状态。',
    paramsSpec: []
  },
  git_diff: {
    title: 'Git 差异',
    tool: REASONING_TOOLS['git.diff'].tool,
    category: 'git',
    description: '查看 Git 修改差异。',
    paramsSpec: ['filePath?: 指定文件路径，默认查看全部差异。']
  },
  git_log: {
    title: 'Git 日志',
    tool: REASONING_TOOLS['git.log'].tool,
    category: 'git',
    description: '查看 Git 提交历史。',
    paramsSpec: ['maxCount?: 最大返回提交数（默认 10）。']
  },
  git_branch: {
    title: 'Git 分支',
    tool: REASONING_TOOLS['git.branch'].tool,
    category: 'git',
    description: '查看当前 Git 分支列表。',
    paramsSpec: []
  },
  test_run: {
    title: '运行测试',
    tool: REASONING_TOOLS['test.run'].tool,
    category: 'test',
    description: '运行项目测试（npm test / pytest / jest 等），返回测试结果摘要。',
    paramsSpec: ['command?: 测试命令（默认自动检测：npm test / pytest / jest）。', 'timeoutMs?: 超时时间（默认 60000）。']
  },
  mcp_call: {
    title: '调用 MCP 工具',
    tool: REASONING_TOOLS['mcp.call'].tool,
    category: 'mcp',
    description: '调用已配置的 MCP（Model Context Protocol）外部工具，如数据库查询、API 调用等。',
    paramsSpec: ['serverName: MCP 服务器名称。', 'toolName: 要调用的工具名称。', 'args?: 工具参数对象。']
  }
}

export const REASONING_ALLOWED_ACTION_NAMES = Object.keys(REASONING_ACTIONS)

export const REASONING_STORY_WORKFLOW_ACTION_NAMES = [
  'story_create_project',
  'story_create_ai_project',
  'story_configure_project',
  'story_inspect_project',
  'story_generate_scripts_candidate',
  'story_write_scripts',
  'story_compile_blueprint',
  'story_analyze_scripts',
  'story_review_blueprint_agent',
  'story_repair_blueprint_if_needed',
  'story_compile_compose',
  'story_preflight_image_provider',
  'story_create_bible',
  'story_create_asset_plan',
  'story_generate_lock_asset_references',
  'story_lock_test',
  'story_generate_lineart',
  'story_render_scene',
  'story_render_scene_backgrounds',
  'story_generate_scene_placements',
  'story_generate_asset_candidate',
  'story_validate_project',
  'story_export_project'
]

export const REASONING_GAMESTUDIO_BOOTSTRAP_ACTION_NAMES = [
  'gamestudio_ensure_running',
  'gamestudio_open_editor',
  'gamestudio_read_settings',
  'gamestudio_configure_local_production',
  'gamestudio_self_check'
]

export const REASONING_STORY_MUTATION_ACTION_NAMES = [
  'story_create_project',
  'story_create_ai_project',
  'story_configure_project',
  'story_write_scripts',
  'story_compile_blueprint',
  'story_repair_blueprint_if_needed',
  'story_compile_compose',
  'story_create_bible',
  'story_create_asset_plan',
  'story_generate_lock_asset_references',
  'story_lock_test',
  'story_render_scene',
  'story_render_scene_backgrounds',
  'story_generate_scene_placements',
  'story_generate_asset_candidate',
  'story_export_project'
]

export function isReasoningStoryWorkflowAction(action) {
  return REASONING_STORY_WORKFLOW_ACTION_NAMES.includes(String(action || ''))
}

export function isReasoningStoryMutationAction(action) {
  return REASONING_STORY_MUTATION_ACTION_NAMES.includes(String(action || ''))
}

export function isReasoningWriteAction(action) {
  return action === 'edit_workspace_file'
    || action === 'create_workspace_file'
    || action === 'rename_workspace_path'
    || action === 'delete_workspace_path'
    || action === 'write_memory_file'
    || action === 'update_task_queue'
    || isReasoningStoryMutationAction(action)
}

export function isReasoningInvokeAction(action) {
  return action === 'run_lifecycle_script' || action === 'run_workspace_script' || action === 'shell_execute'
}

export function isReasoningAnswerAction(action) {
  return action === 'generate_default_answer'
}

// HERMES-H03：右脑子 agent（监察）只读白名单。
// 列入本清单的 action 必须已经在 REASONING_ACTIONS 注册、且属于只读性质
// （reviewPolicy=auto、非 write/invoke 类别）；子 agent 只可直接调用这些 action。
// 已注册但未列入的 action 对子 agent 属于越权（拒绝 + 审计），未注册的一律拒绝。
// 对齐关系由 scripts/test/rightBrainSupervision.test.mjs 断言保护，新增 action 时同步维护。
export const RIGHT_BRAIN_SUPERVISION_READ_ACTIONS = Object.freeze([
  'read_recent_context',
  'locate_project',
  'list_directory_contents',
  'inspect_server_image_entrypoints',
  'inspect_control_backend_surfaces',
  'read_file_content',
  'search_workspace_text',
  'gamestudio_read_settings',
  'story_inspect_project',
  'story_analyze_scripts',
  'story_preflight_image_provider',
  'story_validate_project',
  'git_status',
  'git_diff',
  'git_log',
  'git_branch'
])

export function isRightBrainSupervisionReadAction(action) {
  return RIGHT_BRAIN_SUPERVISION_READ_ACTIONS.includes(String(action || ''))
}

export function buildReasoningActionCatalog() {
  return Object.entries(REASONING_ACTIONS).map(([action, metadata]) => ({
    action,
    title: metadata.title,
    tool: metadata.tool,
    category: metadata.category || 'general',
    description: metadata.description || '',
    paramsSpec: Array.isArray(metadata.paramsSpec) ? metadata.paramsSpec : [],
    defaultSkipReview: !isReasoningWriteAction(action) && !isReasoningInvokeAction(action),
    requiresHumanReview: isReasoningWriteAction(action) || isReasoningInvokeAction(action)
  }))
}