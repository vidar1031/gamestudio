#!/usr/bin/env bash
# ============================================================
#  Game Studio H5 主链路 Smoke Test
#  用法: bash smoke_test_pipeline.sh [--cleanup]
#  --cleanup: 测试完成后删除测试项目
#
#  Stage 顺序:
#    1. 服务健康检查
#    2. AI 故事创建
#    3. 蓝图编译
#    4. 蓝图验证
#    5. 合成 (blueprint → story)
#    6. 导出 H5
#
#  输出: 每个 stage 打印 PASS / FAIL + 原因
#  退出码: 0=全部通过, 1=有失败
# ============================================================

set -uo pipefail

BASE_URL="http://127.0.0.1:1999"
CLEANUP=false
PROJECT_ID=""
FAIL_COUNT=0
RESULTS=()
SKIP_AI_CREATE=false

for arg in "$@"; do
  case "$arg" in
    --cleanup) CLEANUP=true ;;
  esac
done

cleanup() {
  if [ "$CLEANUP" = true ] && [ -n "$PROJECT_ID" ]; then
    curl -sS -X DELETE "$BASE_URL/api/projects/$PROJECT_ID" > /dev/null 2>&1 || true
    echo "[cleanup] 已删除测试项目 $PROJECT_ID"
  fi
}
trap cleanup EXIT

pass() {
  local stage="$1"
  local detail="$2"
  echo "  ✅ PASS: $stage — $detail"
  RESULTS+=("PASS|$stage|$detail")
}

