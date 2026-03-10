# ComfyUI Hard Config For Continuous Storyboard

This project now supports a hard configuration path for local ComfyUI to generate continuous story scenes.

## Target Style

- Style: `picture_book`
- Visual direction: children cartoon illustration, non-photorealistic
- Continuity: stable character identity, stable outfit colors, stable key props

## Required Runtime Settings

In Studio Settings -> Image:

- Provider: `comfyui`
- Base URL: `http://127.0.0.1:8188`
- Model: choose an SDXL checkpoint
- LoRA: optional, but recommended for style locking

In AI Storyboard Batch:

- Steps: `24`
- CFG: `6.0`
- Sampler: `DPM++ 2M`
- Scheduler: `Karras`

## Required ComfyUI Capability

The ComfyUI runtime must expose:

- `CheckpointLoaderSimple`
- `CLIPTextEncode`
- `KSampler`
- `VAEDecode`
- `SaveImage`
- `LoraLoader` (needed when LoRAs are configured)

## Hard Validation (must pass before test render)

The app now runs a strict preflight for ComfyUI test render:

- Endpoint: `POST /api/studio/image/preflight`
- Checks:
  - ComfyUI reachable (`/system_stats`)
  - required nodes exist
  - configured model exists in ComfyUI checkpoints
  - configured LoRAs exist in ComfyUI LoRA list

If preflight fails, test render is blocked.

## Hard Continuity Anchors

During batch scene apply (ComfyUI provider), the app injects continuity anchors:

- `WORLD_ANCHOR: same story world, same era and geography, stable art direction`
- `CONTINUITY_RULES: keep character identity, outfit palette and key props consistent across scenes; no random replacements`
- `ROLE_DEFINITION: ...` (assembled from placed characters and their fingerprint prompts)

These anchors are merged with your global prompt and scene prompt automatically.

## Practical Model/LoRA Selection Rule

Use "Refresh models" first, then click "one-click hard config".

Model selection priority keywords:

- `illustrious`
- `dreamshaper`
- `juggernaut`
- `realvisxl`
- `sd_xl_base_1.0`
- `xl`

LoRA selection priority keywords:

- `storybook`
- `picture`
- `watercolor`
- `cartoon`
- `children`
- `illustration`

If no LoRA matches are found, keep LoRA empty first, validate pipeline with a test image, then add LoRA manually.
