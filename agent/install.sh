#!/usr/bin/env bash
# CyberCafe 安装脚本（由云管理端动态注入 __API_BASE__ / __DEVICE_KEY__ 后下发）
# 用法: curl -fsSL "<云管理地址>/install.sh?key=<设备KEY>" | bash
set -euo pipefail

API_BASE="__API_BASE__"
DEVICE_KEY="__DEVICE_KEY__"
INSTALL_DIR="/opt/cybercafe"
SERVICE_NAME="cybercafe-agent"

echo "[cybercafe] 安装开始 (API=$API_BASE)"

if [ "$(id -u)" != "0" ]; then
    echo "[cybercafe] ERROR: 需要 root 运行" >&2
    exit 1
fi
# 注意：占位符拆分拼接，避免云端注入时把校验逻辑本身也替换掉
PH_KEY="__DEVICE_""KEY__"
PH_API="__API_""BASE__"
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

mkdir -p "$INSTALL_DIR"

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
    echo "[cybercafe] ✅ 安装完成，服务已启动（开机自启 + 崩溃自动重启 + 云端自更新）"
    echo "[cybercafe] 查看日志: journalctl -u ${SERVICE_NAME} -f"
else
    echo "[cybercafe] ⚠️ 服务未正常启动，请查看: journalctl -u ${SERVICE_NAME} -n 50" >&2
    exit 1
fi
