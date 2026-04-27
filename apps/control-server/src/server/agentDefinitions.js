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
    'report_diagnostics'
  ]
}

export const openclawAgentDefinition = {
  id: 'openclaw-manager',
  name: 'OpenClaw Manager',
  runtime: 'openclaw',
  role: 'project-controller',
  description: 'Reserved control-plane agent entry for OpenClaw. It is selectable in the manager, but its execution workflow is not enabled yet.',
  capabilities: [
    'read_control_state',
    'report_runtime_presence'
  ]
}