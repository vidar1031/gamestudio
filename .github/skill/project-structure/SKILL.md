---
name: project-structure
description: Understand GameStudio structure quickly without broad repo scanning. Use when the task is about where code lives, which module owns a feature, or where to start for editor, control, workflow, or runtime changes.
---

# GameStudio Project Structure

Use this skill to route quickly to the owning module instead of scanning the whole repository.

## Start Here

- Read `README.md` for root scripts and the product-level layout.
- Then read only one of these, based on the task:
  - `docs/使用说明_三层工作流.md` for editor and story-production flow.
  - `docs/CONTROL_SYSTEM.md` for manager, control console, or Hermes control-plane work.
  - `docs/UI_SELF_CONSTRAINTS.md` for frontend visual or layout changes.

## Ownership Map

- `apps/editor/src/App.tsx`: top-level editor app shell.
- `apps/editor/src/studios/`: story-production sub-workspaces such as Script, Blueprint, and Compose.
- `apps/control-console/src/App.vue`: current control-console shell and most control UI state.
- `apps/control-server/src/index.js`: current control-server entry, runtime endpoints, startup profile, and Hermes action handling.
- `apps/server/`: story/project backend.
- `storage/`: project content and output state, not the first place to patch logic bugs.

## Routing Rules

- User says `control UI`, `manager`, `左脑`, `右脑`, `启动`, or `暂停`: start in `apps/control-console/src/App.vue`.
- User says `control API`, `runtime`, `startup profile`, or `Hermes control`: start in `apps/control-server/src/index.js`.
- User says `脚本层`, `蓝图层`, or `合成层`: start in `apps/editor/src/studios/` and use the three-layer workflow doc.
- User says `project start`, `status`, or `stop`: start from root scripts and `README.md`.

## Constraints

- Do not broad-scan once the owner module is identified.
- Do not treat generated `dist/` files as the source of truth.
- Prefer one local read around the owning implementation over repo-wide search.

## Useful Commands

- `./start_project.sh`
- `./status_project.sh`
- `./stop_project.sh`
- `npm run typecheck`
