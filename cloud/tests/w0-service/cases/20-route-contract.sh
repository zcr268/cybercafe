#!/usr/bin/env bash
# 用例: W0-1 · 路由清单与鉴权行为等价（验收点 3 的一部分）
# 断言: 管理 API 全路由存在（Bearer ADMIN_TOKEN 鉴权 401/200）、设备侧鉴权
#       （X-Device-Key 401/200）、provision 无鉴权（批次码即凭证）、未知路由 404。
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

H_AUTH="Authorization: Bearer $ADMIN_TOKEN"
H_JSON="Content-Type: application/json"

# ---- 管理鉴权（Admin Bearer ADMIN_TOKEN） ----
req GET /api/admin/devices
assert_code "管理 API 无鉴权 → 401" 401
assert_contains "无鉴权响应为 JSON error" '"error"' "$BODY"

req GET /api/admin/devices -H "Authorization: Bearer wrong-token-123"
assert_code "管理 API 错误 token → 401" 401

req_json GET /api/admin/devices -H "$H_AUTH"
assert_code "管理 API 正确 Bearer → 200" 200
assert_json_ok "GET /api/admin/devices ok=true"

# ---- 设备侧鉴权（X-Device-Key） ----
req POST /api/device/register -H "$H_JSON" -d '{"device":{"hostname":"noauth"}}'
assert_code "设备注册无 X-Device-Key → 401" 401

req GET /api/agent/latest
assert_code "agent/latest 无 X-Device-Key → 401" 401

req POST /api/device/heartbeat -H "$H_JSON" -d '{}'
assert_code "设备心跳无 X-Device-Key → 401" 401

req POST /api/device/progress -H "$H_JSON" -d '{}'
assert_code "设备进度无 X-Device-Key → 401" 401

# ---- provision：无鉴权，批次码即凭证 ----
req_json POST /api/device/provision -H "$H_JSON" -d '{"machine_id":"w0-no-code"}'
assert_code "provision 缺批次码 → 400" 400
assert_contains "缺批次码提示 batch_code required" "batch_code required" "$BODY"

req_json POST /api/device/provision -H "$H_JSON" -d '{"batch_code":"ccb-nonexist","machine_id":"w0-m1"}'
assert_code "provision 错误批次码 → 403" 403
assert_contains "错误批次码提示 not found" "not found" "$BODY"

# ---- 管理路由存在性（全量清单，正确鉴权下应为 200/400/404 而非 401） ----
req_json GET /api/admin/settings -H "$H_AUTH"
assert_code "GET /api/admin/settings → 200" 200
req_json GET /api/admin/scripts -H "$H_AUTH"
if [ "$HTTP_CODE" = 200 ] || [ "$HTTP_CODE" = 502 ]; then ok "GET /api/admin/scripts 路由存在（200 或 502，通道见 60 用例）"; else not_ok "GET /api/admin/scripts 路由存在（HTTP=${HTTP_CODE}）"; fi
req_json GET /api/admin/batches -H "$H_AUTH"
assert_code "GET /api/admin/batches → 200" 200
req_json POST /api/admin/batches -H "$H_AUTH" -H "$H_JSON" -d '{"label":"route-probe"}'
if [ "$HTTP_CODE" = 200 ] || [ "$HTTP_CODE" = 400 ]; then ok "POST /api/admin/batches 路由存在（HTTP=${HTTP_CODE}）"; else not_ok "POST /api/admin/batches 路由存在（HTTP=${HTTP_CODE}）"; fi
req_json POST /api/admin/devices/new -H "$H_AUTH" -H "$H_JSON" -d '{"label":"probe"}'
if [ "$HTTP_CODE" = 200 ]; then ok "POST /api/admin/devices/new 路由存在（HTTP=200）"; else not_ok "POST /api/admin/devices/new 路由存在（HTTP=${HTTP_CODE}）"; fi
req_json POST /api/admin/deploy -H "$H_AUTH" -H "$H_JSON" -d '{"device_id":"000000000000"}'
if [ "$HTTP_CODE" = 404 ] || [ "$HTTP_CODE" = 400 ]; then ok "POST /api/admin/deploy 路由存在（HTTP=${HTTP_CODE}，设备不存在语义）"; else not_ok "POST /api/admin/deploy 路由存在（HTTP=${HTTP_CODE}）"; fi
req_json POST /api/admin/command -H "$H_AUTH" -H "$H_JSON" -d '{"device_id":"000000000000","type":"stop"}'
if [ "$HTTP_CODE" = 404 ] || [ "$HTTP_CODE" = 400 ]; then ok "POST /api/admin/command 路由存在（HTTP=${HTTP_CODE}）"; else not_ok "POST /api/admin/command 路由存在（HTTP=${HTTP_CODE}）"; fi

# ---- 未知管理路由 404（带正确鉴权） ----
req GET /api/admin/definitely-not-a-route -H "$H_AUTH"
assert_code "未知管理路由 → 404" 404

# ---- 其余非 /api 路径由静态服务提供（见 10），/install.sh 是服务路由（见 60） ----
req GET /install.sh
assert_code "GET /install.sh 无参 → 400（服务路由而非静态文件）" 400

summary "20-route-contract"
