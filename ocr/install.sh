#!/usr/bin/env bash
# CyberCafe OCR 一键安装（RapidOCR / onnxruntime，轻量 CPU 方案）
# 用法: bash install.sh [--port <端口>] [--index <pip源>]
#   - 创建 /opt/cybercafe-ocr/{ocr.py,venv/}（venv 隔离，pip 依赖不污染系统）
#   - 模型随 rapidocr_onnxruntime pip 包内置（国内 pip 镜像源可达即可，无需额外下载权重）
#   - systemd 服务 cybercafe-ocr.service（127.0.0.1:<port>，开机自启）
# 卸载: bash uninstall.sh   （或 --keep 保留模型权重）
set -euo pipefail

OCR_DIR="/opt/cybercafe-ocr"
PORT="${OCR_PORT:-8820}"
PIP_INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
SERVICE="cybercafe-ocr"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-$PORT}"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    --index) PIP_INDEX="${2:-$PIP_INDEX}"; shift 2 ;;
    --index=*) PIP_INDEX="${1#--index=}"; shift ;;
    *) echo "未知参数: $1（支持 --port / --index）" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
    echo "[cybercafe-ocr] ERROR: 需要 root 运行" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$SCRIPT_DIR/ocr.py" ]; then
    echo "[cybercafe-ocr] ERROR: 需要与 install.sh 同目录的 ocr.py（来自仓库 ocr/）" >&2
    exit 1
fi

echo "[cybercafe-ocr] 安装开始: 目录=$OCR_DIR 端口=$PORT 源=$PIP_INDEX"
mkdir -p "$OCR_DIR"

# ---------- 1) Python venv + 依赖（国内源） ----------
if [ ! -x "$OCR_DIR/venv/bin/python" ]; then
    echo "[cybercafe-ocr] 创建 venv ..."
    python3 -m venv "$OCR_DIR/venv"
fi
echo "[cybercafe-ocr] 安装 rapidocr_onnxruntime（含内置模型）..."
"$OCR_DIR/venv/bin/pip" install --no-input -q -i "$PIP_INDEX" --upgrade rapidocr_onnxruntime

# ---------- 2) 代码 + 卸载脚本 + 文档（三件套落位） ----------
cp "$SCRIPT_DIR/ocr.py" "$OCR_DIR/ocr.py"
chmod 755 "$OCR_DIR/ocr.py"
if [ -f "$SCRIPT_DIR/uninstall.sh" ]; then
    cp "$SCRIPT_DIR/uninstall.sh" "$OCR_DIR/uninstall.sh"
    chmod 755 "$OCR_DIR/uninstall.sh"
fi
if [ -f "$SCRIPT_DIR/README.md" ]; then
    cp "$SCRIPT_DIR/README.md" "$OCR_DIR/README.md"
fi

# ---------- 3) systemd 服务（127.0.0.1:PORT，开机自启） ----------
cat > /etc/systemd/system/${SERVICE}.service << EOF
[Unit]
Description=CyberCafe OCR Service (RapidOCR)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$OCR_DIR/venv/bin/python $OCR_DIR/ocr.py --serve --port $PORT
Restart=always
RestartSec=5
Environment=OCR_PORT=$PORT
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ${SERVICE}.service

# ---------- 4) 服务就绪确认（服务 active 即安装成功；health=模型提取完成的尽力等待） ----------
echo "[cybercafe-ocr] 等待服务启动（首次运行提取模型可能较久）..."
for i in $(seq 1 30); do
    if systemctl is-active --quiet ${SERVICE}.service; then
        echo "[cybercafe-ocr] ✅ 服务已启动（systemd Restart=always 兜底）"
        for j in $(seq 1 45); do
            if curl -s --max-time 5 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
                echo "[cybercafe-ocr] ✅ 服务健康: http://127.0.0.1:$PORT/health"
                break
            fi
            sleep 2
        done
        break
    fi
    sleep 2
done
if ! systemctl is-active --quiet ${SERVICE}.service; then
    echo "[cybercafe-ocr] ⚠️ 服务未启动，请查看: journalctl -u ${SERVICE} -n 50" >&2
    exit 1
fi

echo "[cybercafe-ocr] ✅ 安装完成，使用方式："
echo "  CLI : $OCR_DIR/venv/bin/python $OCR_DIR/ocr.py <图片路径|URL>"
echo "  HTTP: curl -X POST http://127.0.0.1:$PORT/ocr -H 'Content-Type: application/json' -d '{\"url\":\"https://.../img.png\"}'"
echo "  HTTP: curl -X POST http://127.0.0.1:$PORT/ocr -d '{\"image_base64\":\"<base64>\"}'"
echo "  卸载: bash $OCR_DIR/uninstall.sh [--keep]"
