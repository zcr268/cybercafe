#!/usr/bin/env bash
# CyberCafe OCR 一键卸载 —— docker 容器形态（t98）
# 用法: bash uninstall.sh [--yes]（--yes 为接口兼容参数；本脚本无交互确认）
#   停容器（docker rm -f cybercafe-ocr）+ 删镜像（docker rmi -f cybercafe-ocr:1.1）
#   + 清 /opt/cybercafe-ocr（含 src/Dockerfile、.ocr-state 与旧 venv 残留）——零残留
set -uo pipefail

OCR_DIR="${OCR_DIR:-/opt/cybercafe-ocr}"
CONTAINER="${CONTAINER:-cybercafe-ocr}"
IMAGE="${IMAGE:-cybercafe-ocr:1.1}"

for arg in "$@"; do
  case "$arg" in
    --yes|--keep) : ;;   # --keep 为兼容参数（docker 形态无 venv 可留；接受即忽略）
    *) echo "未知参数: $arg（支持 --yes / --keep）" >&2; exit 1 ;;
  esac
done

echo "[cybercafe-ocr] docker 卸载：rm -f 容器 + rmi 镜像 + 清目录（零残留）"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
rm -rf "$OCR_DIR"
echo "[cybercafe-ocr] ✅ 卸载完成（无容器/无镜像/无目录残留）"
