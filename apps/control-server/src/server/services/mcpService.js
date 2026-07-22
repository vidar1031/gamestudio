/**
 * MCP Service - Model Context Protocol 支持
 *
 * 为 Control reasoning pipeline 提供 MCP 工具发现和调用能力。
 * 当前为简化实现：通过配置文件加载 MCP 服务器，在 reasoning 启动时动态发现工具。
 *
 * 设计原则：
 * - 与 Hermes Python 框架的 mcp_tool.py 能力对齐
 * - 纯 Node.js 实现，使用官方 @modelcontextprotocol/sdk
 * - 工具发现后注册到 reasoning tool registry 的动态扩展槽
 */

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'

let mcpClientCache = null
let mcpToolsCache = []

function getMcpConfigPath() {
  return path.join(GAMESTUDIO_ROOT, 'config', 'hermes', 'mcp.json')
}

function readMcpConfig() {
  const configPath = getMcpConfigPath()
  if (!fs.existsSync(configPath)) return { servers: [] }
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { servers: [] }
  }
}

/**
 * 获取当前 MCP 状态（不实际连接服务器，仅返回配置状态）
 * 完整 MCP 客户端连接需要 @modelcontextprotocol/sdk，当前为预留接口。
 */
export function getMcpStatus() {
  const config = readMcpConfig()
  const servers = Array.isArray(config.servers) ? config.servers : []
  return {
    enabled: servers.length > 0,
    serverCount: servers.length,
    servers: servers.map((s) => ({
      name: s.name || 'unnamed',
      command: s.command || '',
      enabled: s.enabled !== false
    })),
    toolCount: mcpToolsCache.length,
    detail: servers.length > 0
      ? `已配置 ${servers.length} 个 MCP 服务器。`
      : '未配置 MCP 服务器。如需启用，请在 config/hermes/mcp.json 中配置。'
  }
}

/**
 * 获取已缓存的 MCP 工具列表
 */
export function getMcpTools() {
  return [...mcpToolsCache]
}

/**
 * 尝试从 MCP 服务器发现工具（预留接口）
 * 完整实现需要安装 @modelcontextprotocol/sdk 并建立 stdio/sse 连接。
 */
export async function discoverMcpTools() {
  const config = readMcpConfig()
  const servers = Array.isArray(config.servers) ? config.servers : []
  const discovered = []

  for (const server of servers) {
    if (server.enabled === false) continue
    // Placeholder: 实际实现需使用 Client 连接并调用 listTools()
    discovered.push({
      server: server.name || 'unknown',
      tools: [],
      note: 'MCP 工具发现需要安装 @modelcontextprotocol/sdk。当前为预留接口。'
    })
  }

  return discovered
}

/**
 * 调用 MCP 工具（预留接口）
 */
export async function callMcpTool(serverName, toolName, args) {
  return {
    ok: false,
    error: 'MCP 工具调用需要安装 @modelcontextprotocol/sdk 并建立连接。当前为预留接口。',
    serverName,
    toolName,
    args
  }
}
