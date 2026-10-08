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
#   - 本机最小档（RTX 4080 SUPER 16GB / 31.2GB 内存）——sd.cpp 兼容 GGUF 源：
#       扩散主模型  unsloth/MiniMax-H3-GGUF  minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf  8.06GB
#       文本编码器  unsloth/MiniMax-H3-GGUF  qwen3vl_32b_minimax_h3-Q2_K_M.gguf  13.1GB
#       视频 VAE    Comfy-Org/MiniMax-H3     vae/minimax_h3_video_vae_fp16.safetensors  5.2GB
#       音频 VAE    Comfy-Org/MiniMax-H3     vae/minimax_h3_audio_vae_fp32.safetensors  0.6GB
#       ⚠️ Abiray/MiniMax-H3-Pruned-GGUF 为 ComfyUI-GGUF 布局，sd.cpp 加载报
#          model metadata validation failed（t48 真机实测），本脚本不使用
#   - 运行时：stable-diffusion.cpp（leejet，Day-1 支持 MiniMax-H3，GGUF 原生）
#   - 端口：sd-server 独立端口 11435（避开 ollama/vllm/sglang/strata 共用的 11434），
#           nginx 网关不变；兼容 /v1/models 与 OpenAI API 形态，外部可再套 Key 网关。
# -----------------------------------------------------------------------------
# 用法:  bash install.sh            # 默认档（UD-Q2_K_XL，sd.cpp 兼容最小档）
#        H3_QUANT=Q4_K_M bash install.sh   # 更高档（11.4GB，16GB 卡平衡档）
#        H3_SERVER=0 bash install.sh # 只装模型+CLI 验证，不常驻 HTTP 服务
# 卸载:  bash uninstall.sh
# =============================================================================
set -euo pipefail

# ------------------------- 配置 -------------------------
H3_ROOT="${H3_ROOT:-/opt/minimax-h3}"          # 全部内容收敛此目录（卸载=删此目录）
H3_QUANT="${H3_QUANT:-UD-Q2_K_XL}"             # 默认档：unsloth UD-Q2_K_XL（sd.cpp 兼容，t48 实测 Abiray Q3_K_M 为 ComfyUI 布局不兼容）
H3_SERVER="${H3_SERVER:-1}"                    # 1=常驻 sd-server(11435)，0=CLI 验证
H3_PORT="${H3_PORT:-11435}"                    # 独立端口，避开 11434
H3_DIFF_REPO="unsloth/MiniMax-H3-GGUF"         # 扩散主模型（sd.cpp 兼容 GGUF：unsloth/leejet 均可，Abiray 为 ComfyUI 布局已被 t48 实测否决）
H3_AUX_REPO="unsloth/MiniMax-H3-GGUF"          # 文本编码器（与 denoiser 同源，格式一致）
H3_VAE_REPO="Comfy-Org/MiniMax-H3"             # VAE（safetensors，官方 diffusers 仓库）
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
if [ -x /usr/local/cuda/bin/nvcc ]; then CUDA_ENV="PATH=/usr/local/cuda/bin:${PATH:-} LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}";
elif [ -x /usr/local/cuda-12.2/bin/nvcc ]; then CUDA_ENV="PATH=/usr/local/cuda-12.2/bin:${PATH:-} LD_LIBRARY_PATH=/usr/local/cuda-12.2/lib64:${LD_LIBRARY_PATH:-}";
fi
[ -n "$CUDA_ENV" ] || die "未找到 CUDA toolkit（/usr/local/cuda*）——需先装 CUDA 12.x/13.x（sudo apt install nvidia-cuda-toolkit 或 developer.nvidia.com）"

