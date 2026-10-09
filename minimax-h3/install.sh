#!/usr/bin/env bash
# =============================================================================
# CyberCafe MiniMax-H3 本地部署脚本（install.sh）—— docker 容器形态（t99）
# -----------------------------------------------------------------------------
# 规格核实结论（2026-10-08，t25）：
#   MiniMax H3 = omni-modal 视频+音频生成系统（注意：非聊天 LLM，无 chat 端点）
#   - 架构：H3-Omni-Transformer 33B dense（~13B 为 AdaLN 分支，推理可省）+
#           H3-Encoder = Qwen3-VL-32B（取第 50 层 hidden）+ VisualVAE(f16t4d24) +
#           AudioVAE(40Hz) + MM-RoPE；官方 BF16 safetensors（SGLang 推荐 4×GPU）
#   - 许可：MiniMax H3 Community License（见 HF 仓库 LICENSE）
#   - 本机最小档（RTX 4080 SUPER 16GB / 31.2GB 内存）——sd.cpp 兼容 GGUF 源：
#       扩散主模型  unsloth/MiniMax-H3-GGUF  minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf  8.06GB
#       文本编码器  unsloth/MiniMax-H3-GGUF  qwen3vl_32b_minimax_h3-Q2_K_M.gguf  13.1GB
#       视频 VAE    Comfy-Org/MiniMax-H3     vae/minimax_h3_video_vae_fp16.safetensors  5.2GB
#       音频 VAE    Comfy-Org/MiniMax-H3     vae/minimax_h3_audio_vae_fp32.safetensors  0.6GB
#       ⚠️ Abiray/MiniMax-H3-Pruned-GGUF 为 ComfyUI-GGUF 布局，sd.cpp 加载报
#          model metadata validation failed（t48 真机实测），本脚本不使用
#   - 运行时：stable-diffusion.cpp（leejet，Day-1 支持 MiniMax-H3，GGUF 原生）
#   - docker 形态（t99）：CUDA 编译进 Dockerfile（nvidia/cuda:12.1.0-devel ←
#       与真机 12.2 toolchain 同代、sm_89 编译、驱动 535 兼容，vLLM/SGLang 同基底先例），
#       权重命名卷 h3-weights 持久化（重装不重下载 ~27GB），docker run --gpus all（CDI
#       已验证 535 可用）暴露 11435；镜像与旧 build 纳入磁盘 LRU 回收（权重卷属当前
#       部署保护，非当前才可回收——回收由 agent 侧统一管理）。
#   - 端口：sd-server 容器内 11435 映射宿主 127.0.0.1:11435（避开 11434），
#           nginx 网关不变；兼容 /v1/models 与 OpenAI API 形态，外部可再套 Key 网关。
#   - GPU 放置语义（重要，勿误读日志，t55 澄清）：
#       容器启动参数固定 --backend "te=cpu,vae=cuda0,diffusion=cuda0" --offload-to-cpu。
#       在该配置下，sd.cpp 日志 "total params memory size = ... (VRAM 0.00MB, RAM ...)" 中
#       text_encoders ...(RAM) 表示【文本编码器参数常驻系统 RAM】（te=cpu 的预期行为），
#       VRAM 0.00MB 只统计"参数驻留显存"，不代表 GPU 未参与计算；
#       denoiser/VAE 参数在 --offload-to-cpu 下同样先驻 RAM、计算时按段流式上 cuda0，
#       GPU 真实使用以 NVML 采样为据（t48 真机实测：峰值显存 8.99GB、利用率 100%）。
#       源码依据（leejet/stable-diffusion.cpp src/pipeline/diffusion_engine.cpp）：
#         L1316  return sd_backend_is_cpu(module_backend) ? "RAM" : "VRAM";
#         L1329  "total params memory size = %.2fMB (VRAM %.2fMB, RAM %.2fMB): ..."
#       —— 组件标签按 params_backend 是否 CPU 后端返回 "RAM"/"VRAM"，
#          te=cpu → "RAM"（参数在 RAM），diffusion/vae=cuda0 运行时流式上卡。
# -----------------------------------------------------------------------------
# 用法:  bash install.sh            # 默认档（UD-Q2_K_XL，docker build+run）
#        H3_QUANT=Q4_K_M bash install.sh   # 16GB 卡推荐平衡档（11.4GB denoiser）
#        H3_QUANT=Q5_0 bash install.sh     # 可选更高档（13.0GB denoiser）
#        H3_QUANT=UD-Q3_K_XL bash install.sh # 可选（8.9GB，质量/速度均衡）
#        bash install.sh status     # 状态（读 .version；未安装→uninstalled）
#        bash install.sh start      # 启动容器（需已安装；写 .version state=running）
#        bash install.sh stop       # 停止容器（docker rm -f；写 .version state=installed）
#        bash install.sh uninstall  # 卸载（docker rm -f + rmi + 清目录；权重卷保留待回收）
# =============================================================================
set -euo pipefail

