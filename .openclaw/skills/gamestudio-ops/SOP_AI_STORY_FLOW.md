# game_studio AI Story SOP v1

This SOP is the default execution contract for the "AI create story" workflow in game_studio.

## Scope

- From opening "AI create story" to obtaining a valid script draft.
- Includes structure and safety validation.
- Ends when the project is ready to enter script editing / downstream compile flow.

## Task Input Contract

Every run should include these fields:

- goal: child-friendly interactive story draft
- title: story title string
- structure:
  - choicePoints
  - optionsPerChoice
  - endings
  - formula: random or explicit
- theme: values and core message
- style: tone and visual style keywords
- restrictions: disallowed content (for example, violence/gore)
- retryPolicy: max retries per step (default 2)

## Operational Steps

1. Open AI create story dialog
- Precondition: game_studio workspace is loaded and interactive.
- Action: trigger AI create story panel.
- Pass: dialog is visible with title, structure, prompt fields.
- Fail handling: refresh once and retry.

2. Fill base parameters
- Precondition: dialog is open.
- Action: set title and structure values.
- Pass: UI reflects exact requested values.
- Fail handling: clear and re-fill once.

3. Generate prompt text
- Precondition: base parameters are set.
- Action: click one-click prompt generation.
- Pass: prompt area contains complete template sections.
- Fail handling: retry once; if still empty, fill minimal manual prompt.

4. Trigger AI generation
- Precondition: prompt text is non-empty.
- Action: click generate.
- Pass: generated script draft is returned.
- Fail handling: retry according to retryPolicy; then report minimal handoff point.
  - If failure looks like remote connection refused (e.g. `ai_generate_failed` + `ECONNREFUSED`):
    - Run: `POST /api/ai/diagnose`
    - Wait 5~15 seconds and retry once
    - If still failing, optionally restart local service: `./restart_project.sh` and re-check `GET /api/health`
  - If failure includes JSON parse errors like `Expected ',' or '}' after property value ...`:
    - Treat it as invalid JSON in the request body
    - Validate the JSON payload with `python3 -m json.tool` before retrying

5. Validate structure
- Precondition: draft exists.
- Action: verify choicePoints/optionsPerChoice/endings match input.
- Pass: structure matches exactly.
- Fail handling: regenerate once; if still invalid, mark as structure-fail.

Notes for agents (post-fix):
- For AI-generated `scripts.json`, the backend already normalizes consequence card names into `i后果k` before blueprint compilation.
- Therefore, if blueprint warnings about missing/mismatched consequences still appear, treat it as a true missing/insufficient consequence-card slot rather than just naming drift.

6. Validate content safety and intent
- Precondition: structure passes.
- Action: check tone, age suitability, restriction compliance, theme alignment.
- Pass: all constraints pass.
- Fail handling: refine prompt and regenerate once.

7. Prepare handoff to next stage
- Precondition: structure and content pass.
- Action: move to script stage (or API stage 2 compile/blueprint flow).
- Pass: project is ready for downstream creation.
- Fail handling: provide current draft and exact resume step.

## Output Contract (must be returned each run)

- result: success or failed
- paramsEcho: title + structure + model + duration
- stepStatus: step1..step7 pass/fail
- retryTrace: retries by step
- failurePoint: exact blocked step (if any)
- minimalHandoff: smallest manual takeover action
- nextAction: enter script / regenerate / adjust prompt

## Progress Scoring

- 40: flow completeness (all steps executed)
- 30: structure correctness
- 20: safety and quality compliance
- 10: failure handling quality

Interpretation:

- 85-100: stable
- 70-84: usable with supervision
- <70: still workflow-blind

## Preferred API Mapping (for agent automation)

When UI interaction is unavailable or unstable, use API chain:

1. POST /api/projects/ai/create
2. POST /api/projects/{projectId}/compile/blueprint
3. POST /api/projects/{projectId}/compile/compose
4. POST /api/projects/{projectId}/export

Validation gates:

- create: scripts.cards is non-empty
- blueprint: validation.ok is true and report.errors is empty
- compose: startNodeId and nodes exist
- export: buildId and distUrl exist