nvcc_v=$(env $CUDA_ENV nvcc --version | grep -oE 'release [0-9]+\.[0-9]+' | head -1 | awk '{print $2}')
cuda_major="${nvcc_v%%.*}"
gcc_v=$(gcc --version | head -1 | grep -oE '[0-9]+' | head -1)
gcc_limit=$(( cuda_major < 13 ? 12 : 13 ))
say "nvcc $nvcc_v（CUDA 主版本 ${cuda_major}）→ 宿主 gcc 上限 $gcc_limit；当前 gcc $gcc_v"
if [ "$gcc_v" -gt "$gcc_limit" ]; then
  say "安装 gcc-$gcc_limit / g++-$gcc_limit 并隔离注入 PATH（不切换系统默认）..."
  # 守卫必须分别独立判定（t48 真机实测：gcc-12 已存在时 `have gcc-12 || 装两个` 会跳过 g++-12，
  # 导致 cc1plus 缺失 → CMake CUDA 编译器探测 `cannot execute cc1plus` 失败）
  need_apt=""
  have "gcc-$gcc_limit" || need_apt=1
  have "g++-$gcc_limit" || need_apt=1
  [ -n "$need_apt" ] && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "gcc-$gcc_limit" "g++-$gcc_limit"
  # 双保险：缺哪个补哪个（apt 已有包会秒回）
  have "g++-$gcc_limit" || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "g++-$gcc_limit"
  # 装完必须存在 cc1plus（nvcc 的 host 编译器内部组件），否则 CUDA ID 探测必然失败
  CC1PLUS=$(find /usr/lib/gcc /usr/libexec/gcc -path "*$gcc_limit/cc1plus" 2>/dev/null | head -1)
  [ -n "$CC1PLUS" ] || die "g++-$gcc_limit 安装后 cc1plus 仍缺失（/usr/lib/gcc 下查找无果），无法编译 CUDA"
  say "cc1plus 就绪: $CC1PLUS"
  mkdir -p "$GCC_ISO"
  # 隔离目录软链：cc-12/c++-12 在 Ubuntu 上不存在（t48 实测），
  # cc→gcc-12、c++→g++-12、gcc→gcc-12、g++→g++-12——源不存在则不创建（避免悬空链接）
  for pair in "gcc:gcc-$gcc_limit" "g++:g++-$gcc_limit" "cc:gcc-$gcc_limit" "c++:g++-$gcc_limit"; do
    link_name="${pair%%:*}"; src="${pair##*:}"
    src_path="$(command -v "$src" 2>/dev/null || true)"
    if [ -n "$src_path" ]; then
      ln -sf "$src_path" "$GCC_ISO/$link_name"
    else
      say "跳过软链 $link_name（源 $src 不存在，避免悬空）"
    fi
  done
  # 把隔离目录插入 CUDA_ENV 的 PATH= 段前部（不能整体前缀：会产生 PATH=A:PATH=B 双前缀，
  # env 解析会把第二个 PATH= 当命令参数，导致 CUDA bin 实际不进 PATH——t25 真机实测）
  CUDA_ENV="PATH=$GCC_ISO:${CUDA_ENV#PATH=}"
fi

# ------------------------- 2. 克隆并编译 stable-diffusion.cpp -------------------------
say "=== 编译 stable-diffusion.cpp（CUDA 版，首次约 10-20 分钟）==="
if [ ! -d "$SDCPP_DIR/.git" ]; then
  # --recursive 必需：sd.cpp 依赖 ggml 子模块，缺了 CMake 会报 ggml 无 CMakeLists（t25 真机实测）
  git clone --depth 1 --recursive https://github.com/leejet/stable-diffusion.cpp "$SDCPP_DIR"
else
  # 已有 clone：补子模块；仅「上次编译失败残留」（build 有 CMakeCache 但无 sd-cli）才清 build，
  # 否则 sd-cli 已生成时不做清理——避免每次重跑都花 10-20 分钟重编译（t48 真机实测）
  cd "$SDCPP_DIR"
  git submodule update --init --recursive 2>/dev/null || true
  if [ -f build/CMakeCache.txt ] && [ ! -x build/bin/sd-cli ]; then
    say "检测到上次失败的 build 残留（CMakeCache 存在但 sd-cli 缺失），清理后重新 configure..."
    rm -rf build build-vision 2>/dev/null || true
  fi
