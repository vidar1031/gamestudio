#!/bin/bash
# GameStudio 定时汇报脚本
# 在 macOS 上优先使用 Mail App 发送（可在“已发送”中查看记录）

set -euo pipefail

# 项目根目录
PROJECT_DIR="/Volumes/ovokit2t/aiwork/gamestudio"
AI_MEMORY_DIR="$PROJECT_DIR/ai/memory"
cd "$PROJECT_DIR"

# 加载邮件配置
source "$PROJECT_DIR/.openclaw/email_config.sh"

if [ -z "${RECIPIENT:-}" ]; then
    echo "❌ 缺少收件人配置: RECIPIENT" >&2
    exit 1
fi

# 生成汇报内容
REPORT_FILE="/tmp/gamestudio_report_$(date +%Y%m%d_%H%M%S).txt"

{
    echo "📊 GameStudio 项目状态汇报"
    echo "汇报时间：$(date '+%Y-%m-%d %H:%M:%S')"
    echo "========================="
    echo ""
    
    # 1. 核心服务状态
    echo "🖥️ 核心服务状态"
    echo -n "- Server (:1999): "
    curl -sS --max-time 2 http://127.0.0.1:1999/api/health > /dev/null 2>&1 && echo "✅ 运行中" || echo "❌ 已停止"
    echo -n "- Editor (:8868): "
    curl -sS --max-time 2 http://localhost:8868 > /dev/null 2>&1 && echo "✅ 可访问" || echo "❌ 不可访问"
    echo -n "- Gateway (:18789): "
    curl -sS --max-time 2 http://127.0.0.1:18789/api/health > /dev/null 2>&1 && echo "✅ 正常" || echo "❌ 异常"
    echo ""
    
    # 2. AI 模型状态
    echo "🤖 AI 模型状态"
    echo -n "- omlx 模型服务: "
    MODEL_CHECK=$(curl -sS --max-time 2 -H "Authorization: Bearer omlx123" --noproxy '*' http://127.0.0.1:18888/v1/models 2>/dev/null)
    if echo "$MODEL_CHECK" | grep -q '"data"'; then
        COUNT=$(echo "$MODEL_CHECK" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo "?")
        echo "✅ 正常 (加载了 $COUNT 个模型)"
    else
        echo "❌ 未连接或无模型"
    fi
    echo ""
    
    # 3. 资源监控
    echo "💾 资源监控"
    DISK=$(df -h / | awk 'NR==2 {print $5}')
    echo "- 磁盘空间: $DISK"
    echo ""
    
    # 4. 任务进度
    echo "📋 任务进度"
    if [ -f "$AI_MEMORY_DIR/TASK_QUEUE.md" ]; then
        DONE=$(grep -c "\[x\]" "$AI_MEMORY_DIR/TASK_QUEUE.md" 2>/dev/null || echo "0")
        TODO=$(grep -c "\[ \]" "$AI_MEMORY_DIR/TASK_QUEUE.md" 2>/dev/null || echo "0")
        echo "- 已完成: $DONE 项 | 待办: $TODO 项"
        echo ""
        echo "待办任务列表:"
        grep "^\- \[ \]" "$AI_MEMORY_DIR/TASK_QUEUE.md" | head -5 | sed 's/^- //'
    else
        echo "- 无任务队列文件"
    fi
    echo ""
    
    # 5. 今日进展
    echo "📈 今日进展"
    TODAY=$(date +%Y-%m-%d)
    if [ -f "$AI_MEMORY_DIR/${TODAY}.md" ]; then
        tail -15 "$AI_MEMORY_DIR/${TODAY}.md"
    else
        echo "- 今日暂无日志"
    fi
    echo ""
    
    echo "========================="
    echo "汇报完毕。"
} > "$REPORT_FILE"

# 发送邮件
echo "📧 正在发送邮件汇报..."

SUBJECT_LINE="${SUBJECT_PREFIX} 项目汇报 $(date '+%Y-%m-%d %H:%M')"

send_via_mail_app() {
    osascript - "$REPORT_FILE" "$RECIPIENT" "$SUBJECT_LINE" "${SENDER_NAME:-GameStudio Reporter}" "${SENDER_EMAIL:-}" <<'APPLESCRIPT'
on run argv
    set reportPath to item 1 of argv
    set recipientAddress to item 2 of argv
    set subjectLine to item 3 of argv
    set senderName to item 4 of argv
    set senderEmail to item 5 of argv
    set composedSender to senderName
    if senderEmail is not "" then
        set composedSender to senderName & " <" & senderEmail & ">"
    end if

    tell application "Mail"
        set bodyText to do shell script "cat " & quoted form of reportPath
        set msgProps to {subject:subjectLine, content:bodyText & return & return, visible:false}
        if senderEmail is not "" then
            set msgProps to {subject:subjectLine, content:bodyText & return & return, visible:false, sender:composedSender}
        end if
        set newMessage to make new outgoing message with properties msgProps
        tell newMessage
            make new to recipient at end of to recipients with properties {address:recipientAddress}
        end tell
        send newMessage
    end tell
    return "ok"
end run
APPLESCRIPT
}

send_via_sendmail() {
    {
        echo "From: ${SENDER_NAME} <${SENDER_EMAIL}>"
        echo "To: ${RECIPIENT}"
        echo "Subject: ${SUBJECT_LINE}"
        echo ""
        cat "$REPORT_FILE"
    } | sendmail -t
}

if [ "$(uname -s)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
    if send_via_mail_app; then
        echo "✅ 邮件已通过 Mail App 发送至: $RECIPIENT"
    else
        echo "⚠️ Mail App 发送失败，回退到 sendmail"
        send_via_sendmail
        echo "✅ 邮件已通过 sendmail 发送至: $RECIPIENT"
    fi
else
    send_via_sendmail
    echo "✅ 邮件已通过 sendmail 发送至: $RECIPIENT"
fi

# 清理临时文件
rm -f "$REPORT_FILE"
