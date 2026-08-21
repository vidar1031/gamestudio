#!/usr/bin/env node
// 从 registry.v1.json 生成 manifest 和 capabilities 文件
// 以 registry.v1.json 的 eventId 为唯一命名标准

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..')

const REGISTRY_PATH = path.join(ROOT, 'apps/server/events/registry.v1.json')
const MANIFEST_PATH = path.join(ROOT, 'apps/server/events/project-manifest.v1.json')
const CAPABILITIES_PATH = path.join(ROOT, 'apps/server/events/capabilities.v1.json')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, filePath)
}

// 从 registry 事件生成 capability
function eventToCapability(event) {
  const kind = String(event?.kind || '').trim().toLowerCase()
  const type = kind === 'command' ? 'write' : 'read'
  
  // 根据 eventId 推断 resourceKind
  let resourceKind = 'none'
  if (/ai|generate|render|bible|review|repair/i.test(event.eventId)) {
    resourceKind = 'llm'
  }
  if (/scene|render|asset|image|background|lineart/i.test(event.eventId)) {
    resourceKind = 'gpu'
  }
  
  // 根据 eventId 推断 reviewPolicy
  let reviewPolicy = 'auto_allowed'
  if (event.reviewRequired) {
    if (/export|publish/i.test(event.eventId)) {
      reviewPolicy = 'manual_before_export'
    } else {
      reviewPolicy = 'manual_before_write'
    }
  } else if (type === 'write') {
    reviewPolicy = 'auto_with_versioning'
  }
  
  return {
    id: event.eventId,
    type,
    label: event.title || event.eventId,
    description: event.description || '',
    requiresReview: Boolean(event.reviewRequired),
    reviewPolicy,
    resourceKind,
    inputSchema: event.payloadSchema || null,
    outputSchema: event.resultSchema || null,
    artifacts: Array.isArray(event.sideEffects) 
      ? event.sideEffects.filter((s) => String(s).startsWith('fs:write:')).map((s) => String(s).replace('fs:write:', ''))
      : [],
    timeoutMs: Number(event.timeoutMs) || 30000,
    event: {
      code: event.code,
      eventId: event.eventId,
      kind: event.kind
    }
  }
}

// 生成 manifest
function generateManifest(registry) {
  const events = Array.isArray(registry?.events) ? registry.events : []
  const capabilities = events.map(eventToCapability)
  
  return {
    version: '1.0',
    projectId: 'gamestudio',
    kind: 'gamestudio-story-project',
    displayName: 'GameStudio 交互故事',
    rootDir: '/Volumes/ovokit2t/aiwork/gamestudio',
    capabilities,
    events: events.map((e) => e.eventId),
    workflows: ['story_production', 'story_review', 'story_export'],
    boundaries: {
      allowedRoots: ['/Volumes/ovokit2t/aiwork/gamestudio/storage/projects'],
      disallowOutsideWorkspace: true
    },
    generatedAt: new Date().toISOString(),
    generatedFrom: 'registry.v1.json'
  }
}

// 生成 capabilities
function generateCapabilities(registry) {
  const events = Array.isArray(registry?.events) ? registry.events : []
  const capabilities = events.map(eventToCapability)
  
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    generatedFrom: 'registry.v1.json',
    provider: registry.provider || {
      id: 'gamestudio',
      name: 'GameStudio 互动故事生产能力层',
      baseUrl: 'http://127.0.0.1:1999'
    },
    capabilities
  }
}

// 主函数
function main() {
  console.log('读取 registry.v1.json...')
  const registry = readJson(REGISTRY_PATH)
  
  console.log(`生成 manifest（${registry.events.length} 个能力）...`)
  const manifest = generateManifest(registry)
  writeJson(MANIFEST_PATH, manifest)
  
  console.log(`生成 capabilities（${registry.events.length} 个能力）...`)
  const capabilities = generateCapabilities(registry)
  writeJson(CAPABILITIES_PATH, capabilities)
  
  console.log('完成！')
  console.log(`- manifest: ${MANIFEST_PATH}`)
  console.log(`- capabilities: ${CAPABILITIES_PATH}`)
}

main()
