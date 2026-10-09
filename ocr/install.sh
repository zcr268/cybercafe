#!/usr/bin/env bash
# CyberCafe OCR 一键安装 —— docker 容器形态（t98：全 docker 化，替代 venv+systemd）
# 用法: bash install.sh [install|uninstall|stop|status] [--port <端口>] [--index <pip源>]
#   - 构建镜像 cybercafe-ocr:<tag>（python:3.11-slim + rapidocr-onnxruntime，国内 pip 源）
#   - docker run --restart unless-stopped，宿主暴露 <port>（OCR_PORT 默认 8820）
#   - 模型随 rapidocr_onnxruntime pip 包内置（CPU 推理，不依赖 GPU）
#   - 状态写 /opt/cybercafe-ocr/.ocr-state（agent components.ocr 读取，兼容旧标记格式）
# 停止/卸载: bash install.sh stop|uninstall（docker rm -f + rmi，零残留）
set -euo pipefail

IMAGE="cybercafe-ocr"
TAG="1.1"
CONTAINER="cybercafe-ocr"
OCR_DIR="${OCR_DIR:-/opt/cybercafe-ocr}"
PORT="${OCR_PORT:-8820}"
PIP_INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SUB=""
while [ $# -gt 0 ]; do
  case "$1" in
    install|uninstall|stop|status) SUB="$1"; shift ;;
    --port) PORT="${2:-$PORT}"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    --index) PIP_INDEX="${2:-$PIP_INDEX}"; shift 2 ;;
    --index=*) PIP_INDEX="${1#--index=}"; shift ;;
    *) break ;;
  esac
done
SUB="${SUB:-install}"

case "$SUB" in
  install)
    [ -f "$SCRIPT_DIR/ocr.py" ] || { echo "[cybercafe-ocr] ERROR: 需要与 install.sh 同目录的 ocr.py（来自仓库 ocr/）" >&2; exit 1; }
    echo "[cybercafe-ocr] docker 安装开始: 端口=$PORT 源=$PIP_INDEX"
    mkdir -p "$OCR_DIR/src"
    cp "$SCRIPT_DIR/ocr.py" "$OCR_DIR/src/ocr.py"
    # Dockerfile 内嵌（自包含，不依赖新通道白名单）；国内 pip 源 + CPU 依赖（onnxruntime 需 libgl/libgthread/libxcb）
    cat > "$OCR_DIR/src/Dockerfile" <<EOF
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglvnd0 libglx0 libglib2.0-0 libxcb1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -i $PIP_INDEX rapidocr-onnxruntime
WORKDIR /app
COPY ocr.py /app/ocr.py
EXPOSE $PORT
CMD ["python", "/app/ocr.py", "--serve", "--host", "0.0.0.0", "--port", "$PORT"]
EOF
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    # t98+migration：清 legacy 形态残留（旧 systemd 单元/旧 venv 进程仍占 8820 会致 docker -p 冲突）
    systemctl stop cybercafe-ocr.service 2>/dev/null || true
    systemctl disable cybercafe-ocr.service 2>/dev/null || true
    pkill -9 -f 'ocr.py --serve' 2>/dev/null || true
    echo "[cybercafe-ocr] 构建镜像 ${IMAGE}:${TAG} （首次较久，国内源）..."
    if ! docker build -t "$IMAGE:$TAG" "$OCR_DIR/src" >/dev/null 2>&1; then
        echo "[cybercafe-ocr] ERROR: 镜像构建失败（检查网络/磁盘）" >&2
        echo '{"state":"failed","version":"0"}' > "$OCR_DIR/.ocr-state"
        exit 1
    fi
    docker run -d --name "$CONTAINER" --restart unless-stopped -p "$PORT:$PORT" "$IMAGE:$TAG" >/dev/null
    VER=$(shasum -a 256 "$SCRIPT_DIR/ocr.py" | cut -c1-8)
    echo "{\"state\":\"installed\",\"version\":\"ocr-$VER\",\"port\":$PORT,\"mode\":\"docker\"}" > "$OCR_DIR/.ocr-state"
    echo "[cybercafe-ocr] docker 安装完成（容器 $CONTAINER / 镜像 ${IMAGE}:${TAG} / vocr-${VER} ）"
    ;;
  stop)
    echo "[cybercafe-ocr] docker stop（rm -f 容器）"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    ;;
  uninstall)
    echo "[cybercafe-ocr] docker 卸载（rm -f 容器 + rmi 镜像 + 清目录，零残留）"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker rmi -f "$IMAGE:$TAG" >/dev/null 2>&1 || true
    rm -rf "$OCR_DIR"
    ;;
  status)
    if docker inspect "$CONTAINER" >/dev/null 2>&1; then
        if [ -f "$OCR_DIR/.ocr-state" ]; then cat "$OCR_DIR/.ocr-state"; else echo '{"state":"installed","version":"docker"}'; fi
    else
        echo '{"state":"uninstalled","version":"0"}'
    fi
    ;;
esac