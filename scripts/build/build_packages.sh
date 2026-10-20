#!/bin/bash
set -e

echo "=== 构建 schema 包 ==="
cd .
npm --workspace @talkscene/schema run build

echo "=== 构建 builder 包 ==="
npm --workspace @talkscene/builder run build

echo "=== 构建 runtime-pixi 包 ==="
npm --workspace @talkscene/runtime-pixi run build

echo "=== 所有包构建完成 ==="