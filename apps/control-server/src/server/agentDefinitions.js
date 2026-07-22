export const hermesAgentDefinition = {
  id: 'hermes-manager',
  name: 'Hermes Manager',
  runtime: 'hermes',
  role: 'project-controller',
  description: 'Primary control-plane agent used by the manager system to read state, execute allowed actions, and write results back.',
  capabilities: [
    'read_control_state',
    'query_runtime_health',
    'execute_allowed_action',
    'write_action_result',
    'report_diagnostics',
    'manage_context_memory',
    'execute_gamestudio_bootstrap',
    'execute_story_workflow',
    'observe_gamestudio_operations',
    'run_review_gated_workspace_changes',
    'support_production_test_evidence'
  ]
}

