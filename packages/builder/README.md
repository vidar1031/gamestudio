# @talkscene/builder（P0）

P0 仅提供“插件接口 + 产物协议”的约定，实际构建由 server 调用插件实现。

## 插件接口

见 `src/plugin.ts`：
- `BuilderPlugin.build(ctx)`：将 `projectDir` 构建到 `outDir`（dist）

## 产物协议（P0）

dist 必须包含：
- `index.html`
- `story.json`
- `game.manifest.json`
- `assets/`（可为空）

`game.manifest.json`（V1）字段见 `ArtifactManifestV1`。

