#!/usr/bin/env bash
# 用例: W0-1 · 脚本分发通道真实可用（验收点 5）
#   通道0 本地挂载：AGENT_LOCAL_BASE/AGENT_LOCAL_ROOT_BASE 指向 run.sh 起的真实静态服务器
#      （等价生产 compose 的 public/_agent、public/_repo 只读挂载）
#   回退通道：停掉本地静态服务器 → 服务经真实 raw/jsDelivr 网络回退（无外网时记录 skip 并注明）
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

H_AUTH="Authorization: Bearer $ADMIN_TOKEN"
H_JSON="Content-Type: application/json"

DEV_KEY=$(load_state device_key)
BATCH_CODE=$(load_state persist_batch_code)
[ -n "$DEV_KEY" ] || { echo "缺少 device_key（需先跑 30 用例）" >&2; exit 2; }

LOCAL_AGENT="$AGENT_SRC"      # 仓库 agent/（静态服务器根）
LOCAL_ROOT="$REPO_ROOT"       # 仓库根

# 本地文件基线：sha256 前 8 位 + 版本
LOCAL_AGENT_SHA=$(shasum -a 256 "$LOCAL_AGENT/cybercafe-agent.py" | cut -c1-8)
LOCAL_INSTALL_SHA=$(shasum -a 256 "$LOCAL_AGENT/install.sh" | cut -c1-8)
LOCAL_AGENT_VER=$(grep -m1 '^VERSION = ' "$LOCAL_AGENT/cybercafe-agent.py" | sed -E 's/.*"([^"]+)".*/\1/')
LOCAL_INSTALL_VER=$(grep -m1 '^# Version: ' "$LOCAL_AGENT/install.sh" | awk '{print $3}')
LOCAL_PROVISION_VER=$(grep -m1 '^# Version: ' "$LOCAL_AGENT/provision.sh" | awk '{print $3}')
LOCAL_SERVICE_VER=$(grep -m1 '^# Version: ' "$LOCAL_AGENT/cybercafe-provision.service" | awk '{print $3}')

# ---- 管理端脚本清单：source=local，sha/version 与本地真实文件一致 ----
req_json GET /api/admin/scripts -H "$H_AUTH"
assert_code "GET scripts → 200" 200
assert_json_ok "GET scripts ok=true"
assert_eq "scripts[0] name=cybercafe-agent.py" "$(json_field "$BODY" scripts.0.name)" "cybercafe-agent.py"
assert_eq "scripts[0] source=local（本地挂载通道）" "$(json_field "$BODY" scripts.0.source)" "local"
assert_eq "scripts[0] sha 与本地文件一致" "$(json_field "$BODY" scripts.0.sha)" "$LOCAL_AGENT_SHA"
assert_eq "scripts[0] version=$LOCAL_AGENT_VER" "$(json_field "$BODY" scripts.0.version)" "$LOCAL_AGENT_VER"
assert_eq "scripts[1] version=$LOCAL_INSTALL_VER" "$(json_field "$BODY" scripts.1.version)" "$LOCAL_INSTALL_VER"
assert_eq "scripts[2] version=$LOCAL_PROVISION_VER" "$(json_field "$BODY" scripts.2.version)" "$LOCAL_PROVISION_VER"
assert_eq "scripts[3] version=$LOCAL_SERVICE_VER" "$(json_field "$BODY" scripts.3.version)" "$LOCAL_SERVICE_VER"

# ---- install.sh?key= 注入真实 key/API_BASE（单机安装） ----
req GET "/install.sh?key=$DEV_KEY"
assert_code "install.sh?key= → 200" 200
assert_contains "install.sh 注入真实设备 key" "$DEV_KEY" "$BODY"
assert_contains "install.sh 注入真实 API_BASE 主机" "$(node -e 'console.log(new URL(process.env.BASE_URL).host)')" "$BODY"
req_json GET "/install.sh?key=bad-key-000"
assert_code "install.sh?key=伪造 key → 403" 403

# ---- install.sh?batch= 批次一键装机原始下发（不注入占位符） ----
req GET "/install.sh?batch=$BATCH_CODE"
assert_code "install.sh?batch= → 200" 200
assert_contains "批次模式保留占位符（原始下发）" "__DEVICE_KEY__" "$BODY"

# ---- install-extra 白名单通道（agent 作用域 + root 作用域） ----
req GET "/install-extra?name=install.sh"
assert_code "install-extra install.sh → 200" 200
if [ "$(printf '%s' "$BODY" | shasum -a 256 | cut -c1-8)" = "$LOCAL_INSTALL_SHA" ]; then
  ok "install-extra 字节与本地 agent/install.sh 一致 (sha=$LOCAL_INSTALL_SHA)"
else
  not_ok "install-extra 字节与本地 agent/install.sh 不一致"
fi

req GET "/install-extra?name=uninstall-all.sh"
assert_code "install-extra uninstall-all.sh（root 通道）→ 200" 200
assert_contains "root 通道内容为仓库根 uninstall-all.sh" "#!/bin/sh" "$BODY"
req GET "/install-extra?name=ocr/install.sh"
assert_code "install-extra ocr/install.sh（root 子路径）→ 200" 200
req GET "/install-extra?name=foobar.sh"
assert_code "install-extra 白名单外 → 403" 403
# 路径穿越：URL 解析器会先规范化裸 ..，编码形态（%2e%2e%2f）才会真实到达
# 静态服务器并被根目录包含检查拦截（真实 403，见 lifecycle/static-server.mjs）
req GET "/install-extra?name=%2e%2e%2fetc%2fpasswd"
assert_code "install-extra 编码穿越 → 403" 403

# ---- 回退通道：本地挂载不可达 → 真实 raw/jsDelivr 网络回退 ----
if [ -n "${AGENT_LOCAL_BASE:-}" ] && [ -f "$OUT_DIR/static-agent.pid" ]; then
  kill "$(cat "$OUT_DIR/static-agent.pid")" 2>/dev/null || true
  sleep 1   # 端口真实关闭，本地通道请求将真实失败
  req_json GET /api/agent/version
  if [ "$HTTP_CODE" = 200 ] && [ "$(json_field "$BODY" ok)" = "true" ]; then
    assert_eq "本地通道失效后版本经真实网络回退" "$(json_field "$BODY" version)" "0.7.0"
  elif [ "$HTTP_CODE" = 502 ]; then
    skip "回退通道: 本环境无外网，raw/jsDelivr 真实请求失败（502），需在有外网验收环境复跑"
  else
    not_ok "回退通道异常（HTTP=$HTTP_CODE body=${BODY}）"
  fi
  # 恢复本地通道服务器（供后续用例；若已起则跳过）
  if [ ! -f "$OUT_DIR/static-agent.pid" ]; then
    AGENT_PORT=$((20000 + RANDOM % 10000))
    node "$(pwd)/lifecycle/static-server.mjs" "$AGENT_SRC" "$AGENT_PORT" >"$OUT_DIR/static-agent.log" 2>&1 &
    echo $! > "$OUT_DIR/static-agent.pid"
    # 注：新端口与已注入 AGENT_LOCAL_BASE 不同 → 后续用例不再依赖该通道（契约用例已完成）
  fi
else
  skip "回退通道: attach 模式未注入 AGENT_LOCAL_BASE，由 lifecycle 模式覆盖"
fi

summary "60-script-channel"