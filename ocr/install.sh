#!/usr/bin/env bash
# CyberCafe OCR 一键安装（RapidOCR / onnxruntime，轻量 CPU 方案）
# 用法: bash install.sh [--port <端口>] [--index <pip源>]
#   - 创建 /opt/cybercafe-ocr/{ocr.py,venv/}（venv 隔离，pip 依赖不污染系统）
#   - 模型随 rapidocr_onnxruntime pip 包内置（国内 pip 镜像源可达即可，无需额外下载权重）
#   - systemd 服务 cybercafe-ocr.service（127.0.0.1:<port>，开机自启）
# 卸载: bash uninstall.sh   （或 --keep 保留模型权重）
set -euo pipefail

OCR_DIR="${OCR_DIR:-/opt/cybercafe-ocr}"
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

# 有 systemd 时用系统服务（开机自启）；无 systemd（如开发沙箱）退化为后台进程模式
if command -v systemctl >/dev/null 2>&1; then
    HAS_SYSTEMD=1
    if [ "$(id -u)" != "0" ]; then
        echo "[cybercafe-ocr] ERROR: systemd 模式需要 root 运行（或用 OCR_DIR 指定沙箱目录）" >&2
        exit 1
    fi
else
    HAS_SYSTEMD=0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$SCRIPT_DIR/ocr.py" ]; then
    echo "[cybercafe-ocr] ERROR: 需要与 install.sh 同目录的 ocr.py（来自仓库 ocr/）" >&2
    exit 1
fi

echo "[cybercafe-ocr] 安装开始: 目录=$OCR_DIR 端口=$PORT 源=$PIP_INDEX"
mkdir -p "$OCR_DIR"

# ---------- 1) Python venv + 依赖（国内源） ----------
# venv 探针必须用 ensurepip：`python3 -c "import venv"` 在缺 python3-venv 包的真机上会假阳性
# 通过，但 `python3 -m venv` 仍因 ensurepip 缺失失败（真机 Ubuntu 24.04 实测，两台均缺包）。
if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
    echo "[cybercafe-ocr] python3-venv/ensurepip 缺失，尝试自动安装 ..."
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq || true
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv || true
    else
        echo "[cybercafe-ocr] 未找到 apt-get，跳过自动安装"
    fi
fi
if ! python3 -c "import ensurepip" >/dev/null 2>&1; then
    echo "[cybercafe-ocr] ERROR: ensurepip 仍不可用。请手动安装 python3-venv 后重跑：" >&2
    echo "    apt-get install -y python3-venv" >&2
    echo "  备选（详见 ocr/README.md）：python3 -m venv --system-site-packages 或用户级 pip（--user）" >&2
    exit 1
fi
# 双守卫：bin/python 与 bin/pip 都必须可执行。venv 创建失败会残留「有 python 无 pip」的半残
# 目录——旧守卫只看 bin/python 会误判「已就绪」、再撞不存在的 pip；此处先清残再重建保证重跑自愈。
if [ ! -x "$OCR_DIR/venv/bin/python" ] || [ ! -x "$OCR_DIR/venv/bin/pip" ]; then
    echo "[cybercafe-ocr] 创建 venv（半残残留自动清理）..."
    rm -rf "$OCR_DIR/venv"
    python3 -m venv "$OCR_DIR/venv" || true
fi
if [ ! -x "$OCR_DIR/venv/bin/pip" ]; then
    echo "[cybercafe-ocr] ERROR: venv 创建失败（$OCR_DIR/venv/bin/pip 不存在）。" >&2
    echo "  请确认 python3-venv 已安装后重跑：apt-get install -y python3-venv" >&2
    rm -rf "$OCR_DIR/venv"   # 不留半残目录，下次重跑可自愈
    exit 1
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

# ---------- 3) 服务部署（systemd 优先；无 systemd 则后台进程模式） ----------
if [ "$HAS_SYSTEMD" = "1" ]; then
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
else
    echo "[cybercafe-ocr] 无 systemd，使用后台进程模式（无开机自启，需外部安排）"
    if [ -f "$OCR_DIR/ocr.pid" ] && kill -0 "$(cat "$OCR_DIR/ocr.pid")" 2>/dev/null; then
        echo "[cybercafe-ocr] 已有运行实例 pid=$(cat "$OCR_DIR/ocr.pid")，跳过启动"
    else
        nohup "$OCR_DIR/venv/bin/python" "$OCR_DIR/ocr.py" --serve --port "$PORT" \
            >> "$OCR_DIR/ocr.log" 2>&1 &
        echo $! > "$OCR_DIR/ocr.pid"
    fi
fi

# ---------- 4) 服务就绪确认（服务 active 即安装成功；health=模型提取完成的尽力等待） ----------
echo "[cybercafe-ocr] 等待服务启动（首次运行提取模型可能较久）..."
WAITED=0
for _ in $(seq 1 30); do
    if [ "$HAS_SYSTEMD" = "1" ] && systemctl is-active --quiet ${SERVICE}.service; then
        echo "[cybercafe-ocr] ✅ 服务已启动（systemd Restart=always 兜底）"
        break
    fi
    if [ "$HAS_SYSTEMD" != "1" ] && [ -f "$OCR_DIR/ocr.pid" ] && kill -0 "$(cat "$OCR_DIR/ocr.pid")" 2>/dev/null; then
        echo "[cybercafe-ocr] ✅ 服务进程已启动（pid=$(cat "$OCR_DIR/ocr.pid")）"
        break
    fi
    sleep 2
    WAITED=$((WAITED+2))
done
OK=0
for _ in $(seq 1 45); do
    if curl -s --max-time 5 "http://127.0.0.1:$PORT/health" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
        echo "[cybercafe-ocr] ✅ 服务健康: http://127.0.0.1:$PORT/health"
        OK=1
        break
    fi
    sleep 2
done
if [ "$OK" != "1" ]; then
    echo "[cybercafe-ocr] ⚠️ 服务健康检查超时，请查看: journalctl -u ${SERVICE} -n 50 或 $OCR_DIR/ocr.log" >&2
    exit 1
fi

echo "[cybercafe-ocr] ✅ 安装完成，使用方式："
echo "  CLI : $OCR_DIR/venv/bin/python $OCR_DIR/ocr.py <图片路径|URL>"
echo "  HTTP: curl -X POST http://127.0.0.1:$PORT/ocr -H 'Content-Type: application/json' -d '{\"url\":\"https://.../img.png\"}'"
echo "  HTTP: curl -X POST http://127.0.0.1:$PORT/ocr -d '{\"image_base64\":\"<base64>\"}'"
echo "  卸载: bash $OCR_DIR/uninstall.sh [--keep]"
