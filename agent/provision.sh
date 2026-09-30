#!/usr/bin/env bash
# CyberCafe 基础镜像首启 provision（预置于基础镜像，由 cybercafe-provision.service 触发）
# 目标：实例首次开机自动完成设备添加（免逐台执行安装命令），镜像内不写死单一设备密钥。
# 流程：
#   1) 采集 /etc/machine-id 作为 machine_id
#   2) 用批次码向云端 POST /api/device/provision 换取 cck- 设备密钥 + API 地址
#   3) 把 key + API_BASE 写入 /opt/cybercafe/config.env
#   4) 调用 install.sh --batch 安装并启动 agent（install.sh 读 config.env，跳过重复 provision）
#   5) 写 /opt/cybercafe/.provisioned 标记防重复
# 可重复执行（幂等）：已 provision 直接退出 0；同一 machine_id 云端复用原 key、不消耗配额。
set -euo pipefail

INSTALL_DIR="/opt/cybercafe"
MARKER="$INSTALL_DIR/.provisioned"

# 批次码来源优先级：PROVISION_CODE 环境变量 > /etc/cybercafe/batch.code > $INSTALL_DIR/batch.code > 命令行参数
BATCH_CODE="${PROVISION_CODE:-}"
if [ -f /etc/cybercafe/batch.code ] && [ -z "$BATCH_CODE" ]; then BATCH_CODE="$(head -1 /etc/cybercafe/batch.code)"; fi
if [ -f "$INSTALL_DIR/batch.code" ] && [ -z "$BATCH_CODE" ]; then BATCH_CODE="$(head -1 "$INSTALL_DIR/batch.code")"; fi
if [ $# -ge 1 ] && [ -n "${1:-}" ]; then BATCH_CODE="$1"; fi

# API 地址来源优先级：PROVISION_API_BASE 环境变量 > /etc/cybercafe/api_base > $INSTALL_DIR/api_base
API_BASE="${PROVISION_API_BASE:-}"
if [ -f /etc/cybercafe/api_base ] && [ -z "$API_BASE" ]; then API_BASE="$(head -1 /etc/cybercafe/api_base)"; fi
if [ -f "$INSTALL_DIR/api_base" ] && [ -z "$API_BASE" ]; then API_BASE="$(head -1 "$INSTALL_DIR/api_base")"; fi

if [ "$(id -u)" != "0" ]; then
    echo "[cybercafe] ERROR: 需要 root 运行" >&2
    exit 1
fi
if [ -f "$MARKER" ]; then
    echo "[cybercafe] 已 provision（$(cat "$MARKER")），跳过"
    exit 0
fi
if [ -z "$BATCH_CODE" ]; then
    echo "[cybercafe] ERROR: 批次码未配置（PROVISION_CODE / /etc/cybercafe/batch.code）" >&2
    exit 1
fi
if [ -z "$API_BASE" ]; then
    echo "[cybercafe] ERROR: API 地址未配置（PROVISION_API_BASE / /etc/cybercafe/api_base）" >&2
    exit 1
fi

mkdir -p "$INSTALL_DIR"

# 确保 one-shot 单元存在并启用（镜像若只预置了脚本，首次手动运行即可补齐；开机由单元触发）
UNIT=/etc/systemd/system/cybercafe-provision.service
if [ ! -f "$UNIT" ]; then
    cat > "$UNIT" << 'UNITEOF'
[Unit]
Description=CyberCafe First Boot Provisioning
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/opt/cybercafe/.provisioned

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/cybercafe/provision.sh

[Install]
WantedBy=multi-user.target
UNITEOF
    systemctl enable cybercafe-provision.service >/dev/null 2>&1 || true
fi
# 镜像预置（install.sh --image-prep）可能在构建期无 systemd 时已写入单元，首启时兜底刷新；
# 无 systemd 环境（镜像构建期）失败不影响主体逻辑
systemctl daemon-reload || true

# 1) machine_id
MACHINE_ID="$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo "unknown-$(hostname)")"

# 2) POST /api/device/provision（批次码即装机凭证）
echo "[cybercafe] provision: batch=$BATCH_CODE machine=$MACHINE_ID api=$API_BASE"
PROV_JSON="$(curl -sS --max-time 60 -X POST "$API_BASE/api/device/provision" \
    -H "Content-Type: application/json" \
    -d "{\"batch_code\":\"$BATCH_CODE\",\"machine_id\":\"$MACHINE_ID\",\"device\":{\"hostname\":\"$(hostname | tr -d '"')\",\"os\":\"$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' | head -1)\"}}" 2>&1 || true)"
# 解析 JSON（python3 不可用时用 grep 兜底；响应由云端 JSON.stringify 生成，键值无空白）
if command -v python3 >/dev/null 2>&1; then
    DEVICE_KEY="$(echo "$PROV_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("device_key",""))' 2>/dev/null || true)"
else
    DEVICE_KEY="$(echo "$PROV_JSON" | grep -o '"device_key":"[^"]*"' | head -1 | cut -d'"' -f4)"
fi
if [ -z "$DEVICE_KEY" ]; then
    echo "[cybercafe] ERROR: 云端 provision 失败: $PROV_JSON" >&2
    exit 1
fi
# 云端按请求来源下发 API 地址，优先采用
if command -v python3 >/dev/null 2>&1; then
    RESP_API="$(echo "$PROV_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_base",""))' 2>/dev/null || true)"
else
    RESP_API="$(echo "$PROV_JSON" | grep -o '"api_base":"[^"]*"' | head -1 | cut -d'"' -f4)"
fi
if [ -n "$RESP_API" ]; then API_BASE="$RESP_API"; fi

# 3) 写入配置（key + API_BASE）
cat > "$INSTALL_DIR/config.env" << EOF
API_BASE='$API_BASE'
DEVICE_KEY='$DEVICE_KEY'
BATCH_CODE='$BATCH_CODE'
MACHINE_ID='$MACHINE_ID'
EOF
chmod 600 "$INSTALL_DIR/config.env"
echo "[cybercafe] 已写入 $INSTALL_DIR/config.env（API_BASE + DEVICE_KEY）"

# 4) 安装并启动 agent
if [ -f "$INSTALL_DIR/install.sh" ]; then
    bash "$INSTALL_DIR/install.sh" --batch "$BATCH_CODE"
else
    echo "[cybercafe] 镜像未预置 install.sh，从云端拉取 ..."
    curl -fsSL "$API_BASE/install.sh?key=$DEVICE_KEY" -o "$INSTALL_DIR/install.sh"
    chmod +x "$INSTALL_DIR/install.sh"
    bash "$INSTALL_DIR/install.sh" --batch "$BATCH_CODE"
fi

# 5) 首启标记
echo "provisioned $(date -u +%Y-%m-%dT%H:%M:%SZ) batch=$BATCH_CODE machine=$MACHINE_ID" > "$MARKER"
echo "[cybercafe] ✅ 首启 provision 完成（批次 ${BATCH_CODE}，设备 ${DEVICE_KEY}）"