fi
cd "$SDCPP_DIR"
mkdir -p build && cd build
if [ ! -f bin/sd-cli ]; then
  # 显式指定 nvcc 与 arch：避免 PATH 注入顺序/子进程环境差异导致 CMake 找不到 CUDA 编译器
  NVCC_BIN=""
  for c in /usr/local/cuda/bin/nvcc /usr/local/cuda-12.2/bin/nvcc; do [ -x "$c" ] && NVCC_BIN="$c" && break; done
  env $CUDA_ENV cmake .. -DCMAKE_BUILD_TYPE=Release -DSD_CUDA=ON \
      -DCMAKE_CUDA_COMPILER="$NVCC_BIN" -DCMAKE_CUDA_ARCHITECTURES=89 >/dev/null
  env $CUDA_ENV cmake --build . -j"$(nproc)" >/dev/null
fi
[ -x bin/sd-cli ] || die "sd-cli 编译失败，见 $LOG"
[ "$H3_SERVER" = 1 ] && { [ -x bin/sd-server ] || die "sd-server 编译失败"; }
say "sd-cli/sd-server 就绪"

# ------------------------- 3. 下载权重（hf-mirror，~29GB） -------------------------
say "=== 下载权重（HF_ENDPOINT=${H3_ENDPOINT}，约 29GB，按需续传）==="
# 下载守卫（t48 第 5 个真机缺陷修复）：文件名带档位/来源编码 + sidecar 记录 URL，
# 换仓库/换量化档后旧文件不会被静默沿用（旧守卫只看「存在且 >1MB」，
# 换源后同名文件会跳过导致继续用错误权重跑——曾让 t48 白下 25GB）。
# dl <repo> <subpath> —— dest 名 = subpath 文件名，天然隔离不同档位/来源
dl() {
  local url="$H3_ENDPOINT/$1/resolve/main/$2"
  local dest="$MODELS_DIR/$(basename "$2")"
  local srcfile="$dest.src"
  if [ ! -f "$dest" ] || [ -f "$srcfile" ] && [ "$(cat "$srcfile" 2>/dev/null)" != "$url" ]; then
    say "下载 $(basename "$2") ..."
    curl -fL --retry 5 --retry-delay 3 -C - -o "$dest" "$url" || die "下载失败: $url"
    echo "$url" > "$srcfile"
  elif [ ! -f "$srcfile" ]; then
    # 旧版本下载的文件无 .src 记录：重下一次确保来源正确
    say "检测到旧版本残留（无来源记录），重下 $(basename "$2") ..."
    curl -fL --retry 5 --retry-delay 3 -C - -o "$dest" "$url" || die "下载失败: $url"
    echo "$url" > "$srcfile"
  fi
  say "  就绪 $(basename "$2") ($(du -h "$dest" | cut -f1))"
}
case "$H3_QUANT" in
  # 全部档位用 sd.cpp 兼容 GGUF 源（unsloth/leejet）；Abiray/MiniMax-H3-Pruned-GGUF 为 ComfyUI 布局，
  # sd.cpp 加载报 model metadata validation failed（t48 真机实测），已从本脚本移除
  UD-Q2_K_XL) DIFF_REPO="unsloth/MiniMax-H3-GGUF"; DIFF_FILE="minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf"; LLM_SUB="qwen3vl_32b_minimax_h3-Q2_K_M.gguf" ;;
  UD-Q3_K_XL) DIFF_REPO="unsloth/MiniMax-H3-GGUF"; DIFF_FILE="minimax_h3_fl2va_pruned-UD-Q3_K_XL.gguf"; LLM_SUB="qwen3vl_32b_minimax_h3-Q2_K_M.gguf" ;;
  Q4_K_M) DIFF_REPO="unsloth/MiniMax-H3-GGUF"; DIFF_FILE="minimax_h3_fl2va_pruned-Q4_K.gguf"; LLM_SUB="qwen3vl_32b_minimax_h3-Q2_K_M.gguf" ;;
  Q5_0)   DIFF_REPO="unsloth/MiniMax-H3-GGUF"; DIFF_FILE="minimax_h3_fl2va_pruned-Q5_0.gguf"; LLM_SUB="qwen3vl_32b_minimax_h3-Q2_K_M.gguf" ;;
  *) die "未知 H3_QUANT=$H3_QUANT（支持 UD-Q2_K_XL/UD-Q3_K_XL/Q4_K_M/Q5_0）" ;;
