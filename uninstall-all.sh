#!/usr/bin/env bash
# -*- coding: utf-8 -*-
# =============================================================================
# uninstall-all.sh —— CyberCafe 统一一键卸载/全面清理（所有引擎 + 所有模型，仅留脚本）
#
# 用户 2026-10-02 明确：所有清理 = 所有引擎 + 所有模型，一个统一入口清掉全部部署
# 内容，只保留本脚本本身。
#
# 覆盖范围：
#   ① 所有引擎：ollama / vLLM / SGLang / Strata / OCR（t24）/ MiniMax H3（t25）
#      及未来接入的引擎——停进程、删容器与镜像、清 pip/venv 依赖、删目录；
#   ② 所有模型内容：GGUF/safetensors/HF 缓存/onnx 模型/Strata 数据/OCR 模型/
#      Ollama models/任何下载缓存，除脚本本身外零残留；
#   ③ 系统级留白（默认保留）：NVIDIA 驱动、nvidia-container-toolkit、docker、
#      containerd、cybercafe agent（/opt/cybercafe）、systemd 服务；
#      --purge-all 仅给出也清驱动时的说明（默认不执行）。
#
# 用法：
#   bash uninstall-all.sh --dry-run   只列出将被删除项，不做任何修改
#   bash uninstall-all.sh             交互确认后执行全部清理
#   bash uninstall-all.sh --yes       跳过确认（非交互）
#   bash uninstall-all.sh --purge-all 显示也清驱动的说明（默认不执行该模式）
#
# ⚠️ 警告：本脚本删除全部模型与引擎数据，不可恢复！执行前请确认。
# 脚本自身须存放在清理目录之外（如 /root/），否则会拒绝运行。
# =============================================================================
set -uo pipefail

# ---------------------------------------------------------------- 配置区
SELF_NAME="uninstall-all.sh"
LOG_FILE="/var/log/cybercafe-uninstall-all.log"

# 引擎容器名（docker rm -f）
ENGINE_CONTAINERS=(ollama vllm sglang chatgw cloudflared)
# 引擎/网关/隧道镜像仓库前缀（docker rmi -f 对应镜像）
ENGINE_IMAGE_REPOS=(ollama/ollama vllm/vllm-openai lmsysorg/sglang nginx cloudflare/cloudflared)
# 引擎数据卷（docker volume rm）
ENGINE_VOLUMES=(ollama vllm-hf sglang-hf)
# 原生引擎/模型目录（全部删除）
ENGINE_DIRS=(
  /opt/strata /opt/Strata-data            # Strata 运行时 + ~66GB 数据
  /opt/cybercafe-ocr /opt/ocr             # OCR 流程（t24）
  /opt/minimax-h3 /opt/MiniMax-H3         # MiniMax H3（t25）
  /models                                 # 原生 sglang 验证残留模型目录
)
# 模型/下载缓存目录
CACHE_DIRS=(
  /root/.cache/huggingface /root/.cache/modelscope /root/.cache/torch
  /root/.cache/rapidocr /root/.cache/onnxruntime /root/.cache/onnx
)
# 原生引擎进程匹配模式（pkill -f）
ENGINE_PROCS=("serve/server.py" "sglang" "vllm" "ollama")
# 宿主残留引擎二进制
ENGINE_BINS=(/usr/local/bin/sglang /usr/local/bin/vllm /usr/local/bin/ollama)
# 子卸载脚本聚合（t24/t25 若各自提供 uninstall.sh，先调用再删目录）
SUB_UNINSTALLS=(/opt/cybercafe-ocr/uninstall.sh /opt/minimax-h3/uninstall.sh /opt/strata/uninstall.sh)
# pip 依赖（宿主级原生安装，best-effort）
PIP_PKGS=(sglang vllm ollama)

# 默认保留（明确不触碰）
KEEP_PATHS=(/opt/cybercafe /etc/systemd/system/cybercafe-agent.service)

DRY_RUN=0
YES=0
PURGE_ALL=0

# ---------------------------------------------------------------- 工具函数
say()  { printf '\033[1;34m[uninstall-all]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[警告]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; }

log() {
  local ts; ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '[%s] %s\n' "$ts" "$*" >> "$LOG_FILE"
}

# 统一执行入口：--dry-run 只打印不执行
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] %s\n' "$*"
    return 0
  fi
  eval "$*"
  return $?
}

