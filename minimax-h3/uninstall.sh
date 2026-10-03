#!/usr/bin/env bash
# =============================================================================
# MiniMax-H3 一键卸载 + 全面清理 uninstall.sh
# 删除：全部权重（GGUF/VAE）、sd.cpp 二进制、缓存、日志、冒烟产物、
#       可能存在的常驻 sd-server 进程、预下载脚本；/opt/minimax-h3 整体移除。
# 零系统残留：install.sh 只使用预编译二进制 + 直接下载，未安装任何系统包/服务。
# 保留：本脚本与 install.sh（「除脚本外零残留」约定）。
# 可逆：重新执行 install.sh 即可恢复（权重需重新下载）。
# =============================================================================
set -uo pipefail

BASE=/opt/minimax-h3

log() { echo "[minimax-h3-uninstall] $*"; }

[ "$(id -u)" = 0 ] || { log "需要 root"; exit 1; }

log "=== MiniMax-H3 卸载开始 ==="

# ---------- 1) 终止进程（sd-cli/sd-server 与本部署相关） ----------
PIDS=$(pgrep -f "minimax-h3|sd-cli|sd-server" 2>/dev/null | grep -v $$ || true)
if [ -n "$PIDS" ]; then
  log "终止进程: $PIDS"
  kill $PIDS 2>/dev/null; sleep 2
  kill -9 $PIDS 2>/dev/null || true
fi
# 兜底：容器内无部署（H3 未用容器），此处仅防御性检查
pgrep -f "minimax_h3|qwen3vl_32b_minimax_h3" >/dev/null 2>&1 && log "警告：仍有模型进程残留" || log "无模型进程 ✓"

# ---------- 2) 删除部署目录（权重/二进制/日志/冒烟产物/manifest/脚本副本） ----------
if [ -d "$BASE" ]; then
  du -sh "$BASE" 2>/dev/null | awk '{print "释放磁盘: "$1}'
  rm -rf "$BASE"
  [ -d "$BASE" ] && { log "ERROR: $BASE 未能删除"; exit 1; } || log "已删除 $BASE ✓"
else
  log "$BASE 不存在（已清理过）"
fi

# ---------- 3) 清理可能的 HF 缓存（install.sh 为直接下载，正常无残留；防御性清扫） ----------
for d in "$HOME/.cache/huggingface/hub/models--MiniMaxAI--MiniMax-H3" \
         "$HOME/.cache/huggingface/hub/models--unsloth--MiniMax-H3-GGUF" \
         "$HOME/.cache/huggingface/hub/models--Comfy-Org--MiniMax-H3"; do
  [ -e "$d" ] && rm -rf "$d" && log "清理 HF 缓存: $d"
done
rm -f /root/dl_h3.sh
log "清理预下载脚本 /root/dl_h3.sh（如有）"

# ---------- 4) 残留验证 ----------
sleep 1
LEFTS=$(ls -la "$BASE" 2>/dev/null || echo "GONE")
PROCS=$(pgrep -f "minimax_h3|qwen3vl_32b_minimax_h3|sd-cli|sd-server" 2>/dev/null | wc -l)
DISK_AFTER=$(df -Pm / | awk 'NR==2{print $4}')
log "目录: $LEFTS"
log "残留进程数: $PROCS"
log "当前磁盘可用: ${DISK_AFTER}MB"
[ "$PROCS" -eq 0 ] && [ ! -d "$BASE" ] && log "=== 卸载完成，零残留 ✓（可逆：重跑 install.sh 恢复） ===" || { log "=== 有残留，请检查上述输出 ==="; exit 1; }
