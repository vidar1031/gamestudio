// Workspace inspection helpers split out of controlServerCore.js.
// These functions only depend on fs/path and the workspace root constants,
// so they are safe to extract verbatim.

import fs from 'node:fs'
import path from 'node:path'
import {
  GAMESTUDIO_ROOT,
  STUDIO_STORAGE_ROOT,
  STORAGE_PROJECTS_ROOT,
} from '../../config/paths.js'

export function resolveWorkspacePathFromInput(inputPath) {
  const requestedPath = String(inputPath || '').trim()
  if (!requestedPath) return ''
  return path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(GAMESTUDIO_ROOT, requestedPath)
}

export function inspectControlBackendSurfaces() {
  const searchedRoot = path.join(GAMESTUDIO_ROOT, 'apps')
  const entries = [
    {
      filePath: path.join(GAMESTUDIO_ROOT, 'apps', 'control-server', 'src', 'index.js'),
      role: 'Hermes 对话、reasoning session 与 control API 主后端入口',
      reason: '这里集中定义 Hermes chat、reasoning session、上下文池、runtime action 与审核流程，是 control 侧最核心的后端控制面。',
      evidence: [
        '路由: /api/control/agents/:agentId/chat',
        '路由: /api/control/agents/:agentId/reasoning-sessions',
        '函数: generateReasoningPlan(...)',
        '函数: generateReasoningFinalAnswer(...)',
        '函数: executeReasoningStep(...)'
      ]
    }
  ].filter((entry) => fs.existsSync(entry.filePath))

  return {
    searchedRoot,
    count: entries.length,
    entries
  }
}

export function inspectWorkspaceDirectory(dirPath) {
  const requestedPath = String(dirPath || '').trim()
  const resolvedPath = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(GAMESTUDIO_ROOT, requestedPath)

  if (!resolvedPath.startsWith(GAMESTUDIO_ROOT)) {
    throw new Error('list_directory_contents_path_outside_workspace')
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`list_directory_contents_not_found: ${resolvedPath}`)
  }
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`list_directory_contents_not_directory: ${resolvedPath}`)
  }

  const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : (entry.isFile() ? 'file' : 'other')
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-CN')
    })

  return {
    requestedPath,
    resolvedPath,
    count: entries.length,
    entries
  }
}

export function inspectServerImageEntrypoints() {
  const searchedRoot = path.join(GAMESTUDIO_ROOT, 'apps', 'server', 'src')
  const entries = [
    {
      filePath: path.join(searchedRoot, 'index.js'),
      role: '服务端 HTTP 入口与图片路由汇总',
      reason: '这里是 Hono 服务主入口，集中定义图片相关 API，并把请求转发到实际的 AI 图片模块。',
      evidence: [
        '路由: /api/studio/image/preflight',
        '路由: /api/studio/image/models',
        '路由: /api/studio/image/test',
        '调用: generateBackgroundImage(...)',
        '调用: generateBackgroundPrompt(...)',
        '调用: buildStoryAssetPlan(...) / buildStorySceneRenderSpec(...)'
      ]
    },
    {
      filePath: path.join(searchedRoot, 'ai', 'background.js'),
      role: '实际出图分发器',
      reason: '这里封装不同图片后端的生成逻辑，是图片 bytes 真正产生的核心服务模块。',
      evidence: [
        '导出: generateBackgroundImage(input)',
        '导出: runComfyuiPromptWorkflow(...)',
        '负责 provider 分发: sdwebui / comfyui / doubao'
      ]
    },
    {
      filePath: path.join(searchedRoot, 'ai', 'imagePrompt.js'),
      role: '图片提示词生成入口',
      reason: '真正出图前，服务端会先在这里把自然语言整理成适合文生图后端的 prompt / negativePrompt。',
      evidence: [
        '导出: generateBackgroundPrompt(...)',
        '输出结构: globalPrompt / scenePrompt / prompt / negativePrompt'
      ]
    },
    {
      filePath: path.join(searchedRoot, 'ai', 'storyAssets.js'),
      role: '故事资产图片链路入口',
      reason: '当问题不是简单背景测试，而是故事资产或场景资产生成时，这里负责生成资产计划与渲染规格。',
      evidence: [
        '导出: buildStoryAssetPlan(...)',
        '导出: buildStorySceneRenderSpec(...)',
        '被 apps/server/src/index.js 的故事资产图片流程调用'
      ]
    }
  ].filter((entry) => fs.existsSync(entry.filePath))

  return {
    searchedRoot,
    count: entries.length,
    entries
  }
}

export function discoverWorkspaceAppRoots() {
  const appsRoot = path.join(GAMESTUDIO_ROOT, 'apps')
  if (!fs.existsSync(appsRoot) || !fs.statSync(appsRoot).isDirectory()) return {}
  const appRoots = {}
  for (const name of fs.readdirSync(appsRoot)) {
    const appPath = path.join(appsRoot, name)
    if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) continue
    appRoots[name] = appPath
  }
  return appRoots
}

export function buildWorkspaceStructureArtifact() {
  const appRoots = discoverWorkspaceAppRoots()
  return {
    appsRoot: path.join(GAMESTUDIO_ROOT, 'apps'),
    appRoots,
    controlConsoleRoot: appRoots['control-console'] || path.join(GAMESTUDIO_ROOT, 'apps', 'control-console'),
    controlServerRoot: appRoots['control-server'] || path.join(GAMESTUDIO_ROOT, 'apps', 'control-server'),
    editorAppRoot: appRoots.editor || path.join(GAMESTUDIO_ROOT, 'apps', 'editor'),
    serverAppRoot: appRoots.server || path.join(GAMESTUDIO_ROOT, 'apps', 'server'),
    storageRoot: STUDIO_STORAGE_ROOT,
    projectsRoot: STORAGE_PROJECTS_ROOT
  }
}
