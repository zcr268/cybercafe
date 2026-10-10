#!/usr/bin/env bash
# 用例: W0-1 · KV 状态持久化（验收点 4）：写入设备/批次后重启服务数据不丢
# 用法: cases/50-persistence.sh a   （重启前：记录快照基准）
#       cases/50-persistence.sh b   （重启后：断言数据仍在 API 可见）
# 说明: 语义断言两种形态都必须通过；KV 落盘为真实本地文件（DATA_DIR/kv.json）的
#       形态断言在 cases/70-form.sh（service 模式强断言 / baseline 模式记录预期红）。
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

H_AUTH="Authorization: Bearer $ADMIN_TOKEN"
H_JSON="Content-Type: application/json"
STEP="${1:-a}"

DEV_ID=$(load_state device_id)
BATCH_CODE=$(load_state persist_batch_code)
[ -n "$DEV_ID" ] && [ -n "$BATCH_CODE" ] || { echo "缺少 state（需先跑 40/30 用例）" >&2; exit 2; }

if [ "$STEP" = "a" ]; then
  # ---- 重启前：记录当前状态为快照基准（50b 重启后逐一核对） ----
  req_json GET /api/admin/batches -H "$H_AUTH"
  assert_code "[a] 重启前 GET batches → 200" 200
  assert_contains "[a] 重启前批次列表含持久批次" "$BATCH_CODE" "$BODY"
  save_state snap_batch_seen "$BATCH_CODE"

  req_json GET /api/admin/device/$DEV_ID -H "$H_AUTH"
  assert_code "[a] 重启前 GET device → 200" 200
  SNAP_STATE=$(json_field "$BODY" device.deploy.state)
  SNAP_HOST=$(json_field "$BODY" device.hostname)
  save_state snap_deploy_state "$SNAP_STATE"
  save_state snap_hostname "$SNAP_HOST"
  ok "[a] 重启前部署状态快照=$SNAP_STATE hostname=$SNAP_HOST"

  req_json GET /api/admin/settings -H "$H_AUTH"
  SNAP_RETIRE=$(json_field "$BODY" retire_after_s)
  save_state snap_retire_after_s "$SNAP_RETIRE"
  ok "[a] 重启前 settings 快照 retire_after_s=$SNAP_RETIRE"

  req_json GET /api/admin/devices -H "$H_AUTH"
  assert_contains "[a] 重启前设备列表含主设备" "$DEV_ID" "$BODY"

elif [ "$STEP" = "b" ]; then
  # ---- 重启后：同 DATA_DIR 重启，数据必须不丢 ----
  req_json GET /api/admin/batches -H "$H_AUTH"
  assert_code "[b] 重启后 GET batches → 200" 200
  assert_contains "[b] 重启后批次仍在（KV 持久化）" "$BATCH_CODE" "$BODY"

  req_json GET /api/admin/device/$DEV_ID -H "$H_AUTH"
  assert_code "[b] 重启后 GET device → 200" 200
  assert_eq "[b] 重启后 hostname 不丢" "$(json_field "$BODY" device.hostname)" "$(load_state snap_hostname)"
  assert_eq "[b] 重启后部署状态不丢" "$(json_field "$BODY" device.deploy.state)" "$(load_state snap_deploy_state)"

  req_json GET /api/admin/settings -H "$H_AUTH"
  assert_eq "[b] 重启后 settings 不丢" "$(json_field "$BODY" retire_after_s)" "$(load_state snap_retire_after_s)"

  req_json GET /api/admin/devices -H "$H_AUTH"
  assert_contains "[b] 重启后设备列表仍含主设备" "$DEV_ID" "$BODY"
  if [ "$MODE" = "service" ]; then
    ok "[b] service 形态：持久化由本地文件承载（kv.json 断言见 70-form）"
  fi
else
  echo "未知步骤: ${STEP}（a=重启前快照 / b=重启后断言）" >&2; exit 2
fi

summary "50-persistence($STEP)"