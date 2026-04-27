import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HERMES_ROOT = '/Volumes/ovokit2t/AIOVO/hermes-agent'
export const DEFAULT_HERMES_HOME = path.join(path.dirname(HERMES_ROOT), 'home', '.hermes')
export const USER_HERMES_HOME = path.join(os.homedir(), '.hermes')
export const HERMES_HOME = fs.existsSync(DEFAULT_HERMES_HOME)
  ? DEFAULT_HERMES_HOME
  : (process.env.HERMES_HOME || USER_HERMES_HOME)
export const GAMESTUDIO_ROOT = '/Volumes/ovokit2t/aiwork/gamestudio'
export const HERMES_CONFIG_ROOT = path.join(GAMESTUDIO_ROOT, 'config', 'hermes')
export const CONTROL_RESTART_SCRIPT = path.join(GAMESTUDIO_ROOT, 'restart_control.sh')
export const HERMES_GATEWAY_SCRIPT = path.join(HERMES_ROOT, 'scripts', 'hermes-gateway')
export const HERMES_VENV_PYTHON = path.join(HERMES_ROOT, 'venv', 'bin', 'python')
export const HERMES_RUNTIME_CONFIG_FILES = [...new Set([
  HERMES_HOME,
  process.env.HERMES_HOME || '',
  DEFAULT_HERMES_HOME,
  USER_HERMES_HOME,
].filter(Boolean).map((homePath) => path.join(homePath, 'config.yaml')))]
export const HERMES_RUNTIME_PID_FILE = path.join(os.tmpdir(), 'gamestudio-hermes-gateway.pid')
export const HERMES_RUNTIME_LOG_FILE = path.join(os.tmpdir(), 'gamestudio-hermes-gateway.log')
export const HERMES_CONTROL_CONFIG_FILE = path.join(HERMES_CONFIG_ROOT, 'manager.left-brain.json')
export const HERMES_CONTROL_STATE_FILE = path.join(HERMES_CONFIG_ROOT, 'manager.left-brain.state.json')
export const LEGACY_HERMES_CONTROL_CONFIG_FILE = path.join(HERMES_ROOT, '.hermes_control_config.json')
export const GAMESTUDIO_ENV_FILE = path.join(GAMESTUDIO_ROOT, '.env')
export const DEFAULT_HERMES_SKILL_FILE = path.join(HERMES_CONFIG_ROOT, 'skills', 'gamestudio-workspace', 'SKILL.md')
export const HERMES_REASONING_SESSIONS_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-sessions')
export const HERMES_REASONING_REVIEW_RECORDS_FILE = path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-review-records.jsonl')
export const HERMES_AGENT_RUNTIME_SESSIONS_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'agent-runtime-sessions')
export const HERMES_AGENT_RUNTIME_EVENTS_FILE = path.join(GAMESTUDIO_ROOT, 'state', 'agent-runtime-events.jsonl')
export const HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE = path.join(GAMESTUDIO_ROOT, 'state', 'agent-runtime-review-records.jsonl')
export const HERMES_CONTEXT_POOL_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'context-pool')
export const DEFAULT_STUDIO_STORAGE_ROOT = path.join(GAMESTUDIO_ROOT, 'storage')
export const ENV_STUDIO_STORAGE_ROOT = String(process.env.STUDIO_STORAGE_ROOT || '').trim()
export const STUDIO_STORAGE_ROOT = ENV_STUDIO_STORAGE_ROOT
  ? (path.isAbsolute(ENV_STUDIO_STORAGE_ROOT) ? ENV_STUDIO_STORAGE_ROOT : path.resolve(process.cwd(), ENV_STUDIO_STORAGE_ROOT))
  : DEFAULT_STUDIO_STORAGE_ROOT
export const STORAGE_PROJECTS_ROOT = path.join(STUDIO_STORAGE_ROOT, 'projects')
export const LEGACY_PROJECTS_ROOT = path.join(GAMESTUDIO_ROOT, 'projects')