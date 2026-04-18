---
applyTo: "apps/editor/src/**,apps/control-console/src/**"
description: "Use when editing GameStudio frontend UI. Keep one visual direction, preserve functional controls, and follow the repository's UI self-constraints instead of ad hoc redesigns."
---

# UI Style Guardrails

Follow [docs/UI_SELF_CONSTRAINTS.md](../docs/UI_SELF_CONSTRAINTS.md). Link to that file instead of restating it in full.

## Visual Rules

- Keep a single dark-base visual language with one clear accent color per screen.
- Avoid style patchwork, decorative redesigns, and large marketing-style gradient cards.
- Limit interactive states to default, hover, and active unless the task explicitly requires more.

## Layout Rules

- Keep the main workspace readable and operational before making it decorative.
- Prefer stable, obvious control placement over clever rearrangements.
- Do not remove existing visible actions to make room for new settings.

## Copy Rules

- Use user-facing language, not internal phase labels or研发术语.
- Show provider/model as `provider / model` when displayed together.
- If a required model or provider is missing, block the action with a clear message instead of failing silently.

## Review Checklist

- No extra nested scrolling or hidden critical actions.
- No control regressions caused by layout changes.
- UI still works at common desktop sizes before claiming the task complete.
