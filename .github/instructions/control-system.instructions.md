---
applyTo: "apps/control-console/**,apps/control-server/**"
description: "Use when editing GameStudio control-system files. Protect runtime controls, keep UI/API contracts aligned, and avoid breaking start-stop behavior while adding manager or left-right brain features."
---

# Control System Guardrails

Read [docs/CONTROL_SYSTEM.md](../docs/CONTROL_SYSTEM.md) before making structural changes to the control plane.

## Scope

- `apps/control-console/src/App.vue` is the current top-level control UI.
- `apps/control-server/src/index.js` is the current backend entry for control APIs and Hermes runtime actions.

## Required Behavior

- Preserve engine lifecycle controls. Start, stop, exit, and visible runtime state are required product behavior.
- Left-brain and right-brain configuration is additive. It must not replace, remove, or silently weaken lifecycle control behavior.
- Do not simplify multi-brain behavior into a singleton control model unless the task explicitly requests that tradeoff.
- If you change action payloads or runtime state fields on the server, update the console in the same change.
- If you change control labels or button placement in the console, verify that the corresponding backend action path still exists and still means the same thing.

## Safe Workflow

- Start from the exact control surface mentioned by the user.
- Read only the nearby action handler, computed state, and matching API endpoint.
- Avoid unrelated cleanup in the same patch.
- Never edit `dist/` as the source of truth.

## Minimum Validation

- `npm --workspace @game-studio/control-console run typecheck`
- If you changed backend control logic, also run a narrow syntax or behavior check for `apps/control-server/src/index.js`.
