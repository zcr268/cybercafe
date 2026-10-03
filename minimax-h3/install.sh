#!/usr/bin/env bash
# =============================================================================
# MiniMax-H3 本地部署 install.sh（一键安装 + 冒烟验证）
# 目标机：Ubuntu 24.04 + x86_64 + NVIDIA GPU（16GB 显存可跑 CPU 卸载档）
# 方案：stable-diffusion.cpp（sd.cpp，预编译 CPU/Ubuntu 24.04 二进制，零系统依赖）
#      + unsloth MiniMax-H3-GGUF 最小档（UD-Q2_K_XL denoiser 7.5GiB
#      + Qwen3-VL-32B 文本编码器 Q2_K_M 12.2GiB）+ VAE（hf-mirror 国内源）
# 特性：幂等可重跑（curl -C - 断点续传）；不装任何系统包；不占用 11434 端口；
#      与 ollama/vllm/sglang/strata 四引擎并存（本机无 GPU 常驻服务，推理按需）。
# 卸载：bash uninstall.sh（删除全部权重/缓存/二进制/日志，零残留，见 README）
# =============================================================================
set -uo pipefail

BASE=/opt/minimax-h3
BIN_URL="https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a/sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64.zip"
HFM="https://hf-mirror.com"
DENOISER_URL="$HFM/unsloth/MiniMax-H3-GGUF/resolve/main/minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf"
LLM_URL="$HFM/unsloth/MiniMax-H3-GGUF/resolve/main/qwen3vl_32b_minimax_h3-Q2_K_M.gguf"
VIDEO_VAE_URL="$HFM/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE_URL="$HFM/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors"
SERVER_PORT="${H3_SERVER_PORT:-17888}"   # 可选 sd-server 独立端口（不碰 11434/8000）
OUT_DIR="${H3_OUT_DIR:-$BASE/outputs}"   # 冒烟产物目录可覆盖（如机器根分区只读时用 /dev/shm）

log() { echo "[minimax-h3] $*"; }

dl() { # dl <dest> <url>
  curl -sL -C - --retry 5 --retry-delay 3 -o "$1" "$2" || { log "下载失败: $2"; exit 1; }
}

echo "== MiniMax-H3 安装开始（$(date '+%F %T')）=="

# ---------- 0) 环境预检 ----------
command -v curl >/dev/null || { log "需要 curl"; exit 1; }
[ "$(id -u)" = 0 ] || { log "需要 root"; exit 1; }
nproc >/dev/null || true
free_mb=$(free -m | awk '/Mem:/{print $7}')
[ "$free_mb" -lt 20480 ] && log "警告：可用内存 ${free_mb}MB < 20GB，Q2 档全 CPU 卸载可能吃紧（仍可尝试）"
df_mb=$(df -Pm / | awk 'NR==2{print $4}')
[ "$df_mb" -lt 25000 ] && { log "磁盘不足（<25GB）：$df_mb MB"; exit 1; }

# ---------- 1) 目录 ----------
mkdir -p "$BASE/bin" "$BASE/models" "$OUT_DIR" "$BASE/logs" "$BASE/scripts"

# ---------- 2) sd.cpp 预编译二进制 ----------
if [ ! -x "$BASE/bin/sd-cli" ]; then
  log "下载 sd.cpp 预编译（Ubuntu 24.04 x86_64）..."
  dl "$BASE/bin/sd.zip" "$BIN_URL"
  (cd "$BASE/bin" && unzip -o -q sd.zip) || { log "解压失败"; exit 1; }
  rm -f "$BASE/bin/sd.zip"
  chmod +x "$BASE"/bin/sd-* 2>/dev/null || true
fi
[ -x "$BASE/bin/sd-cli" ] || { log "sd-cli 不可执行"; ls "$BASE/bin/"; exit 1; }
log "sd-cli: $($BASE/bin/sd-cli --help 2>&1 | head -1 | tr -d '\n')"

