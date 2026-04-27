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
  'project.listStories': {
    tool: 'project.listStories',
    title: '读取故事索引',
    category: 'observable',
    executionMode: 'deterministic',
    reviewPolicy: 'auto',
    description: '扫描 storage/projects/*/scripts.json 生成可验证故事索引。',
    routes: ['internal:reasoning/project.listStories']
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
  'planner.default': {
    tool: 'planner.default',
    title: '整理问题',
    category: 'planner',
    executionMode: 'model-assisted',
    reviewPolicy: 'auto',
    description: '结合上下文规划后续动作。',
    routes: ['internal:reasoning/planner.default']
  },
  'model.answer': {
    tool: 'model.answer',
    title: '生成最终回答',
    category: 'answer',
    executionMode: 'model-assisted',
    reviewPolicy: 'required',
    description: '基于当前 artifacts 生成最终回答或结构化总结。',
    routes: ['internal:reasoning/model.answer']
  }
}

export function buildReasoningToolCatalog() {
  return Object.values(REASONING_TOOLS)
}