#!/usr/bin/env bash
# docker-prep.sglang.sh —— sglang 引擎 docker 前置（A 脚本；B 脚本=cybercafe-deploy.py 既有 docker run 流程）
# 约定：调用 t104 base（源/toolkit/runtime）+ 引擎专属前置（镜像预拉，走 daocloud 源）；
# 完成写就绪标记 /opt/cybercafe/docker-prep.sglang.done（L3 step_docker_prep 检测跳过）。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="${DOCKER_PREP_BASE:-$DIR}/docker-prep-base.sh"
[ -f "$base" ] || base="$(dirname "$DIR")/deploy/docker/docker-prep-base.sh"
[ -f "$base" ] || { echo "[docker-prep.sglang] WARN: 未找到 docker-prep-base.sh（跳过 base）" >&2; }
[ -f "$base" ] && bash "$base"
IMG="lmsysorg/sglang:v0.4.1.post4-cu121"
echo "[docker-prep.sglang] 预拉镜像 $IMG（已存在则跳过）"
if docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "[docker-prep.sglang] $IMG 已就位，跳过拉取"
else
  timeout 900 docker pull "$IMG" || { echo "[docker-prep.sglang] ERROR: 镜像拉取失败" >&2; exit 1; }
fi
touch "/opt/cybercafe/docker-prep.sglang.done"
echo "[docker-prep.sglang] 就绪（标记 /opt/cybercafe/docker-prep.sglang.done）"