esac
# dest 名 = 文件原名（含档位/来源差异），冒烟与服务启动引用同一文件名
dl "$DIFF_REPO" "$DIFF_FILE"
dl "$H3_AUX_REPO"  "$LLM_SUB"
dl "$H3_VAE_REPO"  "vae/minimax_h3_video_vae_fp16.safetensors"
dl "$H3_VAE_REPO"  "vae/minimax_h3_audio_vae_fp32.safetensors"
H3_DIFF_FILE="$MODELS_DIR/$(basename "$DIFF_FILE")"
H3_LLM_FILE="$MODELS_DIR/$(basename "$LLM_SUB")"
H3_VIDEO_VAE="$MODELS_DIR/minimax_h3_video_vae_fp16.safetensors"
H3_AUDIO_VAE="$MODELS_DIR/minimax_h3_audio_vae_fp32.safetensors"

# ------------------------- 4. 真实生成验证（CLI 冒烟） -------------------------
say "=== 冒烟验证：文本→视频+音频生成（640x384，24帧，4步）==="
SMOKE_OUT="$H3_ROOT/smoke_test.webm"
env $CUDA_ENV "$SDCPP_DIR/build/bin/sd-cli" -M vid_gen \
  --diffusion-model "$H3_DIFF_FILE" \
  --vae "$H3_VIDEO_VAE" \
  --audio-vae "$H3_AUDIO_VAE" \
  --llm "$H3_LLM_FILE" \
  --backend "te=cpu,vae=cuda0,diffusion=cuda0" --offload-to-cpu \
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
    --diffusion-model "$H3_DIFF_FILE" \
    --vae "$H3_VIDEO_VAE" \
    --audio-vae "$H3_AUDIO_VAE" \
    --llm "$H3_LLM_FILE" \
    --backend "te=cpu,vae=cuda0,diffusion=cuda0" --offload-to-cpu \
    --diffusion-fa --cfg-scale 1.0 \
    --listen-ip 127.0.0.1 --listen-port "$H3_PORT" \
    > "$H3_ROOT/sd-server.log" 2>&1 &
  for _ in $(seq 1 30); do
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
# 卸载脚本落位：uninstall-all.sh 的 SUB_UNINSTALLS 固定引用 /opt/minimax-h3/uninstall.sh
# （t28 约定），必须与 H3_ROOT 一致，否则统一卸载会漏掉本模型
SCRIPT_SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_SELF")"
if [ -f "$SCRIPT_DIR/uninstall.sh" ]; then
  cp -f "$SCRIPT_DIR/uninstall.sh" "$H3_ROOT/uninstall.sh"
  chmod +x "$H3_ROOT/uninstall.sh"
  say "卸载脚本已落位: $H3_ROOT/uninstall.sh（uninstall-all.sh 统一卸载可命中）"
elif [ "$H3_ROOT" = /opt/minimax-h3 ] && [ -f /root/h3-delivery/uninstall.sh ]; then
  cp -f /root/h3-delivery/uninstall.sh "$H3_ROOT/uninstall.sh"
  chmod +x "$H3_ROOT/uninstall.sh"
  say "卸载脚本已落位（h3-delivery）: $H3_ROOT/uninstall.sh"
else
  say "提示: 未在脚本同目录找到 uninstall.sh，统一卸载（uninstall-all.sh）将只删目录；"
  say "      可手动 cp uninstall.sh $H3_ROOT/uninstall.sh"
fi
