#!/bin/bash
set -e

echo "=== 构建 schema 包 ==="
cd /Users/zhanghongqin/work/game_studio
npm --workspace @game-studio/schema run build

echo "=== 构建 builder 包 ==="
npm --workspace @game-studio/builder run build

echo "=== 构建 runtime-pixi 包 ==="
npm --workspace @game-studio/runtime-pixi run build

echo "=== 所有包构建完成 ==="