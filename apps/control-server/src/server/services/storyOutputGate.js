import {
  isStoryOutputType,
  StoryOutputContractError,
  validateStoryOutput,
} from '@game-studio/schema'

/**
 * Output Gate for Control -> GameStudio story messages.
 *
 * Every outbound story payload must pass this gate before being sent to
 * GameStudio Server. Illegal payloads are rejected with a contract error
 * instead of being silently accepted or normalized away.
 */

const LOG_PREFIX = '[StoryOutputGate]'

/**
 * Validate a Control -> GameStudio story output payload.
 *
 * @param {string} type - Story output type, e.g. 'story.scripts.write'
 * @param {unknown} payload - Raw payload object
 * @returns {{ ok: true, data: any }} on success
 * @returns {{ ok: false, type: string, issues: Array<{message: string, path: string}> }} on failure
 */
export function gateStoryOutput(type, payload) {
  if (!isStoryOutputType(type)) {
    return {
      ok: false,
      type,
      issues: [{ message: `Illegal story output type: '${type}'. Allowed types are story.* only.`, path: 'type' }],
    }
  }

  try {
    const data = validateStoryOutput(type, payload)
    return { ok: true, data }
  } catch (error) {
    if (error instanceof StoryOutputContractError) {
      return {
        ok: false,
        type: error.type,
        issues: error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path.map((p) => String(p)).join('.'),
        })),
      }
    }
    return {
      ok: false,
      type,
      issues: [{ message: error instanceof Error ? error.message : String(error), path: '' }],
    }
  }
}

/**
 * Assert gate passes or throw. Use when the caller wants an exception.
 */
export function assertStoryOutput(type, payload) {
  const result = gateStoryOutput(type, payload)
  if (!result.ok) {
    const detail = result.issues.map((i) => `${i.path}: ${i.message}`).join('; ')
    throw new Error(`${LOG_PREFIX} Output contract violation (${type}): ${detail}`)
  }
  return result.data
}

/**
 * Wrap an async GameStudio client call with the output gate.
 */
export function withStoryOutputGate(type, payload, executor) {
  const result = gateStoryOutput(type, payload)
  if (!result.ok) {
    return Promise.reject(new Error(
      `${LOG_PREFIX} Blocked outbound ${type}: ` +
      result.issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')
    ))
  }
  return executor(result.data)
}
