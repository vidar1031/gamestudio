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
  list_created_stories: {
    title: '读取故事索引',
    tool: REASONING_TOOLS['project.listStories'].tool,
    category: 'observable',
    description: '扫描 storage/projects/*/scripts.json，输出可验证的故事索引。',
    paramsSpec: []
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
  summarize_story_index: {
    title: '生成最终回答',
    tool: REASONING_TOOLS['model.answer'].tool,
    category: 'answer',
    description: '基于故事索引和上下文生成最终回答。',
    paramsSpec: []
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
      'scriptName: restart_control.sh | restart_server.sh | reporter.sh | openclaw_selfcheck.sh'
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
  }
}

export const REASONING_ALLOWED_ACTION_NAMES = Object.keys(REASONING_ACTIONS)

export function isReasoningWriteAction(action) {
  return action === 'edit_workspace_file' || action === 'create_workspace_file' || action === 'rename_workspace_path' || action === 'delete_workspace_path' || action === 'write_memory_file' || action === 'update_task_queue'
}

export function isReasoningInvokeAction(action) {
  return action === 'run_lifecycle_script' || action === 'run_workspace_script'
}

export function isReasoningAnswerAction(action) {
  return action === 'generate_default_answer' || action === 'summarize_story_index'
}

export function buildReasoningActionCatalog() {
  return Object.entries(REASONING_ACTIONS).map(([action, metadata]) => ({
    action,
    title: metadata.title,
    tool: metadata.tool,
    category: metadata.category || 'general',
    description: metadata.description || '',
    paramsSpec: Array.isArray(metadata.paramsSpec) ? metadata.paramsSpec : [],
    defaultSkipReview: !isReasoningWriteAction(action) && !isReasoningAnswerAction(action) && !isReasoningInvokeAction(action),
    requiresHumanReview: isReasoningWriteAction(action) || isReasoningAnswerAction(action) || isReasoningInvokeAction(action)
  }))
}