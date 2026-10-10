#!/usr/bin/env bash
# docker-prep.h3.sh —— H3 模型 docker 前置（A 脚本，t106 完备化）
# 约定：每模型一个 docker-prep.<model>.sh（A=前置依赖），模型 install.sh docker 形态为 B 脚本。
# 本脚本：调 base（源/toolkit/runtime）→ H3 专属（CUDA 基座预拉 + GPU 注入校验 + 预构建
#         cybercafe-h3:0.1.0 sm_89 CUDA 镜像 + h3-weights 权重卷初始化）→ 写就绪标记。
# 幂等：基座/镜像已存在跳过构建（首次构建 10-20min，属预期）；权重卷 create 幂等。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER="/opt/cybercafe/docker-prep.h3.done"
H3_IMAGE="cybercafe-h3:0.1.0"                # 与 B 脚本（minimax-h3/install.sh t99 docker 形态）tag 对齐
H3_VOLUME="h3-weights"
CUDA_BASE="nvidia/cuda:12.1.0-devel-ubuntu22.04"

bash "$DIR/docker-prep-base.sh"

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

echo "[docker-prep.h3] 预构建 ${H3_IMAGE}（sm_89 CUDA，首次 10-20min；已存在则跳过）..."
if docker image inspect "$H3_IMAGE" >/dev/null 2>&1; then
  echo "[docker-prep.h3] ${H3_IMAGE} 已就位，跳过构建"
else
  CTX=$(mktemp -d)
  cat > "$CTX/Dockerfile" <<'DFEOF'
# CyberCafe H3 运行时镜像（t99/t106 A 脚本镜像版）
# CUDA 12.1 基底：与真机 12.2 toolchain 同代（sm_89 编译、535 驱动兼容）
FROM nvidia/cuda:12.1.0-devel-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git cmake build-essential pkg-config curl ca-certificates \
      python3 python3-pip libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN git config --global url."https://github.com".insteadOf "git@github.com:"
WORKDIR /opt
# --recursive 必需：sd.cpp 依赖 ggml 子模块（t25/t48 实测缺了 CMake 失败）
RUN git clone --depth 1 --recursive https://github.com/leejet/stable-diffusion.cpp /opt/sd.cpp
WORKDIR /opt/sd.cpp
RUN mkdir -p build && cd build \
    && cmake .. -DCMAKE_BUILD_TYPE=Release -DSD_CUDA=ON \
       -DCMAKE_CUDA_ARCHITECTURES=89 >/dev/null \
    && cmake --build . -j"$(nproc)" >/dev/null
VOLUME ["/models"]
WORKDIR /opt/sd.cpp/build/bin
EXPOSE 11435
ENTRYPOINT ["./sd-server"]
DFEOF
  if ! timeout 1800 docker build -t "$H3_IMAGE" "$CTX"; then
    echo "[docker-prep.h3] ERROR: 镜像预构建失败（见上；B 脚本将现场构建，装机动作不受阻断）" >&2
    rm -rf "$CTX"
    exit 1
  fi
  rm -rf "$CTX"
fi

echo "[docker-prep.h3] 权重卷 ${H3_VOLUME} 初始化（幂等）..."
docker volume inspect "$H3_VOLUME" >/dev/null 2>&1 || docker volume create "$H3_VOLUME"

echo "docker-prep.h3 $(date +%s) image=$H3_IMAGE volume=$H3_VOLUME" > "$MARKER"
echo "[docker-prep.h3] 就绪标记已写（$MARKER）——H3 前置完成（B 脚本直接 docker run --gpus all）"