fail() {
  local stage="$1"
  local detail="$2"
  echo "  ❌ FAIL: $stage — $detail"
  RESULTS+=("FAIL|$stage|$detail")
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

echo "========================================"
echo "  Game Studio 主链路 Smoke Test"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"
echo ""

# ---- Stage 1: 服务健康检查 ----
echo "[Stage 1] 服务健康检查"
HEALTH=$(curl -sS --max-time 5 "$BASE_URL/api/health" 2>/dev/null || echo '{"ok":false}')
if echo "$HEALTH" | grep -q '"ok":true'; then
  pass "服务健康" "server :1999 在线"
else
  fail "服务健康" "server :1999 不可用，后续测试无法进行"
  echo ""
  echo "========================================"
  echo "  结果汇总: 1 FAIL / 0 PASS"
  echo "  服务未运行，请先 bash start_project.sh --detached"
  echo "========================================"
  exit 1
fi

# ---- Stage 1b: AI provider 可用性检查 ----
echo "[Stage 1b] AI provider 可用性检查"
AI_STATUS=$(curl -sS --max-time 5 "$BASE_URL/api/ai/status" 2>/dev/null || echo '{"ai":{"openai":{"keyPresent":false}}}')
KEY_PRESENT=$(echo "$AI_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ai',{}).get('openai',{}).get('keyPresent',False))" 2>/dev/null || echo "False")
AI_MODEL=$(echo "$AI_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ai',{}).get('openai',{}).get('model','?'))" 2>/dev/null || echo "?")
AI_BASE=$(echo "$AI_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ai',{}).get('openai',{}).get('baseUrl','?'))" 2>/dev/null || echo "?")

# 快速模型连接性测试：检查模型服务是否可用且空闲
# 模型可达性检查
if [ "$KEY_PRESENT" != "True" ]; then
  fail "AI provider" "缺少 API key (keyPresent=false)"
  SKIP_AI_CREATE=true
else
  MODEL_LIST=$(curl -sS --connect-timeout 3 --max-time 5 "${AI_BASE}/models" \
    -H "Authorization: Bearer omlx123" 2>/dev/null || echo "timeout")
  if echo "$MODEL_LIST" | grep -q "timeout\|Connection refused"; then
    fail "AI provider" "模型服务 $AI_BASE 不可达"
    SKIP_AI_CREATE=true
  else
    # 本地 MLX 是单并发的，检测是否有活跃连接（远程模型跳过此检查）
    IS_LOCAL=$(echo "$AI_BASE" | grep -c "127\.0\.0\.1\|localhost" || true)
    if [ "${IS_LOCAL:-0}" -gt 0 ]; then
      MLX_PORT=$(echo "$AI_BASE" | grep -o ':[0-9]*' | tail -1 | tr -d ':')
      ACTIVE_CONNS=$(lsof -i ":${MLX_PORT}" 2>/dev/null | grep ESTABLISHED | wc -l | tr -d ' ' || true)
      ACTIVE_CONNS=${ACTIVE_CONNS:-0}
      if [ "$ACTIVE_CONNS" -gt 0 ]; then
        fail "AI provider" "本地模型正忙（${ACTIVE_CONNS} 个活跃连接），AI 创建跳过"
        SKIP_AI_CREATE=true
      else
        pass "AI provider" "模型=$AI_MODEL, baseUrl=$AI_BASE (本地, 空闲)"
      fi
    else
      pass "AI provider" "模型=$AI_MODEL, baseUrl=$AI_BASE (远程)"
    fi
  fi
fi

# ---- Stage 2: AI 故事创建 ----
echo "[Stage 2] 故事创建"
if [ "${SKIP_AI_CREATE:-false}" = "true" ]; then
  echo "  ⏭️  AI 不可用，尝试手动创建项目..."
  # 用手动方式创建空白项目
  MANUAL_RESP=$(curl -sS --max-time 15 -X POST "$BASE_URL/api/projects" \
    -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo '{"error":"timeout"}')
  PROJECT_ID=$(echo "$MANUAL_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('project',{}).get('id',''))" 2>/dev/null || echo "")
  if [ -n "$PROJECT_ID" ]; then
    pass "手动项目创建" "项目=$PROJECT_ID (AI 故事创建跳过)"
  else
    fail "手动项目创建" "创建空白项目也失败"
  fi
else
  CREATE_RESP=$(curl -sS --max-time 180 -X POST "$BASE_URL/api/projects/ai/create" \
    -H "Content-Type: application/json" \
    -d '{"prompt":"一只小猫想要找到回家的路，途中遇到各种选择","title":"smoke-test-小猫回家","choicePoints":2,"optionsPerChoice":2,"endings":2}' 2>/dev/null || echo '{"error":"timeout"}')

  # 提取 project id
  PROJECT_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('project',{}).get('id',''))" 2>/dev/null || echo "")

  if [ -z "$PROJECT_ID" ]; then
    # 检查是否有错误信息
    ERROR_MSG=$(echo "$CREATE_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error','unknown'))" 2>/dev/null || echo "无法解析响应")
    fail "AI 故事创建" "创建失败: $ERROR_MSG"
  else
    CARD_COUNT=$(echo "$CREATE_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('scripts',{}).get('cards',[])))" 2>/dev/null || echo "0")
    GEN_MODEL=$(echo "$CREATE_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); g=d.get('gen',{}); print(f\"{g.get('provider','?')}/{g.get('model','?')}\")" 2>/dev/null || echo "?")
    if [ "$CARD_COUNT" -ge 3 ] 2>/dev/null; then
      pass "AI 故事创建" "项目=$PROJECT_ID, 脚本卡=$CARD_COUNT 张, 模型=$GEN_MODEL"
    else
      fail "AI 故事创建" "项目已创建($PROJECT_ID)但脚本卡只有 $CARD_COUNT 张 (需≥3)"
    fi
  fi
fi

# 如果没有 project id，后续无法继续
if [ -z "$PROJECT_ID" ]; then
  echo ""
  echo "========================================"
  echo "  结果汇总: $FAIL_COUNT FAIL"
  echo "  无法创建项目，后续测试跳过"
  echo "========================================"
  exit 1
fi

# ---- Stage 3: 蓝图编译 ----
echo "[Stage 3] 蓝图编译 (scripts → blueprint)"
COMPILE_RESP=$(curl -sS --max-time 30 -X POST "$BASE_URL/api/projects/$PROJECT_ID/compile/blueprint" \
  -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo '{"error":"timeout"}')

