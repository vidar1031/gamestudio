---
name: ui-style
description: Apply GameStudio UI style guardrails when changing editor or control-console frontend code. Use when the task involves layout, component styling, visual cleanup, panel redesign, modal changes, or preventing UI regressions.
---

# GameStudio UI Style

Use this skill when changing frontend appearance or layout in `apps/editor` or `apps/control-console`.

## Source of Truth

- Read `docs/UI_SELF_CONSTRAINTS.md` first.
- If the task is in the control plane, also check `docs/CONTROL_SYSTEM.md` so visual changes do not break control semantics.

## Rules

- Keep one consistent dark-base visual direction.
- Use one clear accent per screen instead of mixing multiple visual systems.
- Prefer clarity and control visibility over decorative redesign.
- Do not hide or demote important runtime actions to make room for new UI.
- Avoid introducing internal project terms into user-facing copy.

## Layout Priorities

- Preserve obvious action placement.
- Avoid extra nested scroll containers.
- Keep settings and diagnostics in-place when possible instead of scattering them across new tabs or detached flows.

## Non-Regression Check

- New UI must not remove existing visible controls.
- Control Console changes must keep start/stop behavior easy to find.
- Before finishing, scan for overflow, clipped buttons, and mixed visual language.