# ---------- 3) 模型权重（GGUF + VAE，hf-mirror 国内源，断点续传） ----------
cd "$BASE/models"
[ -s minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf ] || { log "下载 denoiser UD-Q2_K_XL（7.5GiB）..."; dl minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf "$DENOISER_URL"; }
[ -s qwen3vl_32b_minimax_h3-Q2_K_M.gguf ] || { log "下载文本编码器 Q2_K_M（12.2GiB）..."; dl qwen3vl_32b_minimax_h3-Q2_K_M.gguf "$LLM_URL"; }
[ -s minimax_h3_video_vae_fp16.safetensors ] || { log "下载 video VAE ..."; dl minimax_h3_video_vae_fp16.safetensors "$VIDEO_VAE_URL"; }
[ -s minimax_h3_audio_vae_fp32.safetensors ] || { log "下载 audio VAE ..."; dl minimax_h3_audio_vae_fp32.safetensors "$AUDIO_VAE_URL"; }
log "模型文件：$(du -sh "$BASE/models" | cut -f1)"

# ---------- 4) 冒烟验证（CPU 最小档：384x224 @ 9 帧，4 步） ----------
log "冒烟验证：文本→视频生成（CPU，384x224，9 帧，4 步，--cfg-scale 1.0），输出目录 $OUT_DIR ..."
OUT="$OUT_DIR/smoke_$(date +%s).webm"
timeout 1800 "$BASE/bin/sd-cli" -M vid_gen \
  --diffusion-model "$BASE/models/minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf" \
  --llm "$BASE/models/qwen3vl_32b_minimax_h3-Q2_K_M.gguf" \
  --vae "$BASE/models/minimax_h3_video_vae_fp16.safetensors" \
  --audio-vae "$BASE/models/minimax_h3_audio_vae_fp32.safetensors" \
  -p "a tiny red robot walking on a mossy rock, cinematic, short clip" \
  --cfg-scale 1.0 -W 384 -H 224 --video-frames 9 --fps 12 \
  --rng cpu --backend te=cpu -o "$OUT" > "$BASE/logs/smoke.log" 2>&1
rc=$?
if [ $rc -eq 0 ] && [ -s "$OUT" ]; then
  log "冒烟通过：$OUT（$(du -h "$OUT" | cut -f1)）"
else
  log "冒烟失败（rc=$rc），尾部日志："; tail -8 "$BASE/logs/smoke.log"; exit 1
fi

# ---------- 5) 写入 manifest（卸载清单） ----------
cat > "$BASE/.manifest" <<EOF
installed_at=$(date +%F-%T)
installer=$(basename "$0")
sd_cli_version=$($BASE/bin/sd-cli --help 2>&1 | head -1)
denoiser=minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf
text_encoder=qwen3vl_32b_minimax_h3-Q2_K_M.gguf
video_vae=minimax_h3_video_vae_fp16.safetensors
audio_vae=minimax_h3_audio_vae_fp32.safetensors
base_dir=$BASE
server_port=$SERVER_PORT
EOF

# ---------- 6) 可选：常驻 sd-server（独立端口，默认不启用） ----------
if [ "${H3_ENABLE_SERVER:-0}" = "1" ] && [ -x "$BASE/bin/sd-server" ]; then
  nohup "$BASE/bin/sd-server" --host 127.0.0.1 --port "$SERVER_PORT" \
    --diffusion-model "$BASE/models/minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf" \
    --llm "$BASE/models/qwen3vl_32b_minimax_h3-Q2_K_M.gguf" \
    --vae "$BASE/models/minimax_h3_video_vae_fp16.safetensors" \
    --audio-vae "$BASE/models/minimax_h3_audio_vae_fp32.safetensors" \
    > "$BASE/logs/server.log" 2>&1 &
  sleep 2
  log "sd-server 已启动：127.0.0.1:$SERVER_PORT（POST /sdcpp/v1/vid_gen）"
fi

echo "== MiniMax-H3 安装完成（$(date '+%F %T')）。卸载：bash $BASE/../h3-scripts/uninstall.sh 或仓库内 minimax-h3/uninstall.sh =="
echo "== 手工生成：$BASE/bin/sd-cli -M vid_gen --diffusion-model $BASE/models/... --llm $BASE/models/qwen3vl_32b_minimax_h3-Q2_K_M.gguf --vae ... --audio-vae ... -p '<prompt>' --cfg-scale 1.0 -W 640 -H 384 --video-frames 25 --fps 24 --rng cpu --backend te=cpu -o out.webm =="
