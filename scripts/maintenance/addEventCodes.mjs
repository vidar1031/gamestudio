#!/usr/bin/env node
// 为 apps/server/events/registry.v1.json 的每个事件补充 code / aliases / chatArgs。
// 一次性迁移脚本，执行后可删除；保留便于后续新增事件时参考编号规则。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const registryPath = path.resolve(__dirname, '../../apps/server/events/registry.v1.json')

const META = {
  'project.list': { aliases: ['项目列表', '列出项目'] },
  'project.create': { aliases: ['创建项目', '创建故事', '新建项目'], chatArgs: [{ name: 'title', required: true, description: '项目标题（取整段剩余输入）' }] },
  'project.inspect': { aliases: ['读取项目', '检查项目', '项目详情'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'project.configure': { aliases: ['写入配置', '配置项目', '设置项目'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'project.update': { aliases: ['更新项目'] },
  'project.delete': { aliases: ['删除项目'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'project.validate': { aliases: ['校验项目', '验证项目'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'project.export': { aliases: ['导出项目', '导出 H5', '导出'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'project.exports.list': { aliases: ['导出列表', '产物列表'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'story.scripts.generate': { aliases: ['生成脚本', '生成故事脚本'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'story.scripts.read': { aliases: ['读取脚本'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'story.scripts.write': { aliases: ['写入脚本'] },
  'story.bible.generate': { aliases: ['生成 Story Bible', '故事圣经'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'story.blueprint.compile': { aliases: ['编译蓝图'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'story.blueprint.review': { aliases: ['蓝图评审', '评审蓝图'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'story.scripts.repair': { aliases: ['修复脚本', '修复蓝图'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'story.compose.compile': { aliases: ['编译合成层', '编译合成'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'asset.plan.create': { aliases: ['创建资产计划', '资产计划'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'asset.reference.generate': { aliases: ['生成参考图', '生成资产参考图'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'asset.reference.lock': { aliases: ['锁定参考图', '锁定资产'] },
  'asset.lock.test': { aliases: ['锁定测试'], chatArgs: [{ name: 'projectId', required: true, description: '项目 ID' }] },
  'asset.scene.render': { aliases: ['渲染场景', '场景渲染'] },
  'asset.background.generate': { aliases: ['生成背景图', '背景图'] },
  'studio.settings.read': { aliases: ['设置', '读取设置', '工作室设置'] },
  'studio.settings.write': { aliases: ['写入设置', '保存设置'] },
  'studio.ai.status': { aliases: ['状态', 'AI 状态', 'ai状态', 'AI状态'] },
  'studio.image.preflight': { aliases: ['图片预检', '图片 provider 预检', 'preflight'] },
  'studio.runtime.status': { aliases: ['运行状态', '运行状态检查', '是否运行中', 'runtime', '启动状态'] },
  'studio.selfcheck': { aliases: ['自检', '自检配置', '配置自检', 'selfcheck', '配置状态'] }
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
registry.events = registry.events.map((event, index) => {
  const meta = META[event.eventId] || {}
  const code = `GS-${String(index + 1).padStart(2, '0')}`
  return {
    code,
    ...event,
    aliases: meta.aliases || [],
    chatArgs: meta.chatArgs || []
  }
})
registry.contract.notes.push('code（GS-01…）为事件短编号；aliases 为中文别名；chatArgs 为聊天激活时的位置参数说明。聊天输入格式：talkscene <eventId|code|别名> [参数]。')
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')
console.log(`updated ${registry.events.length} events`)