# 判断脚本自身位置：不得位于任何将被删除的目录内（避免自删）
check_self_location() {
  local self
  self=$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")
  local d
  for d in "${ENGINE_DIRS[@]}" "${CACHE_DIRS[@]}"; do
    case "$self" in
      "$d"/*|"$d") err "脚本位于将被删除的目录内（$d），请先移动到安全位置（如 /root/$SELF_NAME）再运行。" ; exit 1 ;;
    esac
  done
  say "脚本位置安全：$self"
}

# ---------------------------------------------------------------- 动态探测
detect_items() {
  # 返回实际存在的清理对象（dry-run 与执行共用同一份清单，保证一致性）
  local out=""
  if command -v docker >/dev/null 2>&1; then
    # 容器：配置名单中存在的 + 运行中的引擎镜像容器
    local c img
    for c in "${ENGINE_CONTAINERS[@]}"; do
      if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
        out+="container $c\n"
      fi
    done
    # 镜像：按仓库前缀匹配
    for img in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null); do
      local repo r
      repo="${img%%:*}"
      for r in "${ENGINE_IMAGE_REPOS[@]}"; do
        # 包含匹配：docker.m.daocloud.io/ollama/ollama 等 mirror 前缀 repo 也命中（真机验收 F1）
        case "$repo" in
          *"$r"*) out+="image $img\n"; break ;;
        esac
      done
    done
    # 卷
    local v
    for v in "${ENGINE_VOLUMES[@]}"; do
      if docker volume ls -q | grep -qx "$v"; then
        out+="volume $v\n"
      fi
    done
  fi
  # 目录
  local d
  for d in "${ENGINE_DIRS[@]}" "${CACHE_DIRS[@]}"; do
    [ -e "$d" ] && out+="dir $d\n"
  done
  # 进程
  local p
  for p in "${ENGINE_PROCS[@]}"; do
    if pgrep -af "$p" >/dev/null 2>&1; then
      out+="process $p\n"
    fi
  done
  # 宿主二进制
  for b in "${ENGINE_BINS[@]}"; do
    [ -e "$b" ] && out+="bin $b\n"
  done
  # pip 包（best-effort 探测）
  if command -v python3 >/dev/null 2>&1; then
    for pk in "${PIP_PKGS[@]}"; do
      if python3 -m pip show "$pk" >/dev/null 2>&1; then
        out+="pip $pk\n"
      fi
    done
  fi
  # 子卸载脚本
  for u in "${SUB_UNINSTALLS[@]}"; do
    [ -x "$u" ] && out+="subuninstall $u\n"
  done
  printf '%b' "$out"
}

# ---------------------------------------------------------------- 清理执行
kill_procs() {
  say "=== 1/8 停止引擎进程 ==="
  local p
  for p in "${ENGINE_PROCS[@]}"; do
    if pgrep -af "$p" >/dev/null 2>&1; then
      run "pkill -f '$p' 2>/dev/null || true"
      run "sleep 1"
    fi
  done
  # 二次确认句柄（pkill 后残留的强杀）
  run "pkill -9 -f 'sglang' 2>/dev/null || true"
}

run_sub_uninstalls() {
  say "=== 2/8 调用子引擎卸载脚本（t24/t25 如提供） ==="
  local u
  for u in "${SUB_UNINSTALLS[@]}"; do
    if [ -x "$u" ]; then
      say "调用 $u"
      run "bash '$u' --yes 2>/dev/null || bash '$u' < /dev/null 2>/dev/null || true"
    fi
  done
}

rm_containers() {
  say "=== 3/8 删除引擎容器 ==="
  local c
  for c in "${ENGINE_CONTAINERS[@]}"; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      run "docker rm -f '$c'"
    fi
  done
}

rm_images() {
  say "=== 4/8 删除引擎镜像 ==="
  local img repo r id ids=() removed=0
  for img in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null); do
    repo="${img%%:*}"
    for r in "${ENGINE_IMAGE_REPOS[@]}"; do
      # 包含匹配：识别 mirror 前缀 repo（如 docker.m.daocloud.io/ollama/ollama）；
      # 本机实际部署源即带 mirror 前缀 tag（真机验收 F1），不识别将残留数 G 镜像层
      case "$repo" in
        *"$r"*)
          id="$(docker inspect --format '{{.Id}}' "$img" 2>/dev/null)"
          case " ${ids[*]:-} " in
            *" $id "*) ;; *) [ -n "$id" ] && ids+=("$id") ;;
          esac
          removed=1; break ;;
      esac
    done
  done
  # 按镜像 ID 删除：连带删除该镜像全部 tag（含 mirror 前缀 tag），镜像层才真正释放磁盘
  for id in "${ids[@]:-}"; do
    [ -n "$id" ] && run "docker rmi -f '$id' 2>/dev/null || true"
  done
  # 悬空镜像（引擎多阶段拉取的 <none> 残留）
  if [ "$(docker images -q -f dangling=true 2>/dev/null | wc -l)" -gt 0 ]; then
    say "清理悬空镜像（dangling）"
    run "docker image prune -f"
  fi
  [ "$removed" = 1 ] || say "无引擎镜像需删除"
}

rm_volumes() {
  say "=== 5/8 删除引擎数据卷（含全部模型权重） ==="
  local v
  for v in "${ENGINE_VOLUMES[@]}"; do
    if docker volume ls -q 2>/dev/null | grep -qx "$v"; then
      run "docker volume rm -f '$v'"
    fi
  done
}

rm_dirs() {
  say "=== 6/8 删除引擎/模型目录 ==="
  local d
  for d in "${ENGINE_DIRS[@]}" "${CACHE_DIRS[@]}"; do
    if [ -e "$d" ]; then
      run "rm -rf '$d'"
    fi
  done
}

rm_bins_pkgs() {
  say "=== 7/8 删除宿主残留二进制与 pip/venv 依赖（best-effort） ==="
  local b
  for b in "${ENGINE_BINS[@]}"; do
    [ -e "$b" ] && run "rm -f '$b'"
  done
  if command -v python3 >/dev/null 2>&1; then
    for pk in "${PIP_PKGS[@]}"; do
      if python3 -m pip show "$pk" >/dev/null 2>&1; then
        run "python3 -m pip uninstall -y '$pk' 2>/dev/null || true"
      fi
    done
  fi
  # venv 目录（原生引擎残留在引擎目录内，随目录删除；此处兜底常见路径）
  run "rm -rf /opt/strata/.venv 2>/dev/null || true"
}

# ---------------------------------------------------------------- 核对清单
verify() {
  say "=== 8/8 执行后核对清单 ==="
  local rc=0
  local p c v d

  say "-- 进程 --"
  for p in "${ENGINE_PROCS[@]}"; do
    if pgrep -af "$p" >/dev/null 2>&1; then
      warn "残留进程: $(pgrep -af "$p" | head -3 | tr '\n' ' ')"
      rc=1
    fi
  done
  pgrep -af "sglang" >/dev/null 2>&1 && { warn "残留 sglang 进程"; rc=1; }

  say "-- 容器 --"
  for c in "${ENGINE_CONTAINERS[@]}"; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      warn "残留容器: $c"; rc=1
    fi
  done

  say "-- 镜像 --"
  local imgs
  imgs=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)
  local leftover=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    repo="${line%%:*}"
    for r in "${ENGINE_IMAGE_REPOS[@]}"; do
      # 与删除同口径的包含匹配：mirror 前缀 repo 也算残留（真机验收 F1）
      case "$repo" in
        *"$r"*) leftover="$leftover $line"; break ;;
      esac
    done
  done <<< "$imgs"
  if [ -n "$leftover" ]; then
    warn "残留镜像:$leftover"; rc=1
  fi
  if [ "$(docker images -q -f dangling=true 2>/dev/null | wc -l)" -gt 0 ]; then
    warn "残留悬空镜像 $(docker images -q -f dangling=true 2>/dev/null | wc -l) 个"; rc=1
  fi

  say "-- 卷 --"
  for v in "${ENGINE_VOLUMES[@]}"; do
    if docker volume ls -q 2>/dev/null | grep -qx "$v"; then
      warn "残留卷: $v"; rc=1
    fi
  done

  say "-- 目录 --"
  for d in "${ENGINE_DIRS[@]}" "${CACHE_DIRS[@]}"; do
    [ -e "$d" ] && { warn "残留目录: $d"; rc=1; }
  done

  say "-- 端口（11434/8000/30000 应为空） --"
  local ports
  ports=$(ss -tlnp 2>/dev/null | grep -E ':(11434|8000|30000)\b' || true)
  [ -n "$ports" ] && { warn "残留监听端口:\n$ports"; rc=1; }

  say "-- 系统组件（应保留） --"
  command -v docker >/dev/null 2>&1 && say "docker 保留: $(docker --version 2>/dev/null)"
  command -v nvidia-smi >/dev/null 2>&1 \
    && say "nvidia-smi 正常: $(nvidia-smi --query-gpu=driver_version,name --format=csv,noheader 2>/dev/null | head -1)" \
    || say "nvidia-smi 不在本机（沙箱/无 GPU 环境，跳过）"
  [ -d /opt/cybercafe ] && say "agent 目录保留: /opt/cybercafe"
  systemctl is-active cybercafe-agent >/dev/null 2>&1 && say "cybercafe-agent 服务保持 active" \
    || say "cybercafe-agent 服务当前非 active（未被本脚本操作）"
  say "脚本自身保留: $(readlink -f "$0" 2>/dev/null || echo "$0")"

  if [ "$rc" = 0 ]; then
    say "核对通过：引擎/模型内容已全部清除，仅系统组件与脚本保留。"
  else
    err "核对发现残留，请人工复核上述告警项。"
  fi
  return "$rc"
}

# ---------------------------------------------------------------- 入口
usage() {
  cat <<EOF
用法: bash uninstall-all.sh [选项]

选项:
  --dry-run    只列出将被删除项，不做任何修改
  --yes        跳过交互确认（非交互执行）
  --purge-all  打印"也清除 NVIDIA 驱动/容器 toolkit"的说明（默认不执行该模式）
  -h, --help   显示本帮助

⚠️ 将被删除（不可恢复）：全部引擎(ollama/vLLM/SGLang/Strata/OCR/MiniMax H3/未来引擎)
   进程/容器/镜像/数据卷 + 全部模型权重/HF缓存/下载缓存。
   保留：NVIDIA 驱动、nvidia-container-toolkit、docker、cybercafe agent(/opt/cybercafe)。
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes)     YES=1 ;;
    --purge-all) PURGE_ALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) err "未知参数: $arg"; usage; exit 1 ;;
  esac
done

if [ "$PURGE_ALL" = 1 ]; then
  cat <<'EOF'
[--purge-all 模式说明] 本脚本默认保留 NVIDIA 驱动与 nvidia-container-toolkit（系统组件）。
若需连驱动一并清除（极简模式），请手动执行以下步骤（默认不自动执行）：
  1) apt-mark unhold 全部 nvidia-*（此前已 hold 的版本固定需先解除）
  2) apt-get purge 'nvidia-*' libnvidia-* xserver-xorg-video-nvidia-*
  3) 卸载后需重装驱动（≥550/580 线）才能恢复 GPU 推理
⚠️ 该操作会导致 GPU 不可用并需重装系统组件，默认不执行。
EOF
  exit 0
fi

say "CyberCafe 统一一键卸载/全面清理"
if [ "$(id -u)" != 0 ]; then err "需要 root 权限执行。"; exit 1; fi
check_self_location
command -v docker >/dev/null 2>&1 || warn "本机无 docker（引擎可能未部署），仅清理目录/进程/包。"

echo
say "探测到的将被清理对象："
echo "------------------------------------------------------------"
PLAN=$(detect_items)
if [ -z "$PLAN" ]; then
  say "未发现任何引擎/模型内容，无需清理。"
  exit 0
fi
printf '%b' "$PLAN"
echo "------------------------------------------------------------"

if [ "$DRY_RUN" = 1 ]; then
  say "dry-run 模式：仅列出以上对象，未执行任何修改。"
  exit 0
fi

if [ "$YES" != 1 ]; then
  echo
  warn "以上全部内容将被永久删除（所有引擎 + 所有模型数据，不可恢复）!"
  read -r -p "确认继续? 输入 yes 回车执行，其余任意键取消: " ans
  if [ "$ans" != "yes" ]; then say "已取消。"; exit 0; fi
fi

# 保留 stdout 同时记录日志：
exec > >(tee -a "$LOG_FILE") 2>&1
say "开始清理（$(date '+%Y-%m-%d %H:%M:%S')）"

kill_procs
run_sub_uninstalls
rm_containers
rm_images
rm_volumes
rm_dirs
rm_bins_pkgs
verify

rc=$?
say "清理结束（$(date '+%H:%M:%S')），退出码=$rc"
exit "$rc"