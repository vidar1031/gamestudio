#!/bin/bash
# GameStudio Reporter Agent - 启动后自动汇报
# 此脚本由 OpenClaw 启动后自动调用

set -euo pipefail

PROJECT_DIR="/Volumes/ovokit2t/aiwork/gamestudio"
cd "$PROJECT_DIR"

echo "📊 GameStudio 项目状态汇报"
echo "========================="
echo ""

# 1. 检查服务状态
echo "✅ 服务状态"
if bash scripts/lifecycle/status_project.sh > /tmp/reporter_status.txt 2>&1; then
    echo "- Server (:1999): 运行中"
else
    echo "- Server (:1999): 停止"
fi

if curl -sS --max-time 3 http://127.0.0.1:1999/api/health > /dev/null 2>&1; then
    echo "- Health API: 正常"
else
    echo "- Health API: 异常"
fi

if curl -sS --max-time 3 http://localhost:8868 > /dev/null 2>&1; then
    echo "- Editor (:8868): 可访问"
else
    echo "- Editor (:8868): 不可访问"
fi
echo ""

# 2. 读取当前目标
echo "📋 当前目标"
if [ -f "memory/STATUS.md" ]; then
    grep -A 2 "当前目标" memory/STATUS.md | head -3 | sed 's/^- //'
else
    echo "状态文件不存在"
fi
echo ""

# 3. 读取待办任务
echo "📝 待办任务（前 3 个）"
if [ -f "memory/TASK_QUEUE.md" ]; then
    grep -E "^- \[ \]|^- \[x\]" memory/TASK_QUEUE.md | head -3 | sed 's/^- //'
else
    echo "任务队列文件不存在"
fi
echo ""

# 4. 读取阻塞项
echo "🚧 阻塞项"
if [ -f "memory/STATUS.md" ]; then
    grep -A 2 "阻塞项" memory/STATUS.md | head -3 | sed 's/^- //'
else
    echo "无阻塞项信息"
fi
echo ""

# 5. 读取今日进展
echo "📈 今日进展"
TODAY=$(date +%Y-%m-%d)
if [ -f "memory/${TODAY}.md" ]; then
    tail -10 "memory/${TODAY}.md"
else
    echo "今日暂无日志"
fi
echo ""

# 6. 建议下一步
echo "🎯 建议下一步"
if [ ! -f "memory/TASK_QUEUE.md" ]; then
    echo "请检查任务队列文件"
elif grep -q "^\- \[ \]" memory/TASK_QUEUE.md; then
    echo "有待办任务需要处理"
    grep "^\- \[ \]" memory/TASK_QUEUE.md | head -1 | sed 's/^- //'
else
    echo "所有任务已完成，请检查是否需要新任务"
fi
echo ""
echo "========================="
echo "汇报完成 ✅"
