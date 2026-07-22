import {
  isStoryOutputType,
  StoryOutputContractError,
  validateStoryOutput,
} from '@game-studio/schema'

const LOG_PREFIX = '[StoryInputGate]'

/**
 * Build a Hono middleware that validates incoming story payloads.
 *
 * @param {string} type - Story output type expected for this endpoint
 * @param {(c: any) => unknown} payloadExtractor - Extract payload object from context
 * @returns Hono middleware
 */
export function storyInputGate(type, payloadExtractor) {
  return async (c, next) => {
    if (!isStoryOutputType(type)) {
      return c.json({
        success: false,
        error: 'story_input_contract_violation',
        message: `Illegal story input type: '${type}'`,
      }, 400)
    }

    const body = await c.req.json().catch(() => ({}))
    const extracted = payloadExtractor ? await payloadExtractor(c, body) : body
    const payload = extracted && typeof extracted === 'object' ? extracted : {}

    try {
      validateStoryOutput(type, payload)
    } catch (error) {
      if (error instanceof StoryOutputContractError) {
        return c.json({
          success: false,
          error: 'story_input_contract_violation',
          message: `${LOG_PREFIX} Input rejected for ${type}`,
          issues: error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path.map((p) => String(p)).join('.'),
          })),
        }, 400)
      }
      return c.json({
        success: false,
        error: 'story_input_contract_violation',
        message: String(error instanceof Error ? error.message : error),
      }, 400)
    }

    await next()
  }
}
