#!/usr/bin/env bash
# =============================================================================
# CyberCafe MiniMax-H3 本地部署脚本（install.sh）
# -----------------------------------------------------------------------------
# 规格核实结论（2026-10-08）：
#   MiniMax H3 = omni-modal 视频+音频生成系统（注意：非聊天 LLM，无 chat 端点）
#   - 架构：H3-Omni-Transformer 33B dense（~13B 为 AdaLN 分支，推理可省）+
#           H3-Encoder = Qwen3-VL-32B（取第 50 层 hidden）+ VisualVAE(f16t4d24) +
#           AudioVAE(40Hz) + MM-RoPE；官方 BF16 safetensors（SGLang 推荐 4×GPU）
#   - 许可：MiniMax H3 Community License（见 HF 仓库 LICENSE）
#   - 本机最小档（RTX 4080 SUPER 16GB / 31.2GB 内存）：
#       扩散主模型  Abiray/MiniMax-H3-Pruned-GGUF  MiniMax-H3-FL2VA-Pruned-Q3_K_M.gguf  8.9GB
#       文本编码器  Abiray/MiniMax-H3-GGUF         text_encoders/qwen3vl_32b_minimax_h3-Q4_K_M.gguf  14.6GB
#       视频 VAE    Abiray/MiniMax-H3-GGUF         vae/minimax_h3_video_vae_fp16.safetensors  5.2GB
#       音频 VAE    Abiray/MiniMax-H3-GGUF         vae/minimax_h3_audio_vae_fp32.safetensors  0.6GB
#   - 运行时：stable-diffusion.cpp（leejet，Day-1 支持 MiniMax-H3，GGUF 原生）
#   - 端口：sd-server 独立端口 11435（避开 ollama/vllm/sglang/strata 共用的 11434），
#           nginx 网关不变；兼容 /v1/models 与 OpenAI API 形态，外部可再套 Key 网关。
# -----------------------------------------------------------------------------
# 用法:  bash install.sh            # 默认档（Q3_K_M pruned 最小档）
#        H3_QUANT=Q4_K_M bash install.sh   # 更高档（11.6GB，16GB 卡推荐平衡档）
#        H3_SERVER=0 bash install.sh # 只装模型+CLI 验证，不常驻 HTTP 服务
# 卸载:  bash uninstall.sh
# =============================================================================
set -euo pipefail

# ------------------------- 配置 -------------------------
H3_ROOT="${H3_ROOT:-/opt/minimax-h3}"          # 全部内容收敛此目录（卸载=删此目录）
H3_QUANT="${H3_QUANT:-Q3_K_M}"                 # 最小档；可选 Q4_K_M/Q4_K_S/Q5_K_M
H3_SERVER="${H3_SERVER:-1}"                    # 1=常驻 sd-server(11435)，0=CLI 验证
H3_PORT="${H3_PORT:-11435}"                    # 独立端口，避开 11434
H3_DIFF_REPO="Abiray/MiniMax-H3-Pruned-GGUF"   # 扩散主模型（pruned，消费卡）
H3_AUX_REPO="Abiray/MiniMax-H3-GGUF"           # text encoder + VAE
H3_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"   # 国内镜像优先
SDCPP_DIR="$H3_ROOT/sd.cpp"
MODELS_DIR="$H3_ROOT/models"
LOG="$H3_ROOT/install.log"
GCC_ISO="/root/.cybercafe-gcc12"               # 与 strata 相同的 gcc-12 隔离目录（避免污染系统 gcc）

