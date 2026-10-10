#!/usr/bin/env bash
# docker-prep.h3.sh —— H3 模型 docker 前置（A 脚本）
# 约定：每模型一个 docker-prep.<model>.sh（A=前置依赖），模型 install.sh docker 形态为 B 脚本。
# 本脚本：调 base（源/toolkit/runtime）→ H3 专属前置（CUDA 基座预拉 + GPU runtime 校验）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$DIR/docker-prep-base.sh"
CUDA_BASE="nvidia/cuda:12.1.0-devel-ubuntu22.04"
echo "[docker-prep.h3] 预拉 CUDA 基座 $CUDA_BASE（经镜像源，已存在则跳过）"
docker image inspect "$CUDA_BASE" >/dev/null 2>&1 \
  && echo "[docker-prep.h3] $CUDA_BASE 已就位，跳过" \
  || timeout 600 docker pull "$CUDA_BASE"
echo "[docker-prep.h3] GPU runtime 校验（--gpus all）..."
if docker run --rm --gpus all "$CUDA_BASE" nvidia-smi -L >/dev/null 2>&1; then
  echo "[docker-prep.h3] GPU 注入 OK"
else
  echo "[docker-prep.h3] ERROR: GPU 注入失败（toolkit/runtime 未就绪？）" >&2
  exit 1
fi
echo "[docker-prep.h3] 就绪：H3 前置完成（B 脚本=minimax-h3/install.sh docker 形态）"
