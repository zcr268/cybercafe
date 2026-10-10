#!/usr/bin/env bash
# 用例: W0-1 · 管理 API 冒烟：settings/batches/deploy-设备创建与删除（验收点 3）
# 产出: state.json persist_batch_code（供 30/50 持久化链路使用）
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

H_AUTH="Authorization: Bearer $ADMIN_TOKEN"
H_JSON="Content-Type: application/json"

# ---- settings（白名单校验 + 持久化值，50 重启后用） ----
req_json GET /api/admin/settings -H "$H_AUTH"
assert_code "GET settings → 200" 200
assert_json_ok "GET settings ok=true"
assert_contains "settings options 含 1800" "1800" "$(json_field "$BODY" options)"
if node -e 'const d=JSON.parse(process.argv[1]);const n=d.retire_after_s;if(!d.options.includes(n))process.exit(1)' "$BODY" 2>/dev/null; then
  ok "settings retire_after_s 为白名单选项之一"
else
  not_ok "settings retire_after_s 不在白名单 options 内"
fi

req_json POST /api/admin/settings -H "$H_AUTH" -H "$H_JSON" -d '{"retire_after_s":1800}'
assert_code "POST settings 合法值 → 200" 200
assert_eq "POST settings 回显 1800" "$(json_field "$BODY" retire_after_s)" "1800"
req_json GET /api/admin/settings -H "$H_AUTH"
assert_eq "GET settings 回读 1800（落库）" "$(json_field "$BODY" retire_after_s)" "1800"

req_json POST /api/admin/settings -H "$H_AUTH" -H "$H_JSON" -d '{"retire_after_s":4321}'
assert_code "POST settings 非法值 → 400" 400

# ---- batches：建持久批次（不删，供 30/50）+ 建删临时批次 ----
req_json POST /api/admin/batches -H "$H_AUTH" -H "$H_JSON" -d '{"label":"w0-persist"}'
assert_code "建批次 w0-persist → 200" 200
assert_json_ok "建批次 ok=true"
PERSIST_CODE=$(json_field "$BODY" code)
assert_contains "批次码格式 ccb-" "ccb-" "$PERSIST_CODE"
assert_eq "未填配额 = 无限（null）" "$(json_field "$BODY" quota)" "null"
save_state persist_batch_code "$PERSIST_CODE"

req_json POST /api/admin/batches -H "$H_AUTH" -H "$H_JSON" -d '{"label":"w0-tmp","quota":2}'
assert_code "建限量批次 → 200" 200
TMP_CODE=$(json_field "$BODY" code)
assert_eq "限量批次 quota=2" "$(json_field "$BODY" quota)" "2"

req_json POST /api/admin/batches -H "$H_AUTH" -H "$H_JSON" -d '{"label":"w0-bad","quota":0}'
assert_code "建 quota=0 批次 → 400" 400

req_json GET /api/admin/batches -H "$H_AUTH"
assert_code "GET batches → 200" 200
assert_contains "批次列表含持久批次" "$PERSIST_CODE" "$BODY"
assert_contains "批次列表含临时批次" "$TMP_CODE" "$BODY"

req_json DELETE /api/admin/batches/$TMP_CODE -H "$H_AUTH"
assert_code "DELETE 临时批次 → 200" 200
assert_eq "DELETE 返回 removed=true" "$(json_field "$BODY" removed)" "true"
req_json GET /api/admin/batches -H "$H_AUTH"
if printf '%s' "$BODY" | grep -qF -- "$TMP_CODE"; then not_ok "删除后列表不应含临时批次（仍存在）"; else ok "删除后列表不含临时批次"; fi

# ---- devices/new + 独立设备删除链路（不影响 30 的主设备） ----
req_json POST /api/admin/devices/new -H "$H_AUTH" -H "$H_JSON" -d '{"label":"w0-del-me"}'
assert_code "devices/new → 200" 200
assert_json_ok "devices/new ok=true"
DEL_KEY=$(json_field "$BODY" device_key)
assert_contains "device_key 格式 cck-" "cck-" "$DEL_KEY"
assert_contains "install_command 含 install.sh 真实端点" "$BASE_URL/install.sh?key=" "$(json_field "$BODY" install_command)"

# 生成 device 记录（register），再走 详情→删除→404 链路
req_json POST /api/device/register -H "X-Device-Key: $DEL_KEY" -H "$H_JSON" -d '{"device":{"hostname":"w0-del"}}'
assert_code "准备设备记录 register → 200" 200
DEL_ID=$(json_field "$BODY" device_id)
req_json GET /api/admin/device/$DEL_ID -H "$H_AUTH"
assert_code "GET device 详情 → 200" 200
assert_eq "详情 hostname" "$(json_field "$BODY" device.hostname)" "w0-del"
req_json DELETE /api/admin/device/$DEL_ID -H "$H_AUTH"
assert_code "DELETE device → 200" 200
assert_eq "DELETE device removed=true" "$(json_field "$BODY" removed)" "true"
req_json GET /api/admin/device/$DEL_ID -H "$H_AUTH"
assert_code "删除后 GET device → 404" 404

summary "40-admin-api"