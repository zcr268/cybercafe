#!/usr/bin/env bash
# docker-prep.ocr.sh —— OCR 模型 docker 前置（A 脚本）
# 约定：每模型一个 docker-prep.<model>.sh（A=前置依赖），模型 install.sh docker 形态为 B 脚本。
# 本脚本：调 base（源/toolkit/runtime）→ OCR 专属前置（python 基座预拉，CPU 方案无需 GPU）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$DIR/docker-prep-base.sh"
echo "[docker-prep.ocr] 预拉 OCR 基座 python:3.11-slim（已存在则跳过）"
docker image inspect python:3.11-slim >/dev/null 2>&1 \
  && echo "[docker-prep.ocr] python:3.11-slim 已就位，跳过" \
  || timeout 300 docker pull python:3.11-slim
echo "[docker-prep.ocr] 就绪：OCR 前置完成（B 脚本=ocr/install.sh docker 形态）"
