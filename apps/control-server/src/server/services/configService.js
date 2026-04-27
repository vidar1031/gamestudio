export function createConfigService(deps) {
  return {
    appendHermesLog: deps.appendHermesLog,
    buildConfigValidation: deps.buildConfigValidation,
    buildHermesBinding: deps.buildHermesBinding,
    buildHermesBindingFromConfig: deps.buildHermesBindingFromConfig,
    buildHermesPreflight: deps.buildHermesPreflight,
    buildModelStateSnapshot: deps.buildModelStateSnapshot,
    buildAgentRuntimeBehaviorChecks: deps.buildAgentRuntimeBehaviorChecks,
    buildAgentRuntimeDescriptor: deps.buildAgentRuntimeDescriptor,
    buildReasoningActionCatalog: deps.buildReasoningActionCatalog,
    buildReasoningToolCatalog: deps.buildReasoningToolCatalog,
    buildReasoningCapabilityGuide: deps.buildReasoningCapabilityGuide,
    getHermesControlConfigFingerprint: deps.getHermesControlConfigFingerprint,
    getPersistedHermesControlConfig: deps.getPersistedHermesControlConfig,
    hermesAgentDefinition: deps.hermesAgentDefinition,
    mergeHermesControlConfig: deps.mergeHermesControlConfig,
    path: deps.path,
    refreshHermesControlStateFromConfig: deps.refreshHermesControlStateFromConfig,
    setHermesControlConfig: deps.setHermesControlConfig,
    updateHermesControlState: deps.updateHermesControlState,
  }
}