// AUTO-D02：日志/错误响应脱敏工具。
// 目标：任何写入日志、审计记录或返回给 Console 的文本，都不得夹带 secret 字面量
// （API key、Bearer token、Authorization 头值、敏感 env 值）。

// 已知敏感 env 键：其值（长度 >= 6）若出现在文本中必须打码
const SENSITIVE_ENV_KEYS = [
  'CONTROL_API_TOKEN',
  'OPENAI_API_KEY',
  'MOONSHOT_API_KEY',
  'STUDIO_AI_API_KEY',
  'LOCALOXML_API_KEY',
  'DOUBAO_ARK_API_KEY',
  'DOUBAO_ARK_AUTH_HEADER'
]

// 通用 secret 模式：Bearer 头、sk- 前缀 key、key=value / key: value 形式的敏感字段
const SECRET_PATTERNS = [
  { regex: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: 'Bearer ***' },
  { regex: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}/g, replacement: 'sk-***' },
  {
    regex: /((?:api[-_]?key|access[-_]?token|auth[-_]?token|authorization|secret|password)["'\s]*[:=]["'\s]*)(?!Bearer\b)([^\s,"'}{]{4,})/gi,
    replacement: '$1***'
  }
]

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectEnvSecrets() {
  const secrets = []
  for (const key of SENSITIVE_ENV_KEYS) {
    const value = String(process.env[key] || '').trim()
    // 只对足够长的值打码，避免短占位值（如 'true'）误伤正常文本
    if (value.length >= 6) {
      secrets.push(value)
    }
  }
  return secrets
}

/**
 * 对文本做 secret 脱敏。
 * @param {*} input - 任意输入；非字符串先 JSON 序列化（失败则 String()）
 * @returns {string} 脱敏后的字符串
 */
export function redactSecrets(input) {
  let text
  if (typeof input === 'string') {
    text = input
  } else {
    try {
      text = JSON.stringify(input)
    } catch {
      text = String(input)
    }
  }
  if (!text) return ''

  let redacted = text
  for (const { regex, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(regex, replacement)
  }
  for (const secret of collectEnvSecrets()) {
    redacted = redacted.replace(new RegExp(escapeRegex(secret), 'g'), '***')
  }
  return redacted
}
