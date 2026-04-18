---
name: fix
description: Fix bugs, regressions, broken UI, control-plane issues, or data problems in GameStudio with minimal, module-scoped changes.
---

# Fix Workflow

## Scope
- `apps/editor/` (React editor)
- `apps/server/` (story backend)
- `apps/control-console/` (Vue control UI)
- `apps/control-server/` (runtime/control backend)
- `storage/` (data and outputs)
- `scripts/` and root lifecycle scripts when the issue is startup/status related

## Task
Fix the issue with minimal changes and verify it works.

## Steps
1. Identify the exact failure (UI / API / data / build)
2. Trace only the relevant code path in the owning module
3. Fix at the root cause (not symptoms)
4. Apply minimal safe changes
5. Validate:
   - no new errors
   - correct behavior

## Constraints
- Do not scan entire project
- Do not change unrelated logic
- Prefer smallest possible fix
- Do not edit generated `dist/` output as the source of truth
- Preserve existing runtime control behavior unless the task explicitly changes that contract
- For `control` changes, adding left/right brain behavior must not remove or weaken start/stop/exit controls
- Prefer the smallest relevant validation command for the touched module

## Output
- Final fix (code or diff)
- Root cause (short)
- What was verified
- Verification steps or commands used