say()  { printf '\033[1;34m[h3]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[h3 ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

mkdir -p "$H3_ROOT" "$MODELS_DIR"
exec > >(tee -a "$LOG") 2>&1

# ------------------------- 0. 环境预检 -------------------------
say "=== MiniMax-H3 部署（v0.1，档位 ${H3_QUANT}，root=${H3_ROOT}）==="
[ "$(id -u)" = 0 ] || die "请以 root 运行（sudo bash install.sh）"

# 磁盘（~29GB 权重 + 编译产物，要求 >=40GB 可用）
avail_kb=$(df -B1 --output=avail / | tail -1 | tr -d ' ')
avail_gb=$((avail_kb / 1024 / 1024 / 1024))
[ "$avail_gb" -ge 40 ] || die "磁盘可用不足（$avail_gb GB < 40GB），无法容纳 ~29GB 权重"

# 内存（Q4 文本编码器 14.6GB + 扩散 8.9GB offload + VAE，要求 >=24GB）
mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
mem_gb=$((mem_kb / 1024 / 1024))
[ "$mem_gb" -ge 24 ] || die "内存不足（${mem_gb}GB < 24GB），31GB 目标机可过"

# ------------------------- 1. 依赖与编译工具链 -------------------------
say "=== 依赖: git/cmake/build-essential/pkg-config ==="
DEPS="git cmake build-essential pkg-config"
for d in git cmake g++ pkg-config; do have "$d" || { need_apt=1; break; }; done
if [ "${need_apt:-}" = 1 ]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $DEPS
fi

# CUDA toolkit 预检 + nvcc/gcc 兼容（t23 教训：CUDA 12.x 只支持宿主 gcc<=12，
# 目标机 Ubuntu 24.04 默认 gcc 13.3 → 需 gcc-12 隔离注入，否则 CMake enable_language(CUDA) 失败）
CUDA_ENV=""
if [ -x /usr/local/cuda/bin/nvcc ]; then CUDA_ENV="PATH=/usr/local/cuda/bin:$PATH LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH";
elif [ -x /usr/local/cuda-12.2/bin/nvcc ]; then CUDA_ENV="PATH=/usr/local/cuda-12.2/bin:$PATH LD_LIBRARY_PATH=/usr/local/cuda-12.2/lib64:$LD_LIBRARY_PATH";
fi
[ -n "$CUDA_ENV" ] || die "未找到 CUDA toolkit（/usr/local/cuda*）——需先装 CUDA 12.x/13.x（sudo apt install nvidia-cuda-toolkit 或 developer.nvidia.com）"

nvcc_v=$(env $CUDA_ENV nvcc --version | grep -oE 'release [0-9]+\.[0-9]+' | head -1 | awk '{print $2}')
cuda_major="${nvcc_v%%.*}"
gcc_v=$(gcc --version | head -1 | grep -oE '[0-9]+' | head -1)
gcc_limit=$(( cuda_major < 13 ? 12 : 13 ))
say "nvcc $nvcc_v（CUDA 主版本 ${cuda_major}）→ 宿主 gcc 上限 $gcc_limit；当前 gcc $gcc_v"
if [ "$gcc_v" -gt "$gcc_limit" ]; then
  say "安装 gcc-$gcc_limit / g++-$gcc_limit 并隔离注入 PATH（不切换系统默认）..."
  have "gcc-$gcc_limit" || { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "gcc-$gcc_limit" "g++-$gcc_limit"; }
  mkdir -p "$GCC_ISO"
  for n in gcc g++ cc c++; do
    [ -e "$GCC_ISO/$n" ] || ln -sf "$(command -v "$n-$gcc_limit" || echo /usr/bin/$n-$gcc_limit)" "$GCC_ISO/$n"
  done
  CUDA_ENV="PATH=$GCC_ISO:$CUDA_ENV"
fi

# ------------------------- 2. 克隆并编译 stable-diffusion.cpp -------------------------
say "=== 编译 stable-diffusion.cpp（CUDA 版，约 10-20 分钟）==="
if [ ! -d "$SDCPP_DIR/.git" ]; then
  git clone --depth 1 https://github.com/leejet/stable-diffusion.cpp "$SDCPP_DIR"
fi
cd "$SDCPP_DIR"
mkdir -p build && cd build
if [ ! -f bin/sd-cli ]; then
  env $CUDA_ENV cmake .. -DCMAKE_BUILD_TYPE=Release -DSD_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 >/dev/null
  env $CUDA_ENV cmake --build . -j"$(nproc)" >/dev/null
fi
[ -x bin/sd-cli ] || die "sd-cli 编译失败，见 $LOG"
[ "$H3_SERVER" = 1 ] && { [ -x bin/sd-server ] || die "sd-server 编译失败"; }
say "sd-cli/sd-server 就绪"

# ------------------------- 3. 下载权重（hf-mirror，~29GB） -------------------------
say "=== 下载权重（HF_ENDPOINT=${H3_ENDPOINT}，约 29GB，按需续传）==="
dl() { # dl <repo> <subpath> <destname>
  local url="$H3_ENDPOINT/$1/resolve/main/$2"
  local dest="$MODELS_DIR/$3"
  if [ ! -f "$dest" ] || [ "$(stat -c%s "$dest" 2>/dev/null || echo 0)" -lt 1000000 ]; then
    say "下载 $3 ..."
    curl -fL --retry 5 --retry-delay 3 -C - -o "$dest" "$url" || die "下载失败: $url"
  fi
  say "  就绪 $3 ($(du -h "$dest" | cut -f1))"
}
case "$H3_QUANT" in
  Q3_K_M) DIFF_FILE="MiniMax-H3-FL2VA-Pruned-Q3_K_M.gguf" ;;
  Q4_K_M) DIFF_FILE="MiniMax-H3-FL2VA-Pruned-Q4_K_M.gguf" ;;
  Q4_K_S) DIFF_FILE="MiniMax-H3-FL2VA-Pruned-Q4_K_S.gguf" ;;
  Q5_K_M) DIFF_FILE="MiniMax-H3-FL2VA-Pruned-Q5_K_M.gguf" ;;
  *) die "未知 H3_QUANT=$H3_QUANT（支持 Q3_K_M/Q4_K_M/Q4_K_S/Q5_K_M）" ;;
