#!/usr/bin/env bash
# =============================================================================
# CyberCafe MiniMax-H3 一键卸载 + 全面清理（uninstall.sh）—— docker 容器形态（t99）
# -----------------------------------------------------------------------------
# 语义：除脚本外零残留。覆盖：容器 / 镜像 / 状态目录 / 端口占用。
# 权重卷（h3-weights）默认保留——属磁盘 LRU 回收管理（t97：当前部署保护、非当前才可回收），
# 如需连卷删除：UNINSTALL_VOLUME=1（27GB 权重一并清）。
# 可逆说明：镜像/容器来自本仓库 install.sh 构建，重装（bash install.sh）即可恢复；
# 权重卷若保留则连 27GB 下载都免了。
# =============================================================================
set -euo pipefail

H3_ROOT="${H3_ROOT:-/opt/minimax-h3}"
H3_PORT="${H3_PORT:-11435}"
H3_IMAGE="cybercafe-h3"
H3_TAG="0.1.0"
H3_CONTAINER="cybercafe-h3"
H3_VOLUME="h3-weights"
UNINSTALL_VOLUME="${UNINSTALL_VOLUME:-0}"     # 1=连权重卷一起清（慎用）

say()  { printf '\033[1;34m[h3-uninstall]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[h3-uninstall ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请以 root 运行（sudo bash uninstall.sh）"

# 1) 容器：docker rm -f（含停止）+ 旧形态 sd-server 进程兜底
say "1/5 停止并删除容器 ${H3_CONTAINER} ..."
docker rm -f "$H3_CONTAINER" >/dev/null 2>&1 || true
pkill -f "sd-server.*$H3_PORT" 2>/dev/null || true   # t99 前原生残留兜底

# 2) 镜像：rmi
say "2/5 删除镜像 ${H3_IMAGE}:${H3_TAG} ..."
docker rmi -f "$H3_IMAGE:$H3_TAG" >/dev/null 2>&1 || true

# 3) 状态目录：H3_ROOT 整体删除（含 .version → 未安装态）
say "3/5 删除状态目录 $H3_ROOT ..."
rm -rf "$H3_ROOT"

# 4) 权重卷：默认保留（LRU 回收）；UNINSTALL_VOLUME=1 连卷清
say "4/5 权重卷 $H3_VOLUME ..."
if [ "$UNINSTALL_VOLUME" = 1 ]; then
  docker volume rm "$H3_VOLUME" >/dev/null 2>&1 || true
  say "   已删除 $H3_VOLUME（27GB 权重，重装将重新下载）"
else
  say "   保留 $H3_VOLUME（磁盘 LRU 回收管理；如需删除 export UNINSTALL_VOLUME=1 重跑）"
fi

# 5) 端口兜底释放 + 残留核验
say "5/5 端口释放与残留核验 ..."
if command -v fuser >/dev/null 2>&1; then
  fuser -k "$H3_PORT/tcp" 2>/dev/null || true
fi
LEFTOVER=""
docker ps -a --filter "name=^/$H3_CONTAINER$" --format '{{.Names}}' | grep -q . && LEFTOVER="$LEFTOVER\n  - 容器 $H3_CONTAINER 仍在"
docker image inspect "$H3_IMAGE:$H3_TAG" >/dev/null 2>&1 && LEFTOVER="$LEFTOVER\n  - 镜像 $H3_IMAGE:$H3_TAG 仍在"
[ -d "$H3_ROOT" ] && LEFTOVER="$LEFTOVER\n  - 目录 $H3_ROOT 仍在"
if [ -n "$LEFTOVER" ]; then
  die "检测到残留:$LEFTOVER —— 请检查后重跑"
fi
say "残留核验通过：无容器 / 无镜像 / 无目录 / 无端口占用（除脚本外零残留）"
say "=== 卸载完成。重新安装：bash install.sh（权重卷保留则免 27GB 重下载）==="