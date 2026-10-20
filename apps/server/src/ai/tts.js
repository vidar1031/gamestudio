// 2026-10-20 语音 TTS 落地（ui_设置定义.md §7.6，设置页 V1 第二波）：
// provider 分派：edge（edge-tts，免费·联网·推荐）/ say（macOS 内置·离线兜底）/
// openai（/audio/speech）/ local（OpenAI 兼容形态）/ doubao（未接入，诚实报错）。
// 试听预览写 <storageRoot>/_shared/tts_previews/，保留最近 10 份自动清理。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listTtsVoiceGroups, resolveTtsVoice } from './ttsVoices.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const EDGE_TTS_PYTHON = path.join(REPO_ROOT, 'tools', 'tts-venv', 'bin', 'python')

const DEFAULT_OPENAI_TTS_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_TTS_MODEL = 'tts-1'
const SAY_DEFAULT_VOICE = 'Tingting'
const SAY_BASE_WPM = 175
const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

// 音色清单（分组结构）：[{group, items:[{id,label,engineVoice,pitch,rateAdjust}]}]，编辑器下拉按组渲染
export function listTtsVoices(provider) {
  return listTtsVoiceGroups(provider)
}

export class TtsError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function clampSpeed(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1.0
  return Math.max(0.5, Math.min(2.0, n))
}