COMPILE_OK=$(echo "$COMPILE_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
bp=d.get('blueprint',{})
val=d.get('validation',{})
nodes=bp.get('nodes',[])
errors=d.get('report',{}).get('errors',[])
val_ok=val.get('ok', False)
print(f'{len(nodes)}|{len(errors)}|{val_ok}')
" 2>/dev/null || echo "0|1|False")

NODE_COUNT=$(echo "$COMPILE_OK" | cut -d'|' -f1)
ERROR_COUNT=$(echo "$COMPILE_OK" | cut -d'|' -f2)
VAL_OK=$(echo "$COMPILE_OK" | cut -d'|' -f3)

if [ "$NODE_COUNT" -ge 1 ] 2>/dev/null && [ "$ERROR_COUNT" -eq 0 ] 2>/dev/null; then
  pass "蓝图编译" "节点=$NODE_COUNT, 错误=0, 验证=$VAL_OK"
else
  fail "蓝图编译" "节点=$NODE_COUNT, 错误=$ERROR_COUNT, 验证=$VAL_OK"
fi

# ---- Stage 4: 蓝图验证 ----
echo "[Stage 4] 蓝图验证"
VALIDATE_RESP=$(curl -sS --max-time 15 -X POST "$BASE_URL/api/projects/$PROJECT_ID/validate/blueprint" \
  -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo '{"ok":false}')

VALIDATE_OK=$(echo "$VALIDATE_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ok = d.get('ok', d.get('validation',{}).get('ok', False))
errors = d.get('errors', d.get('validation',{}).get('errors', []))
print(f'{ok}|{len(errors)}')
" 2>/dev/null || echo "False|1")

V_OK=$(echo "$VALIDATE_OK" | cut -d'|' -f1)
V_ERR=$(echo "$VALIDATE_OK" | cut -d'|' -f2)

if [ "$V_OK" = "True" ] || [ "$V_ERR" = "0" ]; then
  pass "蓝图验证" "验证通过, 错误=$V_ERR"
else
  fail "蓝图验证" "验证失败, 错误=$V_ERR"
fi

# ---- Stage 5: 合成 (blueprint → story) ----
echo "[Stage 5] 合成 (blueprint → story)"
COMPOSE_RESP=$(curl -sS --max-time 30 -X POST "$BASE_URL/api/projects/$PROJECT_ID/compile/compose" \
  -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo '{"error":"timeout"}')

COMPOSE_OK=$(echo "$COMPOSE_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
# compose 可能直接返回 story，或者包在 story 字段里
story = d.get('story', d)
nodes = story.get('nodes', [])
start = story.get('startNodeId', '')
print(f'{len(nodes)}|{bool(start)}')
" 2>/dev/null || echo "0|False")

S_NODES=$(echo "$COMPOSE_OK" | cut -d'|' -f1)
S_START=$(echo "$COMPOSE_OK" | cut -d'|' -f2)

if [ "$S_NODES" -ge 1 ] 2>/dev/null && [ "$S_START" = "True" ]; then
  pass "合成" "story 节点=$S_NODES, startNodeId 存在"
else
  fail "合成" "story 节点=$S_NODES, startNodeId=$S_START"
fi

# ---- Stage 6: 导出 H5 ----
echo "[Stage 6] 导出 H5"
EXPORT_RESP=$(curl -sS --max-time 60 -X POST "$BASE_URL/api/projects/$PROJECT_ID/export" \
  -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo '{"error":"timeout"}')

BUILD_ID=$(echo "$EXPORT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('buildId',''))" 2>/dev/null || echo "")
DIST_URL=$(echo "$EXPORT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('distUrl',''))" 2>/dev/null || echo "")

if [ -n "$BUILD_ID" ] && [ -n "$DIST_URL" ]; then
  # 验证产物可访问
  HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$BASE_URL$DIST_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    pass "导出 H5" "buildId=$BUILD_ID, distUrl 返回 200"
  else
    fail "导出 H5" "buildId=$BUILD_ID, distUrl 返回 HTTP $HTTP_CODE"
  fi
else
  EXPORT_ERR=$(echo "$EXPORT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',d.get('message','unknown')))" 2>/dev/null || echo "无法解析")
  fail "导出 H5" "导出失败: $EXPORT_ERR"
fi

# ---- 汇总 ----
echo ""
echo "========================================"
TOTAL=${#RESULTS[@]}
PASS_COUNT=$((TOTAL - FAIL_COUNT))
echo "  结果汇总: $PASS_COUNT PASS / $FAIL_COUNT FAIL (共 $TOTAL 项)"
echo ""
for r in "${RESULTS[@]}"; do
  STATUS=$(echo "$r" | cut -d'|' -f1)
  STAGE=$(echo "$r" | cut -d'|' -f2)
  DETAIL=$(echo "$r" | cut -d'|' -f3)
  if [ "$STATUS" = "PASS" ]; then
    echo "  ✅ $STAGE"
  else
    echo "  ❌ $STAGE — $DETAIL"
  fi
done
if [ -n "$PROJECT_ID" ]; then
  echo ""
  echo "  测试项目 ID: $PROJECT_ID"
fi
echo "========================================"

exit $FAIL_COUNT