esac
dl "$H3_DIFF_REPO" "$DIFF_FILE" "h3_diffusion.gguf"
dl "$H3_AUX_REPO"  "text_encoders/qwen3vl_32b_minimax_h3-Q4_K_M.gguf" "h3_llm.gguf"
dl "$H3_AUX_REPO"  "vae/minimax_h3_video_vae_fp16.safetensors" "h3_video_vae.safetensors"
dl "$H3_AUX_REPO"  "vae/minimax_h3_audio_vae_fp32.safetensors" "h3_audio_vae.safetensors"

# ------------------------- 4. 真实生成验证（CLI 冒烟） -------------------------
say "=== 冒烟验证：文本→视频+音频生成（640x384，24帧，4步）==="
SMOKE_OUT="$H3_ROOT/smoke_test.webm"
env $CUDA_ENV "$SDCPP_DIR/build/bin/sd-cli" -M vid_gen \
  --diffusion-model "$MODELS_DIR/h3_diffusion.gguf" \
  --vae "$MODELS_DIR/h3_video_vae.safetensors" \
  --audio-vae "$MODELS_DIR/h3_audio_vae.safetensors" \
  --llm "$MODELS_DIR/h3_llm.gguf" \
  --backend te=cpu --offload-to-cpu \
  --prompt "a red fox trotting through falling snow, cinematic" \
  --width 640 --height 384 --video-frames 25 --steps 4 --cfg-scale 1.0 \
  --diffusion-fa --output "$SMOKE_OUT"
[ -f "$SMOKE_OUT" ] && [ "$(stat -c%s "$SMOKE_OUT")" -gt 10000 ] || die "冒烟生成失败：$SMOKE_OUT 缺失或过小"
say "冒烟通过：$SMOKE_OUT（$(du -h "$SMOKE_OUT" | cut -f1)）"

# ------------------------- 5. 常驻 HTTP 服务（独立端口 11435） -------------------------
if [ "$H3_SERVER" = 1 ]; then
  say "=== 启动 sd-server（127.0.0.1:${H3_PORT}，独立端口避开 11434）==="
  pkill -f "sd-server.*$H3_PORT" 2>/dev/null || true
  env $CUDA_ENV nohup "$SDCPP_DIR/build/bin/sd-server" \
    --diffusion-model "$MODELS_DIR/h3_diffusion.gguf" \
    --vae "$MODELS_DIR/h3_video_vae.safetensors" \
    --audio-vae "$MODELS_DIR/h3_audio_vae.safetensors" \
    --llm "$MODELS_DIR/h3_llm.gguf" \
    --backend te=cpu --offload-to-cpu \
    --diffusion-fa --cfg-scale 1.0 \
    --listen-ip 127.0.0.1 --listen-port "$H3_PORT" \
    > "$H3_ROOT/sd-server.log" 2>&1 &
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:$H3_PORT/v1/models" || true)
    [ "$code" = 200 ] && break
    sleep 2
  done
  [ "$code" = 200 ] || die "sd-server 未就绪（HTTP ${code}），见 $H3_ROOT/sd-server.log"
  say "sd-server 就绪: http://127.0.0.1:$H3_PORT/v1/models → 200"
  cat > "$H3_ROOT/README.local" <<EOF
MiniMax-H3 本地服务（安装于 $(date)）
- HTTP:      http://127.0.0.1:$H3_PORT/v1/models （独立端口，与四引擎 11434 无冲突）
- 兼容:      OpenAI 形态 /v1/*、/sdapi/v1/*、/sdcpp/v1/vid_gen（文本→视频+音频）
- 权重目录:  $MODELS_DIR
- 冒烟产物:  $SMOKE_OUT
- 停止:      bash uninstall.sh（全清）或 pkill -f sd-server
EOF
fi

say "=== 安装完成 ==="
say "冒烟产物: $SMOKE_OUT"
[ "$H3_SERVER" = 1 ] && say "HTTP:     http://127.0.0.1:$H3_PORT/v1/models"
say "权重:     $MODELS_DIR  （uninstall.sh 一键全清）"
