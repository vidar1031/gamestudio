# GameStudio Workspace Skill

Use this skill when HermesManager starts a GameStudio workspace session.

## Purpose

Provide the minimum stable context needed to work on GameStudio without scanning the whole repository.

## Required Reads

1. README.md
2. docs/CONTROL_SYSTEM.md for control-plane work
3. docs/DESIGN_WORKFLOW_3_LAYERS.md for editor and workflow work
4. ai/USER.md
5. ai/MEMORY.md

## Routing Rules

- If the task names control, stay inside apps/control-console and apps/control-server.
- If the task names editor, stay inside apps/editor.
- If the task names server, stay inside apps/server.
- Do not scan unrelated modules to build confidence.

## Startup Expectations

- Use the configured model route from HermesManager.
- Treat ai/USER.md and ai/MEMORY.md as long-term memory inputs.
- Treat ai/memory/*.md as project state inputs when explicitly needed.
- Right-brain execution is disabled until manager-side support is enabled.

## Review Workflow

- Reasoning sessions are review-gated. Stop at each `waiting_review` checkpoint and wait for explicit human approval before continuing.
- When a review is rejected, treat the correction prompt as authoritative and regenerate only the rejected target.
- During review, surface both the outbound request preview and the first returned model result so the user can verify what was sent and received.

## Observable Rules

- For story or scripts questions, do not speculate about databases or APIs before observable workspace tools run.
- For questions about created stories, use workspace-local evidence from `projects/*/scripts.json` before any final answer.
- Prefer deterministic observable results over generic model assumptions.
