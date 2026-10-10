#!/usr/bin/env bash
# 用例: W0-1 · 形态门禁（验收点 1）：服务以真实进程直接运行，不依赖 wrangler dev 模拟
#   MODE=service : 强断言——真实进程存活、进程命令不含 wrangler、端口真实监听、
#                  KV 持久化为真实本地文件 DATA_DIR/kv.json（含 50a 写入的 device/batch 键）
#   MODE=baseline: 全部记录 not ok（红色基线），退出 77（预期红，run.sh 不判 FAIL）
# 契约: 新服务形态须把 KV 状态持久化为 DATA_DIR/kv.json（JSON 对象 key→value，value 为 JSON 字符串）
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

H_AUTH="Authorization: Bearer $ADMIN_TOKEN"
DEV_ID=$(load_state device_id)
BATCH_CODE=$(load_state persist_batch_code)

expect_red() { not_ok "$1"; }

if [ "$MODE" != "service" ]; then
  echo "(MODE=baseline：当前 wrangler dev 形态按验收点 1 判定为不满足——红色基线)"
  expect_red "真实进程直接运行（当前形态依赖 wrangler dev 模拟，预期红）"
  expect_red "进程命令不含 wrangler（当前形态即 wrangler dev，预期红）"
  expect_red "KV 持久化为本地文件 DATA_DIR/kv.json（当前形态为 wrangler --persist-to 目录，预期红）"
  summary "70-form(baseline-预期红)"
  exit 77   # 特殊退出码：run.sh 识别为「预期红，已记录」
fi

# ---- service 形态强断言 ----
PID_FILE="$OUT_DIR/service.pid"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    ok "服务以真实进程运行（PID=$PID 存活）"
  else
    not_ok "服务真实进程不存在（PID=${PID}）"
  fi
else
  not_ok "缺少 service.pid（lifecycle 未管理服务进程）"
fi

# 进程命令不得是 wrangler dev（真实独立服务形态）
if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
  CMDLINE=$(ps -o command= -p "$PID" 2>/dev/null || true)
  if [ -n "$CMDLINE" ]; then
    if printf '%s' "$CMDLINE" | grep -q "wrangler"; then
      not_ok "进程命令不应含 wrangler（actual: ${CMDLINE}）"
    else
      ok "进程命令为独立服务形态（${CMDLINE}）"
    fi
  else
    skip "ps 不可用（本沙箱受限），进程命令检查留待验收环境复跑"
  fi
fi

# 端口真实监听（curl 已隐含可达；lsof 可用时佐证）
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    ok "端口 $PORT 真实 TCP 监听"
  else
    not_ok "端口 $PORT 未监听"
  fi
else
  skip "lsof 不可用，端口监听以 curl 可达为准"
fi

# KV 落盘为真实本地文件（契约: DATA_DIR/kv.json）
KV_FILE="$DATA_DIR/kv.json"
if [ -f "$KV_FILE" ] && [ -s "$KV_FILE" ]; then
  ok "KV 持久化为真实本地文件（$KV_FILE, $(wc -c < "$KV_FILE" | tr -d ' ') 字节）"
  if [ -n "$BATCH_CODE" ] && grep -qF "\"batch:$BATCH_CODE\"" "$KV_FILE"; then
    ok "kv.json 含持久批次键 batch:${BATCH_CODE}（真实落盘证据）"
  else
    not_ok "kv.json 缺少批次键 batch:$BATCH_CODE"
  fi
  if [ -n "$DEV_ID" ] && grep -qF "\"device:$DEV_ID\"" "$KV_FILE"; then
    ok "kv.json 含设备键 device:${DEV_ID}（真实落盘证据）"
  else
    not_ok "kv.json 缺少设备键 device:$DEV_ID"
  fi
else
  not_ok "KV 未落盘为 DATA_DIR/kv.json（契约文件名，需 w2 对齐）"
fi

summary "70-form(service)"
