#!/bin/bash
set -e
cd .

echo "=== 构建 packages ==="
npm run build:packages

echo "=== 构建完成 ==="