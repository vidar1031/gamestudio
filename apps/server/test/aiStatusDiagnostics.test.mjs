import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getAiStatusSnapshot } from '../src/ai/diagnostics.js'
import { writeStudioSettings } from '../src/studio/settings.js'

test('AI 状态返回真实生效模型，不把环境默认值当作任务配置', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'talkscene-ai-status-'))
  await writeStudioSettings(storageRoot, {
    enabled: { scripts: true, prompt: true, image: false, tts: false },
    scripts: { provider: 'localoxml', model: 'Qwen3.6-27B-4bit' },
    prompt: { provider: 'localoxml', model: 'Qwen3.6-27B-4bit' },
    translation: { provider: 'localoxml', model: 'Qwen3.6-27B-4bit' }
  })
  const snapshot = await getAiStatusSnapshot(storageRoot)
  assert.equal(snapshot.settingsLoaded, true)
  for (const key of ['scripts', 'prompt', 'translation']) {
    assert.deepEqual(snapshot.generation[key], { provider: 'localoxml', model: 'Qwen3.6-27B-4bit' })
    assert.equal(Object.hasOwn(snapshot.generation[key], 'apiKey'), false)
  }
  assert.equal(snapshot.effective.enabled.scripts, true)
  assert.equal(snapshot.effective.enabled.image, false)
  assert.equal(snapshot.effective.enabled.tts, false)
})
