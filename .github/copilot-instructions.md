# GameStudio Copilot Instructions

Use these instructions for GitHub Copilot work in this repository. They are separate from the runtime-facing `AGENTS.md` files used by internal services.

## Primary Goal

- Get to the owning module quickly.
- Read the minimum local context needed to make one concrete change.
- Work only in the module the user asked for.
- Do not drift into unrelated cleanup, rewrites, or broad scans.

## Fast Routing

- Start from the user's named surface first: file, app, page, command, API, or failing behavior.
- If the user names `control`, start with `apps/control-console/src/App.vue` for UI and `apps/control-server/src/index.js` for runtime/API behavior.
- If the user names the editor, start with `apps/editor/src/App.tsx` or the matching file under `apps/editor/src/studios/`.
- If the user names project structure or workflow, read `README.md` first, then only the single relevant doc below.

## High-Signal Docs

- Project workflow: [README.md](../README.md)
- Three-layer story workflow: [docs/使用说明_三层工作流.md](../docs/%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E_%E4%B8%89%E5%B1%82%E5%B7%A5%E4%BD%9C%E6%B5%81.md)
- Control system intent and boundaries: [docs/CONTROL_SYSTEM.md](../docs/CONTROL_SYSTEM.md)
- Frontend style guardrails: [docs/UI_SELF_CONSTRAINTS.md](../docs/UI_SELF_CONSTRAINTS.md)

Link to these docs when they already cover the rule. Do not duplicate large blocks of project documentation inside responses or patches.

## Module Map

- `apps/editor`: main H5 interactive-story editor, Vite + React + TypeScript.
- `apps/control-console`: control-plane UI, Vite + Vue.
- `apps/control-server`: control-plane backend and Hermes runtime control endpoints.
- `apps/server`: story/project backend.
- `storage/`: project data and demo outputs. Treat as content/state, not primary implementation.
- `memory/`: planning and status files. Update only when the task explicitly requires project-state writeback.

## Editing Rules

- Prefer the smallest local fix or feature slice that satisfies the request.
- Do not re-scan the whole repository once the owning file or module is clear.
- Do not edit generated output such as `dist/` unless the user explicitly asks for generated artifacts.
- Do not rename, remove, or repurpose stable controls just because a new feature needs space.
- Keep existing startup, stop, pause, resume, and exit behavior intact unless the user explicitly asks to change that contract.
- When a task touches both UI and API contract, update both sides in one focused change.

## Control-Specific Non-Regression Rule

- `apps/control-console` and `apps/control-server` together define runtime control behavior.
- Adding left-brain / right-brain features must not delete or hide engine lifecycle controls.
- Treat runtime action controls as protected UI. New brain configuration panels are additive, not replacements for start/stop behavior.
- Before changing runtime control behavior, inspect both the button labels/state logic in `apps/control-console/src/App.vue` and the action handling in `apps/control-server/src/index.js`.

## Validation

- Root quick check: `npm run typecheck`
- Control Console only: `npm --workspace @game-studio/control-console run typecheck`
- Editor only: `npm --workspace @game-studio/editor run typecheck`
- Use the smallest relevant validation command for the touched module.
