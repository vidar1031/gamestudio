import { z } from 'zod'

// ===== Base types for Control -> GameStudio story outputs =====

export const StoryOutputType = z.enum([
  'story.project.create',
  'story.scripts.write',
  'story.blueprint.compile',
  'story.compose.compile',
  'story.validate.blueprint',
  'story.bible.generate',
  'story.assets.plan',
  'story.assets.reference.lock',
  'story.scene.render',
  'story.background.generate',
  'story.export.project',
])

export type StoryOutputType = z.infer<typeof StoryOutputType>

// Allowed story-related text characters: no code blocks, no system commands.
// We keep it permissive enough for CJK story text but reject markdown fences and XML-like tags.
const storyTextRegex = /^[^`<>\{\}\[\]]*$/s

export const ScriptCardV1Schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  order: z.number().int().min(1),
  text: z.string().min(1).regex(storyTextRegex, 'story text contains illegal characters (code blocks, tags, brackets)'),
  updatedAt: z.string().datetime(),
})

export const ScriptDocV1Schema = z.object({
  schemaVersion: z.literal('1.0'),
  cards: z.array(ScriptCardV1Schema).min(1),
  updatedAt: z.string().datetime(),
})

export const BlueprintChoiceV1Schema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).regex(storyTextRegex, 'choice text contains illegal characters'),
  toNodeId: z.string().min(1),
})

export const BlueprintNodeV1Schema = z.object({
  id: z.string().min(1),
  scriptCardId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['scene', 'ending']),
  textDraft: z.string().optional(),
  backgroundId: z.string().optional(),
  actorIds: z.array(z.string()).default([]),
  eventIds: z.array(z.string()).default([]),
  choices: z.array(BlueprintChoiceV1Schema).default([]),
})

export const BlueprintDocV1Schema = z.object({
  schemaVersion: z.literal('1.0'),
  startNodeId: z.string().min(1),
  placeholders: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(['actor', 'background', 'event']),
    name: z.string().min(1),
    tags: z.array(z.string()).optional(),
  })).default([]),
  nodes: z.array(BlueprintNodeV1Schema).min(1),
  updatedAt: z.string().datetime(),
})

// ===== Output payload schemas per action type =====

export const StoryProjectCreatePayloadSchema = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(2000).optional(),
  choicePoints: z.number().int().min(1).max(20).optional(),
  optionsPerChoice: z.number().int().min(2).max(10).optional(),
  endings: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
}).strict()

export const StoryScriptsWritePayloadSchema = z.object({
  projectId: z.string().min(1),
  scripts: ScriptDocV1Schema,
}).strict()

export const StoryBlueprintCompilePayloadSchema = z.object({
  projectId: z.string().min(1),
}).strict()

export const StoryComposeCompilePayloadSchema = z.object({
  projectId: z.string().min(1),
}).strict()

export const StoryValidateBlueprintPayloadSchema = z.object({
  projectId: z.string().min(1),
}).strict()

export const StoryBibleGeneratePayloadSchema = z.object({
  projectId: z.string().min(1),
  input: z.object({
    title: z.string().min(1).optional(),
    brief: z.string().optional(),
    scenes: z.array(z.any()).optional(),
    scripts: z.array(z.any()).optional(),
    characters: z.array(z.any()).optional(),
    props: z.array(z.any()).optional(),
    locations: z.array(z.any()).optional(),
    // Control 侧衍生的候选提示（服务端 storyBible.js 实际消费，仅作候选不作真相源）
    candidateWorldHints: z.object({
      worldAnchor: z.string().optional(),
      forbiddenSubstitutes: z.array(z.string()).optional(),
      eventChain: z.array(z.string()).optional(),
    }).passthrough().optional(),
    candidateEntities: z.object({
      characters: z.array(z.any()).optional(),
      props: z.array(z.any()).optional(),
      locations: z.array(z.any()).optional(),
    }).passthrough().optional(),
    scenePresenceRules: z.array(z.string()).optional(),
    source: z.string().optional(),
  }).strict(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
})

export const StoryAssetsPlanPayloadSchema = z.object({
  projectId: z.string().min(1),
  rebuild: z.boolean().optional(),
  source: z.enum(['control_production_delivery']).optional(),
})

export const StoryAssetsReferenceLockPayloadSchema = z.object({
  projectId: z.string().min(1),
  assetId: z.string().min(1),
  assetPath: z.string().min(1),
})

export const StorySceneRenderPayloadSchema = z.object({
  projectId: z.string().min(1),
  sceneId: z.string().min(1),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  style: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
})

export const StoryBackgroundGeneratePayloadSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(2000).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  referenceImageUrls: z.array(z.string().url()).optional(),
  characterRefs: z.array(z.any()).optional(),
  assetRefs: z.array(z.any()).optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
})

export const StoryExportProjectPayloadSchema = z.object({
  projectId: z.string().min(1),
}).strict()

// ===== Dispatch map =====

export const StoryOutputPayloadSchemas = {
  'story.project.create': StoryProjectCreatePayloadSchema,
  'story.scripts.write': StoryScriptsWritePayloadSchema,
  'story.blueprint.compile': StoryBlueprintCompilePayloadSchema,
  'story.compose.compile': StoryComposeCompilePayloadSchema,
  'story.validate.blueprint': StoryValidateBlueprintPayloadSchema,
  'story.bible.generate': StoryBibleGeneratePayloadSchema,
  'story.assets.plan': StoryAssetsPlanPayloadSchema,
  'story.assets.reference.lock': StoryAssetsReferenceLockPayloadSchema,
  'story.scene.render': StorySceneRenderPayloadSchema,
  'story.background.generate': StoryBackgroundGeneratePayloadSchema,
  'story.export.project': StoryExportProjectPayloadSchema,
} as const

export type StoryOutputPayloadMap = {
  [K in keyof typeof StoryOutputPayloadSchemas]: z.infer<typeof StoryOutputPayloadSchemas[K]>
}

// ===== Envelope schema for any Control -> GameStudio story message =====

export const StoryOutputEnvelopeSchema = z.object({
  type: StoryOutputType,
  payload: z.record(z.string(), z.any()),
}).strict()

export type StoryOutputEnvelope = z.infer<typeof StoryOutputEnvelopeSchema>

// ===== Validation helpers =====

export class StoryOutputContractError extends Error {
  public readonly type: string
  public readonly issues: z.ZodIssue[]
  constructor(type: string, issues: z.ZodIssue[]) {
    super(`Story output contract violation for type '${type}': ${issues.map((i) => i.message).join('; ')}`)
    this.type = type
    this.issues = issues
  }
}

export function validateStoryOutput<T extends StoryOutputType>(
  type: T,
  payload: unknown
): StoryOutputPayloadMap[T] {
  const schema = StoryOutputPayloadSchemas[type]
  if (!schema) {
    throw new StoryOutputContractError(type, [{ message: `Unknown story output type: ${type}`, path: ['type'], code: z.ZodIssueCode.custom } as z.ZodIssue])
  }
  const result = schema.safeParse(payload)
  if (!result.success) {
    throw new StoryOutputContractError(type, result.error.issues)
  }
  return result.data as StoryOutputPayloadMap[T]
}

export function isStoryOutputType(value: string): value is StoryOutputType {
  return StoryOutputType.safeParse(value).success
}