# ------------------------- 配置 -------------------------
H3_ROOT="${H3_ROOT:-/opt/minimax-h3}"          # 状态/脚本目录（权重在命名卷内）
H3_QUANT="${H3_QUANT:-UD-Q2_K_XL}"             # 默认档：unsloth UD-Q2_K_XL（sd.cpp 兼容，t48 实测 Abiray Q3_K_M 为 ComfyUI 布局不兼容）
H3_PORT="${H3_PORT:-11435}"                    # 宿主暴露端口（容器内 11435）
H3_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"   # 国内镜像优先
H3_IMAGE="cybercafe-h3"                        # 镜像名（磁盘 LRU 回收对象）
H3_TAG="0.1.0"                                 # 镜像 tag
H3_CONTAINER="cybercafe-h3"                    # 容器名（互斥/回收按此）
H3_VOLUME="h3-weights"                         # 权重命名卷（重装不重下载）
H3_VERSION_FILE="$H3_ROOT/.version"            # 组件状态标记（t74：agent 心跳 components.h3 读它）

say()  { printf '\033[1;34m[h3]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[h3 ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------- 常用函数 -------------------------
h3_write_version() {  # h3_write_version <state> [version]
  local st="$1"
  local ver="${2:-$H3_TAG}"
  printf '{"state":"%s","version":"%s","quant":"%s","mode":"docker","ts":%s}\n' \
         "$st" "$ver" "${H3_QUANT}" "$(date +%s)" > "$H3_VERSION_FILE"
}

h3_diff_name() {  # h3_diff_name <quant> -> stdout 权重文件名
  case "$1" in
    UD-Q2_K_XL) echo "minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf" ;;
    UD-Q3_K_XL) echo "minimax_h3_fl2va_pruned-UD-Q3_K_XL.gguf" ;;
    Q4_K_M)     echo "minimax_h3_fl2va_pruned-Q4_K.gguf" ;;
    Q5_0)       echo "minimax_h3_fl2va_pruned-Q5_0.gguf" ;;
    *) die "未知 H3_QUANT=$1" ;;
  esac
}

h3_run_server() {  # h3_run_server <diff_name>：docker run --gpus all（te=cpu / denoiser+VAE cuda0）
  docker run -d --name "$H3_CONTAINER" --gpus all --restart unless-stopped \
    -p "127.0.0.1:$H3_PORT:11435" \
    -v "$H3_VOLUME:/models" \
    -e H3_QUANT="$H3_QUANT" \
    "$H3_IMAGE:$H3_TAG" \
    sd-server \
      --diffusion-model "/models/$1" \
      --vae "/models/minimax_h3_video_vae_fp16.safetensors" \
      --audio-vae "/models/minimax_h3_audio_vae_fp32.safetensors" \
      --llm "/models/qwen3vl_32b_minimax_h3-Q2_K_M.gguf" \
      --backend "te=cpu,vae=cuda0,diffusion=cuda0" --offload-to-cpu \
      --diffusion-fa --cfg-scale 1.0 \
      --listen-ip 0.0.0.0 --listen-port 11435
}

