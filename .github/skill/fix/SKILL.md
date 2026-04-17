---
name: fix
description: Fix bugs, errors, broken UI, or data issues across frontend and backend.
---

# Fix Workflow

## Scope
- app_admin/ (Vue frontend)
- app_server/ (Node backend)
- storage/ (data)

## Task
Fix the issue with minimal changes and verify it works.

## Steps
1. Identify the exact failure (UI / API / data / build)
2. Trace only the relevant code path (UI → API → service → storage)
3. Fix at the root cause (not symptoms)
4. Apply minimal safe changes
5. Validate:
   - no new errors
   - correct behavior

## Constraints
- Do not scan entire project
- Do not change unrelated logic
- Prefer smallest possible fix
- Do not run any shell commands

## Output
- Final fix (code or diff)
- Root cause (short)
- What was verified
- Verification steps (commands only, do not execute)