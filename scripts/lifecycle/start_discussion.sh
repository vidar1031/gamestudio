#!/bin/bash
# 启动多代理团队讨论：为 GameStudio 项目打造基础测试方案
set -euo pipefail

PROJECT_DIR="/Volumes/ovokit2t/aiwork/gamestudio"
cd "$PROJECT_DIR"

echo ""
echo "🚀 启动多代理团队讨论"
echo "   主题：为 GameStudio 项目打造基础测试方案"
echo "   预计时长：10-15 分钟"
echo "   各代理输出：memory/discussion/"
echo "   完整记录：memory/$(date +%Y-%m-%d)-discussion.md"
echo ""

# 检查依赖
if [ ! -d "monitor/openclaw/node_modules" ]; then
  echo "❌ 缺少依赖：cd monitor/openclaw && npm install"
  exit 1
fi

# 检查 OpenClaw gateway
if ! curl -sS --max-time 3 http://127.0.0.1:18789 > /dev/null 2>&1; then
  echo "⚠️  警告：OpenClaw gateway 可能未运行 (18789)"
  echo "   如果连接失败请先启动 OpenClaw"
fi

# 创建输出目录
mkdir -p memory/discussion

echo "📋 开始执行..."
node scripts/lifecycle/start_discussion.js

echo ""
echo "✅ 讨论完成！"
echo "   查看报告：cat memory/$(date +%Y-%m-%d)-discussion.md"
echo "   各代理输出：ls memory/discussion/"
