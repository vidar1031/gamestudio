export function createContextService(deps) {
  return {
    buildChatContextSourcesPayload: deps.buildChatContextSourcesPayload,
    buildHermesBinding: deps.buildHermesBinding,
    buildHermesChatMessages: deps.buildHermesChatMessages,
    buildManualContextSourceCandidates: deps.buildManualContextSourceCandidates,
    buildReasoningPlannerMessages: deps.buildReasoningPlannerMessages,
    buildStructuredOutboundPreview: deps.buildStructuredOutboundPreview,
    createOpaqueId: deps.createOpaqueId,
    fs: deps.fs,
    generateContextDraft: deps.generateContextDraft,
    getContextPoolEntryFilePath: deps.getContextPoolEntryFilePath,
    getSelectableContextSourceById: deps.getSelectableContextSourceById,
    hermesAgentDefinition: deps.hermesAgentDefinition,
    listContextPoolEntries: deps.listContextPoolEntries,
    openFileInEditor: deps.openFileInEditor,
    readContextPoolEntry: deps.readContextPoolEntry,
    readHermesChatHistory: deps.readHermesChatHistory,
    readUtf8FileRecord: deps.readUtf8FileRecord,
    writeContextPoolEntry: deps.writeContextPoolEntry,
    writeUtf8FileRecord: deps.writeUtf8FileRecord,
  }
}