function runCommand(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let p
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      reject(e)
      return
    }
    const errChunks = []
    const killTimer = setTimeout(() => {
      try {
        p.kill('SIGKILL')
      } catch (_) {}
      reject(new TtsError('tts_timeout', `合成超时（>${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)
    p.stderr.on('data', (d) => errChunks.push(d))
    p.on('error', (e) => {
      clearTimeout(killTimer)
      reject(new TtsError('tts_spawn_failed', e && e.message ? String(e.message) : String(e)))
    })
    p.on('close', (code) => {
      clearTimeout(killTimer)
      const errText = Buffer.concat(errChunks).toString('utf-8').trim()
      if (code === 0) {
        resolve({ stderr: errText })
      } else {
        reject(new TtsError('tts_engine_failed', `${path.basename(cmd)} 退出码 ${code}${errText ? `：${errText.slice(-400)}` : ''}`))
      }
    })
  })
}

// edge-tts：rate = (speed-1)×100% + rateAdjust（带符号拼接）；pitch 非 0 时追加 --pitch=±Hz；仅输出 mp3
async function synthesizeEdge({ voice, speed, format, text, pitch, rateAdjust }) {
  if (String(format || 'mp3').toLowerCase() !== 'mp3') {
    throw new TtsError('tts_format_unsupported', 'edge 引擎仅输出 mp3；wav 请改用 openai/local provider')
  }
  if (!existsSync(EDGE_TTS_PYTHON)) {
    throw new TtsError('tts_engine_missing', `edge-tts 引擎未安装（缺少 tools/tts-venv）；请在仓根执行：python3 -m venv tools/tts-venv && tools/tts-venv/bin/pip install edge-tts`)
  }
  const tmp = await mkdtemp(path.join(tmpdir(), 'talkscene-tts-'))
  try {
    const out = path.join(tmp, 'out.mp3')
    const ratePct = Math.round((clampSpeed(speed) - 1) * 100 + (Number(rateAdjust) || 0))
    const rate = `${ratePct >= 0 ? '+' : ''}${ratePct}%`
    const pitchHz = Math.round(Number(pitch) || 0)
    const args = ['-m', 'edge_tts', '--voice', voice, `--rate=${rate}`]
    if (pitchHz !== 0) args.push(`--pitch=${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz`)
    args.push('--text', text, '--write-media', out)
    await runCommand(EDGE_TTS_PYTHON, args, { timeoutMs: 60_000 })
    const bytes = await readFile(out)
    if (!bytes.length) throw new TtsError('tts_empty_output', 'edge-tts 返回空音频')
    return { bytes, ext: 'mp3', mime: 'audio/mpeg' }
  } catch (e) {
    if (e && e.code && String(e.code).startsWith('tts_')) throw e
    const msg = e && e.message ? String(e.message) : String(e)
    throw new TtsError('tts_edge_failed', `edge-tts 合成失败（需联网访问微软免费通道）：${msg}`)
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// macOS 内置 say（离线兜底）：say 出 aiff，afconvert 转 AAC m4a
async function synthesizeSay({ voice, speed, text }) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'talkscene-tts-'))
  try {
    const aiff = path.join(tmp, 'out.aiff')
    const m4a = path.join(tmp, 'out.m4a')
    const wpm = String(Math.round(SAY_BASE_WPM * clampSpeed(speed)))
    await runCommand('say', ['-v', voice || SAY_DEFAULT_VOICE, '-r', wpm, '-o', aiff, text], { timeoutMs: 60_000 })
    await runCommand('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, m4a], { timeoutMs: 60_000 })
    const bytes = await readFile(m4a)
    if (!bytes.length) throw new TtsError('tts_empty_output', 'say 返回空音频')
    return { bytes, ext: 'm4a', mime: 'audio/mp4' }
  } catch (e) {
    if (e && e.code && String(e.code).startsWith('tts_')) throw e
    const msg = e && e.message ? String(e.message) : String(e)
    throw new TtsError('tts_say_failed', `本机 say 合成失败：${msg}`)
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// OpenAI 兼容 /audio/speech（openai 官方与 local 自建端点共用；curl 承载以支持代理设置）
async function synthesizeOpenAiCompat({ provider, voice, speed, format, text, apiUrl, model, apiKey, proxyUrl }) {
  const base = String(apiUrl || (provider === 'openai' ? DEFAULT_OPENAI_TTS_BASE_URL : '')).trim().replace(/\/+$/, '')
  if (!base) throw new TtsError('tts_missing_api_url', '请填写接口地址')
  if (provider === 'openai' && !apiKey) throw new TtsError('tts_missing_key', '缺少 OpenAI 接口 Key（在设置页「接口 Key」区填写）')
  const url = `${base}/audio/speech`
  const fmt = String(format || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3'
  const body = JSON.stringify({
    model: String(model || '').trim() || DEFAULT_OPENAI_TTS_MODEL,
    input: text,
    voice: String(voice || '').trim() || 'alloy',
    speed: clampSpeed(speed),
    response_format: fmt
  })

  const tmp = await mkdtemp(path.join(tmpdir(), 'talkscene-tts-'))
  try {
    const out = path.join(tmp, `out.${fmt}`)
    const args = [
      '-sS',
      '-X',
      'POST',
      '--max-time',
      '60',
      '-o',
      out,
      '-w',
      '%{http_code}',
      '-H',
      'Content-Type: application/json',
      ...(apiKey ? ['-H', `Authorization: Bearer ${apiKey}`] : []),
      ...(proxyUrl ? ['--proxy', String(proxyUrl)] : []),
      '--data-binary',
      '@-',
      url
    ]
    const status = await new Promise((resolve, reject) => {
      const p = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks = []
      const errChunks = []
      p.stdout.on('data', (d) => chunks.push(d))
      p.stderr.on('data', (d) => errChunks.push(d))
      p.on('error', (e) => reject(new TtsError('tts_spawn_failed', e && e.message ? String(e.message) : String(e))))
      p.on('close', (code) => {
        const outText = Buffer.concat(chunks).toString('utf-8').trim()
        const errText = Buffer.concat(errChunks).toString('utf-8').trim()
        if (code !== 0) {
          reject(new TtsError('tts_network_failed', `curl 退出码 ${code}${errText ? `：${errText.slice(-300)}` : ''}`))
          return
        }
        resolve(Number(outText))
      })
      p.stdin.on('error', () => {})
      p.stdin.write(body)
      p.stdin.end()
    })
    if (!Number.isFinite(status)) throw new TtsError('tts_network_failed', 'curl 未返回 HTTP 状态码')
    if (status < 200 || status >= 300) {
      const errBody = await readFile(out, 'utf-8').catch(() => '')
      throw new TtsError('tts_upstream_failed', `接口返回 HTTP_${status}${errBody ? `：${String(errBody).slice(-300)}` : ''}`)
    }
    const bytes = await readFile(out)
    if (!bytes.length) throw new TtsError('tts_empty_output', '接口返回空音频')
    return { bytes, ext: fmt, mime: fmt === 'wav' ? 'audio/wav' : 'audio/mpeg' }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 语音合成统一入口。
 * voice 接受音色库预设 id（如 child_girl）或裸引擎音名（如 zh-CN-XiaoxiaoNeural），
 * 经 ttsVoices.resolveTtsVoice 归一为 { engineVoice, pitch, rateAdjust }；可选 pitch 显式覆盖预设音高。
 * @returns {Promise<{ bytes: Buffer, ext: string, mime: string, engineVoice: string }>}
 * 失败抛 TtsError（code 结构化：tts_disabled 之外详见各分支），不静默。
 */
export async function synthesizeTts({ provider, voice, pitch, speed, format, text, apiUrl, model, secrets, proxyUrl }) {
  const p = String(provider || '').trim().toLowerCase()
  const t = String(text || '').trim()
  if (!t) throw new TtsError('tts_empty_text', '合成文本为空')
  if (!p || p === 'none') throw new TtsError('tts_not_configured', '请先在设置中配置语音 Provider')
  const resolved = resolveTtsVoice(voice)
  const engineVoice = resolved?.engineVoice || ''
  // pitch 显式传参优先，否则取预设微调值（自定义裸引擎音名为 0）
  const pitchHz = pitch != null && pitch !== '' && Number.isFinite(Number(pitch)) ? Math.round(Number(pitch)) : resolved?.pitch || 0
  const rateAdjust = resolved?.rateAdjust || 0

  if (p === 'edge') {
    const r = await synthesizeEdge({ voice: engineVoice || EDGE_DEFAULT_VOICE, speed, format, text: t, pitch: pitchHz, rateAdjust })
    return { ...r, engineVoice: engineVoice || EDGE_DEFAULT_VOICE }
  }
  if (p === 'say') {
    const r = await synthesizeSay({ voice: engineVoice || SAY_DEFAULT_VOICE, speed, text: t })
    return { ...r, engineVoice: engineVoice || SAY_DEFAULT_VOICE }
  }
  if (p === 'openai') {
    const r = await synthesizeOpenAiCompat({
      provider: 'openai',
      voice: engineVoice,
      speed,
      format,
      text: t,
      apiUrl,
      model,
      apiKey: String(secrets?.openaiApiKey || '').trim(),
      proxyUrl
    })
    return { ...r, engineVoice }
  }
  if (p === 'local') {
    const r = await synthesizeOpenAiCompat({ provider: 'local', voice: engineVoice, speed, format, text: t, apiUrl, model, apiKey: '', proxyUrl })
    return { ...r, engineVoice }
  }
  if (p === 'doubao') throw new TtsError('tts_provider_pending', 'Doubao 语音合成暂未接入，请改用 edge 或 say')
  throw new TtsError('tts_provider_unknown', `未知语音 Provider：${p}`)
}

// 试听预览落盘：<storageRoot>/_shared/tts_previews/preview_<ts>.<ext>，保留最近 10 份
export async function saveTtsPreview(storageRoot, bytes, ext) {
  const root = String(storageRoot || '').trim()
  if (!root) return null
  const dir = path.join(root, '_shared', 'tts_previews')
  await mkdir(dir, { recursive: true })
  const safeExt = String(ext || 'mp3').replace(/[^a-z0-9]+/gi, '') || 'mp3'
  const name = `preview_${Date.now()}.${safeExt}`
  const file = path.join(dir, name)
  await writeFile(file, bytes)
  try {
    const names = (await readdir(dir)).filter((x) => x.startsWith('preview_')).sort().reverse()
    for (const old of names.slice(10)) {
      await rm(path.join(dir, old), { force: true }).catch(() => {})
    }
  } catch (_) {}
  return { dir, file, name }
}
