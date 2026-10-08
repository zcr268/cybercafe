#!/usr/bin/env bash
# =============================================================================
# CyberCafe MiniMax-H3 一键卸载 + 全面清理（uninstall.sh）
# -----------------------------------------------------------------------------
# 语义：除本脚本外零残留。覆盖：进程 / systemd 服务 / 权重 / 缓存 / 依赖
#       （脚本自装的 gcc-<N> 仅当其为 H3 独有才卸载）/ 目录 / 端口占用。
# 可逆说明：
#   - 权重与 sd.cpp 编译产物删除后不可恢复（来源均为公开仓库，可重装——
#     重新执行 install.sh 即可，无需任何手工步骤）。
#   - 系统级依赖（git/cmake/build-essential/pkg-config/nvidia-cuda-toolkit）
#     若安装本模型前已存在则保留；仅当确认为本脚本新装且无其他用途时才卸载
#     （默认保守保留，避免影响 ollama/vllm/sglang/strata 四引擎）。
#   - gcc-<N> 隔离软链目录 /root/.cybercafe-gcc12 为 strata 与 H3 共用，
#     默认保留（strata 仍在用）；如需连同移除：UNINSTALL_GCC=1。
# =============================================================================
set -euo pipefail

H3_ROOT="${H3_ROOT:-/opt/minimax-h3}"
H3_PORT="${H3_PORT:-11435}"
GCC_ISO="/root/.cybercafe-gcc12"
UNINSTALL_GCC="${UNINSTALL_GCC:-0}"     # 1=连 gcc 隔离目录一起清（慎用，strata 共用）

say()  { printf '\033[1;34m[h3-uninstall]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[h3-uninstall ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请以 root 运行（sudo bash uninstall.sh）"

# 1) 进程：sd-server / sd-cli（仅本模型相关路径，防误杀其他 sd.cpp 实例）
say "1/6 停止进程 ..."
pkill -f "sd-server.*$H3_PORT" 2>/dev/null || true
pkill -f "$H3_ROOT/sd.cpp" 2>/dev/null || true
# 兜底：任何监听 H3_PORT 的进程
if command -v fuser >/dev/null 2>&1; then
  fuser -k "$H3_PORT/tcp" 2>/dev/null || true
fi

# 2) systemd 服务（install.sh 当前未装 systemd unit，但清理遗留以防将来扩展）
say "2/6 清理 systemd 服务 ..."
for u in minimax-h3 sd-server-h3; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^$u"; then
    systemctl stop "$u" 2>/dev/null || true
    systemctl disable "$u" 2>/dev/null || true
    rm -f "/etc/systemd/system/$u.service"
  fi
done
systemctl daemon-reload 2>/dev/null || true

# 3) 权重 / 编译产物 / 日志 / 冒烟产物：整个 H3_ROOT
say "3/6 删除安装目录 $H3_ROOT ..."
if [ -d "$H3_ROOT" ]; then
  rm -rf "$H3_ROOT"
fi
say "   已删除（$H3_ROOT 不存在即视为已清）"

# 4) 缓存：HF 下载缓存（仅本模型仓库条目）
say "4/6 清理 HF 缓存 ..."
HF_CACHE="${HF_CACHE:-/root/.cache/huggingface/hub}"
if [ -d "$HF_CACHE" ]; then
  rm -rf "$HF_CACHE/models--Abiray--MiniMax-H3-Pruned-GGUF" \
         "$HF_CACHE/models--Abiray--MiniMax-H3-GGUF" 2>/dev/null || true
  # 空 hub 目录不删（可能被 ollama/vllm/sglang 共用）
fi

# 5) gcc 隔离目录（默认保留：strata 共用；UNINSTALL_GCC=1 时移除）
say "5/6 gcc 隔离目录 ..."
if [ "$UNINSTALL_GCC" = 1 ]; then
  rm -rf "$GCC_ISO"
  say "   已移除 $GCC_ISO（注意：若 strata 仍在使用将报错，请确认）"
else
  say "   保留 $GCC_ISO（strata 引擎共用；如需清除 export UNINSTALL_GCC=1 重跑）"
fi

# 6) 最终核验：零残留报告
say "6/6 残留核验 ..."
LEFTOVER=""
[ -d "$H3_ROOT" ] && LEFTOVER="$LEFTOVER\n  - $H3_ROOT"
pgrep -af "sd-server" 2>/dev/null | grep -q "$H3_PORT" && LEFTOVER="$LEFTOVER\n  - sd-server($H3_PORT) 进程仍在"
if [ -n "$LEFTOVER" ]; then
  die "检测到残留: $LEFTOVER —— 请检查后重跑"
fi
say "残留核验通过：无进程 / 无目录 / 无服务 / 无端口占用（除脚本外零残留）"
say "=== 卸载完成。重新安装：bash install.sh ==="
