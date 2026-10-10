#!/usr/bin/env bash
# 用例: W0-1 · 设备注册/心跳/进度 + 批次码 provision + 部署/指令链路（验收点 3）
# 前置: 40-admin-api.sh 已建持久批次（state.json persist_batch_code）
# 流程: provision(批次码领 key) → register → admin deploy → 心跳取指令 → progress 上报
#       → verify ok → online；command 下发体检；agent/latest 注入校验。
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

H_AUTH="Authorization: Bearer $ADMIN_TOKEN"
H_JSON="Content-Type: application/json"

BATCH_CODE=$(load_state persist_batch_code)
[ -n "$BATCH_CODE" ] || { echo "缺少 persist_batch_code（需先跑 40-admin-api.sh）" >&2; exit 2; }

# ---- 批次码 provision（无鉴权，批次码即装机凭证） ----
req_json POST /api/device/provision -H "$H_JSON" \
  -d "{\"batch_code\":\"$BATCH_CODE\",\"machine_id\":\"w0-m1\",\"hardware_id\":\"w0-h1\",\"device\":{\"hostname\":\"w0-dev-1\",\"os\":\"ubuntu 22.04\"}}"
assert_code "provision 合法批次码 → 200" 200
assert_json_ok "provision ok=true"
DEV_KEY=$(json_field "$BODY" device_key)
DEV_ID=$(json_field "$BODY" device_id)
assert_contains "provision 返回 cck- 设备密钥" "cck-" "$DEV_KEY"
[ "$(printf '%s' "$DEV_ID" | wc -c | tr -d ' ')" = "12" ] && ok "provision 返回 12 位 device_id ($DEV_ID)" || not_ok "device_id 长度应为 12，actual=$DEV_ID"
assert_eq "provision 返回批次码回显" "$(json_field "$BODY" batch)" "$BATCH_CODE"
assert_contains "provision 返回 api_base（真实源地址）" "$BASE_URL" "$(json_field "$BODY" api_base)"
save_state device_key "$DEV_KEY"
save_state device_id "$DEV_ID"
save_state persist_batch_code "$BATCH_CODE"

# 同硬件指纹重复 provision → 复用（配额不重复消耗、密钥不变）
req_json POST /api/device/provision -H "$H_JSON" \
  -d "{\"batch_code\":\"$BATCH_CODE\",\"machine_id\":\"w0-m1\",\"hardware_id\":\"w0-h1\"}"
assert_json_ok "同硬件重复 provision ok=true"
assert_eq "同硬件重复 provision reused=true" "$(json_field "$BODY" reused)" "true"
assert_eq "同硬件重复 provision 密钥不变" "$(json_field "$BODY" device_key)" "$DEV_KEY"

# ---- 设备注册（X-Device-Key 鉴权） ----
req_json POST /api/device/register -H "X-Device-Key: $DEV_KEY" -H "$H_JSON" \
  -d '{"device":{"hostname":"w0-dev-1","os":"ubuntu 22.04","gpu":"rtx4090"}}'
assert_code "设备注册（合法 key）→ 200" 200
assert_json_ok "设备注册 ok=true"
assert_eq "设备注册回显 device_id" "$(json_field "$BODY" device_id)" "$DEV_ID"

req_json GET /api/admin/device/$DEV_ID -H "$H_AUTH"
assert_code "管理端设备详情 → 200" 200
assert_eq "设备详情 hostname 已落库" "$(json_field "$BODY" device.hostname)" "w0-dev-1"
assert_eq "设备详情 batch 已落库" "$(json_field "$BODY" device.batch)" "$BATCH_CODE"

# ---- 心跳（部署中 → 快轮询 3s） ----
req_json POST /api/device/heartbeat -H "X-Device-Key: $DEV_KEY" -H "$H_JSON" \
  -d '{"device":{},"deploy":{"state":"deploying","step":"pull","detail":"pulling image"}}'
assert_code "设备心跳 → 200" 200
assert_json_ok "设备心跳 ok=true"
assert_eq "部署中心跳 poll_after=3（快轮询）" "$(json_field "$BODY" poll_after)" "3"
assert_eq "心跳未有待执行指令时 command=null" "$(json_field "$BODY" command)" "null"

# ---- 管理端下发部署指令 → 心跳取走 ----
req_json POST /api/admin/deploy -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"device_id\":\"$DEV_ID\",\"engine\":\"ollama\",\"model\":\"qwen2.5:7b-instruct\"}"
assert_code "管理端 deploy → 200" 200
assert_json_ok "管理端 deploy ok=true"
assert_eq "deploy 指令 engine" "$(json_field "$BODY" command.engine)" "ollama"

req_json GET /api/admin/device/$DEV_ID -H "$H_AUTH"
assert_eq "deploy 后设备状态 queued" "$(json_field "$BODY" device.deploy.state)" "queued"