h3_wait_ready() {  # 轮询 /v1/models 200（容器冷启动含权重加载，最长 4 分钟）
  local code=""
  for _ in $(seq 1 120); do
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:$H3_PORT/v1/models" || true)
    [ "$code" = 200 ] && break
    sleep 2
  done
  [ "$code" = 200 ]
}

# ------------------------- 子命令（t74：页面安装/卸载后的启停与状态查询；t99 容器化） -------------------------
H3_CMD="${1:-}"

if [ "$H3_CMD" = "status" ]; then
  if [ -f "$H3_VERSION_FILE" ]; then cat "$H3_VERSION_FILE"; else echo '{"state":"uninstalled"}'; fi
  exit 0
fi
if [ "$H3_CMD" = "start" ]; then
  [ -f "$H3_VERSION_FILE" ] || { echo '{"state":"uninstalled"}' >&2; exit 1; }
  if [ "$(docker inspect -f '{{.State.Running}}' "$H3_CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
    h3_run_server "$(h3_diff_name "$H3_QUANT")" > /dev/null 2>&1 || true   # 失败继续（走下方就绪检查→failed 标记）
  fi
  # 容器未起来（docker run 失败/镜像缺失）→ 快速失败标记，不空转 4 分钟
  if [ "$(docker inspect -f '{{.State.Running}}' "$H3_CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
    h3_write_version "failed"
    echo '{"state":"failed","error":"sd-server 容器未运行（docker run 失败/镜像缺失，docker logs cybercafe-h3）"}' >&2
    exit 1
  fi
  if h3_wait_ready; then
    h3_write_version "running"
    echo "{\"state\":\"running\",\"version\":\"$H3_TAG\",\"mode\":\"docker\"}"
    exit 0
  fi
  # t85 F2 语义：启动失败如实标记失败态（页面不残留 running/installed 假象）
  h3_write_version "failed"
  echo '{"state":"failed","error":"sd-server 容器启动未就绪（docker logs cybercafe-h3）"}' >&2
  exit 1
fi
if [ "$H3_CMD" = "stop" ]; then
  [ -f "$H3_VERSION_FILE" ] || { echo '{"state":"uninstalled"}' >&2; exit 1; }
  docker rm -f "$H3_CONTAINER" >/dev/null 2>&1 || true
  sleep 1
  h3_write_version "installed"
  echo "{\"state\":\"installed\",\"version\":\"$H3_TAG\",\"mode\":\"docker\"}"
  exit 0
fi
if [ "$H3_CMD" = "uninstall" ]; then
  docker rm -f "$H3_CONTAINER" >/dev/null 2>&1 || true
  docker rmi -f "$H3_IMAGE:$H3_TAG" >/dev/null 2>&1 || true
  # 权重卷保留（磁盘 LRU 回收管理，t97 语义：当前部署保护、非当前可回收）
  rm -rf "$H3_ROOT"
  echo '{"state":"uninstalled"}'
  exit 0
fi

# ------------------------- 0. 环境预检 -------------------------
say "=== MiniMax-H3 docker 部署（v$H3_TAG，档位 ${H3_QUANT}，root=${H3_ROOT}）==="
[ "$(id -u)" = 0 ] || die "请以 root 运行（sudo bash install.sh）"
have docker || die "缺少 docker（先装 docker）"
docker info >/dev/null 2>&1 || die "docker daemon 不可用"

# 磁盘（~29GB 权重 + 镜像 + 编译缓存，要求 >=50GB 可用）
avail_kb=$(df -B1 --output=avail / | tail -1 | tr -d ' ')
avail_gb=$((avail_kb / 1024 / 1024 / 1024))
[ "$avail_gb" -ge 50 ] || die "磁盘可用不足（$avail_gb GB < 50GB），无法容纳 ~29GB 权重 + 镜像"

mkdir -p "$H3_ROOT"

# ------------------------- 1. 构建 H3 镜像（CUDA 编译 sd.cpp 进 Dockerfile） -------------------------
say "=== 构建镜像 ${H3_IMAGE}:${H3_TAG}（CUDA 编译 sd.cpp，首次约 10-20 分钟）==="
if ! docker image inspect "$H3_IMAGE:$H3_TAG" >/dev/null 2>&1; then
  mkdir -p "$H3_ROOT/docker"
  cat > "$H3_ROOT/docker/Dockerfile" <<'DOCKEREOF'
# CyberCafe H3 运行时镜像（t99）
# CUDA 12.1 基底：与真机 12.2 toolchain 同代（sm_89 编译、535 驱动兼容，vLLM/SGLang 同基底先例）
FROM nvidia/cuda:12.1.0-devel-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git cmake build-essential pkg-config curl ca-certificates \
      python3 python3-pip libglib2.0-0 && rm -rf /var/lib/apt/lists/*
# 国内构建加速：CUDA 12.1 基底镜像源（aliyun 出口可达；HF 权重运行时 hf-mirror 拉取）
RUN git config --global url."https://github.com".insteadOf "git@github.com:"
WORKDIR /opt
# --recursive 必需：sd.cpp 依赖 ggml 子模块（t25/t48 实测缺了 CMake 失败）
RUN git clone --depth 1 --recursive https://github.com/leejet/stable-diffusion.cpp /opt/sd.cpp
WORKDIR /opt/sd.cpp
RUN mkdir -p build && cd build \
    && cmake .. -DCMAKE_BUILD_TYPE=Release -DSD_CUDA=ON \
       -DCMAKE_CUDA_ARCHITECTURES=89 >/dev/null \
    && cmake --build . -j"$(nproc)" >/dev/null
# 权重不在镜像内：运行时经命名卷挂载 /models（27GB 重装不重下载、镜像层瘦）
VOLUME ["/models"]
WORKDIR /opt/sd.cpp/build/bin
EXPOSE 11435
ENTRYPOINT ["./sd-server"]
DOCKEREOF
  if ! docker build -t "$H3_IMAGE:$H3_TAG" "$H3_ROOT/docker" > /tmp/h3-docker-build.log 2>&1; then
    tail -25 /tmp/h3-docker-build.log >&2
    h3_write_version "failed"
    die "H3 镜像构建失败（见 /tmp/h3-docker-build.log）"
  fi
fi
say "镜像就绪: ${H3_IMAGE}:${H3_TAG}"

# ------------------------- 2. 权重卷（h3-weights）持久化初始化 -------------------------
say "=== 权重卷 $H3_VOLUME 初始化（hf-mirror，~29GB；已存在则跳过下载）==="
# 用一次性容器把权重下载到命名卷（dl .src 守卫：换仓库/换档/来源不符才重下，t48 修复语义）
docker volume inspect "$H3_VOLUME" >/dev/null 2>&1 || docker volume create "$H3_VOLUME" >/dev/null
DIFF_NAME="$(h3_diff_name "$H3_QUANT")"
if ! docker run --rm --name h3-downloader \
     -v "$H3_VOLUME:/models" \
     -e H3_ENDPOINT="$H3_ENDPOINT" \
     -e H3_QUANT="$H3_QUANT" \
     --entrypoint /bin/bash \
     "$H3_IMAGE:$H3_TAG" -c '
set -euo pipefail
MODELS=/models
case "$H3_QUANT" in
  UD-Q2_K_XL) DIFF_REPO="unsloth/MiniMax-H3-GGUF"; DIFF_FILE="minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf" ;;
  UD-Q3_K_XL) DIFF_REPO="unsloth/MiniMax-H3-GGUF"; DIFF_FILE="minimax_h3_fl2va_pruned-UD-Q3_K_XL.gguf" ;;
  Q4_K_M)     DIFF_REPO="unsloth/MiniMax-H3-GGUF"; DIFF_FILE="minimax_h3_fl2va_pruned-Q4_K.gguf" ;;
  Q5_0)       DIFF_REPO="unsloth/MiniMax-H3-GGUF"; DIFF_FILE="minimax_h3_fl2va_pruned-Q5_0.gguf" ;;
  *) echo "未知 H3_QUANT=$H3_QUANT" >&2; exit 1 ;;
esac
dl() {
  local url="$H3_ENDPOINT/$1/resolve/main/$2"
  local dest="$MODELS/$(basename "$2")"
  local srcfile="$dest.src"
  if [ ! -f "$dest" ] || [ -f "$srcfile" ] && [ "$(cat "$srcfile" 2>/dev/null)" != "$url" ]; then
    echo "下载 $(basename "$2") ..."
    curl -fL --retry 5 --retry-delay 3 -C - -o "$dest" "$url"
    echo "$url" > "$srcfile"
  elif [ ! -f "$srcfile" ]; then
    echo "旧版残留（无来源记录），重下 $(basename "$2") ..."
    curl -fL --retry 5 --retry-delay 3 -C - -o "$dest" "$url"
    echo "$url" > "$srcfile"
  fi
}
dl "$DIFF_REPO" "$DIFF_FILE"
dl "unsloth/MiniMax-H3-GGUF" "qwen3vl_32b_minimax_h3-Q2_K_M.gguf"
dl "Comfy-Org/MiniMax-H3" "vae/minimax_h3_video_vae_fp16.safetensors"
dl "Comfy-Org/MiniMax-H3" "vae/minimax_h3_audio_vae_fp32.safetensors"
echo "权重就绪"
' > /tmp/h3-weights-init.log 2>&1; then
  tail -12 /tmp/h3-weights-init.log >&2
  h3_write_version "failed"
  die "权重卷初始化失败（见 /tmp/h3-weights-init.log）"
fi
say "权重卷就绪: ${H3_VOLUME}（$(docker run --rm -v "$H3_VOLUME:/models" --entrypoint du "$H3_IMAGE:$H3_TAG" -sh /models 2>/dev/null | awk '{print $1}')）"

# ------------------------- 3. 启动容器（--gpus all，暴露 11435） -------------------------
say "=== 启动 ${H3_CONTAINER}（--gpus all，127.0.0.1:${H3_PORT} → 容器 11435）==="
docker rm -f "$H3_CONTAINER" >/dev/null 2>&1 || true
if ! h3_run_server "$DIFF_NAME" > /dev/null 2>&1; then
  docker logs "$H3_CONTAINER" 2>&1 | tail -15 >&2 || true
  h3_write_version "failed"
  die "H3 容器启动失败（docker logs $H3_CONTAINER）"
fi
if ! h3_wait_ready; then
  docker logs "$H3_CONTAINER" 2>&1 | tail -15 >&2 || true
  h3_write_version "failed"
  die "sd-server 未就绪（HTTP 超时），见 docker logs $H3_CONTAINER"
fi
say "sd-server 就绪: http://127.0.0.1:${H3_PORT}/v1/models → 200"
h3_write_version "running"

# 卸载脚本落位：uninstall-all.sh 的 SUB_UNINSTALLS 固定引用 /opt/minimax-h3/uninstall.sh（t28 约定）
SCRIPT_SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_SELF")"
if [ -f "$SCRIPT_DIR/uninstall.sh" ]; then
  cp -f "$SCRIPT_DIR/uninstall.sh" "$H3_ROOT/uninstall.sh"
  chmod +x "$H3_ROOT/uninstall.sh"
elif [ -f /root/h3-delivery/uninstall.sh ]; then
  cp -f /root/h3-delivery/uninstall.sh "$H3_ROOT/uninstall.sh"
  chmod +x "$H3_ROOT/uninstall.sh"
fi

say "=== 安装完成 ==="
say "HTTP:     http://127.0.0.1:${H3_PORT}/v1/models"
say "容器:     ${H3_CONTAINER}（镜像 ${H3_IMAGE}:${H3_TAG}）"
say "权重卷:   ${H3_VOLUME}（重装不重下载；当前部署保护，非当前可回收）"
say "卸载:     bash install.sh uninstall 或 bash uninstall.sh（docker rm -f + rmi）"