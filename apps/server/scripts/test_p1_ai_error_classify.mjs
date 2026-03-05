import assert from 'node:assert/strict'
import { classifyAiError } from '../src/ai/runtime.js'

const timeout = new Error('Operation timed out after 90000 milliseconds')
const timeoutRes = classifyAiError(timeout)
assert.equal(timeoutRes.code, 'provider_timeout')
assert.equal(timeoutRes.httpStatus, 502)

const invalidJson = new Error('ollama_invalid_json_output')
const invalidJsonRes = classifyAiError(invalidJson)
assert.equal(invalidJsonRes.code, 'provider_invalid_output')
assert.equal(invalidJsonRes.httpStatus, 502)

const notConfigured = new Error('unsupported_provider:abc')
const notConfiguredRes = classifyAiError(notConfigured)
assert.equal(notConfiguredRes.code, 'user_provider_not_configured')
assert.equal(notConfiguredRes.httpStatus, 501)

console.log('[ok] p1 ai error classify passed')