req_json POST /api/device/heartbeat -H "X-Device-Key: $DEV_KEY" -H "$H_JSON" -d '{"device":{}}'
assert_code "心跳（有待执行指令）→ 200" 200
assert_eq "心跳取到 deploy 指令" "$(json_field "$BODY" command.type)" "deploy"
assert_eq "取指令后 poll_after=3" "$(json_field "$BODY" poll_after)" "3"

# ---- 进度上报（verify ok → online + tunnel_url 固化） ----
req_json POST /api/device/progress -H "X-Device-Key: $DEV_KEY" -H "$H_JSON" \
  -d '{"step":"pull","state":"ok","detail":"pulled","ts":1700000001}'
assert_code "进度上报 pull ok → 200" 200
assert_json_ok "进度上报 ok=true"
req_json POST /api/device/progress -H "X-Device-Key: $DEV_KEY" -H "$H_JSON" \
  -d '{"step":"verify","state":"ok","detail":"verified https://abc123.trycloudflare.com","ts":1700000002}'
assert_code "进度上报 verify ok → 200" 200
req_json GET /api/admin/device/$DEV_ID -H "$H_AUTH"
assert_eq "verify 后设备状态 online" "$(json_field "$BODY" device.deploy.state)" "online"
TUNNEL=$(json_field "$BODY" device.deploy.tunnel_url)
assert_contains "tunnel_url 已固化进 deploy 记录" "trycloudflare.com" "$TUNNEL"
save_state deploy_state "online"

# 迟到的旧进度不推翻 online
req_json POST /api/device/progress -H "X-Device-Key: $DEV_KEY" -H "$H_JSON" \
  -d '{"step":"pull","state":"ok","detail":"late","ts":1700000000}'
req_json GET /api/admin/device/$DEV_ID -H "$H_AUTH"
assert_eq "迟到的旧进度不推翻 online" "$(json_field "$BODY" device.deploy.state)" "online"

# ---- 管理端 command 体检 ----
req_json POST /api/admin/command -H "$H_AUTH" -H "$H_JSON" -d "{\"device_id\":\"$DEV_ID\",\"type\":\"stop\"}"
assert_code "command stop → 200" 200
assert_json_ok "command stop ok=true"
req_json POST /api/device/heartbeat -H "X-Device-Key: $DEV_KEY" -H "$H_JSON" -d '{"device":{}}'
assert_eq "心跳取到 stop 指令" "$(json_field "$BODY" command.type)" "stop"
req_json POST /api/admin/command -H "$H_AUTH" -H "$H_JSON" -d "{\"device_id\":\"$DEV_ID\",\"type\":\"ocr\",\"action\":\"install\"}"
assert_code "command ocr/install → 200" 200
req_json POST /api/admin/command -H "$H_AUTH" -H "$H_JSON" -d "{\"device_id\":\"$DEV_ID\",\"type\":\"h3\",\"action\":\"start\"}"
assert_code "command h3/start → 200" 200
req_json POST /api/admin/command -H "$H_AUTH" -H "$H_JSON" -d "{\"device_id\":\"$DEV_ID\"}"
assert_code "command 缺 type → 400" 400
req_json POST /api/admin/command -H "$H_AUTH" -H "$H_JSON" -d "{\"device_id\":\"$DEV_ID\",\"type\":\"ocr\"}"
assert_code "command ocr 缺 action → 400" 400
req_json POST /api/admin/deploy -H "$H_AUTH" -H "$H_JSON" -d '{"device_id":"ffffffffffff","engine":"ollama","model":"qwen2.5:7b-instruct"}'
assert_code "deploy 不存在设备 → 404" 404

# ---- agent/latest（注入真实 key/API_BASE） ----
req GET /api/agent/latest -H "X-Device-Key: $DEV_KEY"
assert_code "GET /api/agent/latest → 200" 200
assert_contains "agent/latest 返回真实 python 脚本头" "#!/usr/bin/env python3" "$BODY"
assert_contains "agent/latest 已注入真实设备 key" "$DEV_KEY" "$BODY"
assert_contains "agent/latest 已注入 BASE_URL 主机" "$(node -e 'console.log(new URL(process.env.BASE_URL).host)' )" "$BODY"

# ---- agent/version（版本号以本地仓库文件为准，本地通道下无网络依赖） ----
LOCAL_AGENT_VER=$(grep -m1 '^VERSION = ' "$(cd ../../.. && pwd)/agent/cybercafe-agent.py" | sed -E 's/.*"([^"]+)".*/\1/')
req_json GET /api/agent/version
if [ "$HTTP_CODE" = 200 ] && [ "$(json_field "$BODY" ok)" = "true" ]; then
  assert_eq "GET /api/agent/version 版本号与仓库文件一致" "$(json_field "$BODY" version)" "$LOCAL_AGENT_VER"
else
  skip "GET /api/agent/version 需外部通道可用（HTTP=${HTTP_CODE}），由 60 通道用例覆盖"
fi

summary "30-device-api"