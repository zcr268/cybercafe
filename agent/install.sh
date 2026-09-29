#!/usr/bin/env bash
# CyberCafe 安装脚本（由云管理端动态注入 __API_BASE__ / __DEVICE_KEY__ 后下发）
# 用法:
#   单机模式: curl -fsSL "<云管理地址>/install.sh?key=<设备KEY>" | bash
#   批次模式（基础镜像批量装机）: bash install.sh --batch <批次码>   （或环境变量 PROVISION_CODE）
#     批次模式下 API 地址取 PROVISION_API_BASE 环境变量 / /etc/cybercafe/api_base /
#     provision.sh 已写入的 /opt/cybercafe/config.env；设备密钥由云端 /api/device/provision 颁发
set -euo pipefail

API_BASE="__API_BASE__"
DEVICE_KEY="__DEVICE_KEY__"
INSTALL_DIR="/opt/cybercafe"
SERVICE_NAME="cybercafe-agent"
BATCH_CODE="${PROVISION_CODE:-}"

# 批次码参数: --batch <code> 或 --batch=<code>
while [ $# -gt 0 ]; do
  case "$1" in
    --batch) BATCH_CODE="${2:-}"; shift 2 ;;
    --batch=*) BATCH_CODE="${1#--batch=}"; shift ;;
    *) echo "[cybercafe] ERROR: 未知参数: $1（支持 --batch <批次码>）" >&2; exit 1 ;;
  esac
done

echo "[cybercafe] 安装开始 (API=$API_BASE)"

if [ "$(id -u)" != "0" ]; then
    echo "[cybercafe] ERROR: 需要 root 运行" >&2
    exit 1
fi
# 注意：占位符拆分拼接，避免云端注入时把校验逻辑本身也替换掉
PH_KEY="__DEVICE_""KEY__"
PH_API="__API_""BASE__"

mkdir -p "$INSTALL_DIR"

# 批次模式：从 config.env（provision.sh 已写）或云端 provision API 取得 API_BASE/DEVICE_KEY
if [ -n "$BATCH_CODE" ]; then
    echo "[cybercafe] 批次模式: batch=$BATCH_CODE"
    if [ -f "$INSTALL_DIR/config.env" ]; then . "$INSTALL_DIR/config.env"; fi
    if [ -z "${API_BASE:-}" ] || [ "$API_BASE" = "$PH_API" ]; then
        API_BASE="${PROVISION_API_BASE:-}"
        if [ -f /etc/cybercafe/api_base ]; then API_BASE="$(head -1 /etc/cybercafe/api_base)"; fi
    fi
    if [ -z "$API_BASE" ] || [ "$API_BASE" = "$PH_API" ]; then
        echo "[cybercafe] ERROR: 批次模式需要 API 地址（PROVISION_API_BASE 或 /etc/cybercafe/api_base）" >&2
        exit 1
    fi
    if [ -z "${DEVICE_KEY:-}" ] || [ "$DEVICE_KEY" = "$PH_KEY" ]; then
        MACHINE_ID="$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo "unknown-$(hostname)")"
        echo "[cybercafe] 向云端申请设备密钥 (machine=$MACHINE_ID) ..."
        PROV_JSON="$(curl -sS --max-time 60 -X POST "$API_BASE/api/device/provision" \
            -H "Content-Type: application/json" \
            -d "{\"batch_code\":\"$BATCH_CODE\",\"machine_id\":\"$MACHINE_ID\",\"device\":{\"hostname\":\"$(hostname | tr -d '"')\",\"os\":\"$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' | head -1)\"}}" 2>&1 || true)"
        DEVICE_KEY="$(echo "$PROV_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("device_key",""))' 2>/dev/null || true)"
        [ -z "$DEVICE_KEY" ] && { echo "[cybercafe] ERROR: 批次申请密钥失败: $PROV_JSON" >&2; exit 1; }
        RESP_API="$(echo "$PROV_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_base",""))' 2>/dev/null || true)"
        [ -n "$RESP_API" ] && API_BASE="$RESP_API"
    fi
    MACHINE_ID="${MACHINE_ID:-$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo "unknown-$(hostname)")}"
fi

if [ -z "$DEVICE_KEY" ] || [ "$DEVICE_KEY" = "$PH_KEY" ] || [ "$API_BASE" = "$PH_API" ]; then
    echo "[cybercafe] ERROR: 参数未注入，请从云管理端复制完整安装命令" >&2
    exit 1
fi

# 依赖：python3 + curl
need_apt=0
command -v python3 >/dev/null 2>&1 || need_apt=1
command -v curl   >/dev/null 2>&1 || need_apt=1
if [ "$need_apt" = "1" ]; then
    echo "[cybercafe] 安装依赖 python3/curl ..."
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 curl
fi

echo "[cybercafe] 从云管理端拉取最新控制脚本 ..."
curl -fsSL -H "X-Device-Key: $DEVICE_KEY" "$API_BASE/api/agent/latest" -o "$INSTALL_DIR/cybercafe-agent.py"
chmod +x "$INSTALL_DIR/cybercafe-agent.py"

AGENT_VER=$(grep -m1 '^VERSION = ' "$INSTALL_DIR/cybercafe-agent.py" | cut -d'"' -f2)
echo "[cybercafe] 控制脚本版本: $AGENT_VER"

cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=CyberCafe Local Control Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $INSTALL_DIR/cybercafe-agent.py
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ${SERVICE_NAME}.service

sleep 3
if systemctl is-active --quiet ${SERVICE_NAME}.service; then
    if [ -n "$BATCH_CODE" ]; then
        # 持久化配置 + 首启标记（provision.sh / 重复 install 复用，防重复注册）
        cat > "$INSTALL_DIR/config.env" << EOF
API_BASE='$API_BASE'
DEVICE_KEY='$DEVICE_KEY'
BATCH_CODE='$BATCH_CODE'
MACHINE_ID='$MACHINE_ID'
EOF
        chmod 600 "$INSTALL_DIR/config.env"
        echo "provisioned $(date -u +%Y-%m-%dT%H:%M:%SZ) batch=$BATCH_CODE machine=$MACHINE_ID" > "$INSTALL_DIR/.provisioned"
        echo "[cybercafe] ✅ 批次注册完成（.provisioned 已写入，防止重复注册）"
    fi
    echo "[cybercafe] ✅ 安装完成，服务已启动（开机自启 + 崩溃自动重启 + 云端自更新）"
    echo "[cybercafe] 查看日志: journalctl -u ${SERVICE_NAME} -f"
else
    echo "[cybercafe] ⚠️ 服务未正常启动，请查看: journalctl -u ${SERVICE_NAME} -n 50" >&2
    exit 1
fi
