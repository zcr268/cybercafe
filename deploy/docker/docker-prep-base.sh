#!/usr/bin/env bash
# docker-prep-base.sh —— docker 前置依赖统一准备（A 脚本之通用 base，幂等）
# 供 L1 装机预装与 L3 运行时兜底调用；模型专属前置见 docker-prep.<model>.sh（调用本 base）。
#
# 功能（全程不重启机器，只重启 docker 服务）：
#   ① daemon.json 国内镜像源（幂等：已有 daocloud 源则跳过；已有文件则合并不覆盖）
#   ② nvidia-container-toolkit 检测；缺失 → 从本仓库 assets/ 本地 dpkg 安装（绕开
#      nvidia.github.io 不可达；不依赖外网）
#   ③ nvidia-ctk runtime configure 注册 nvidia runtime（幂等）
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="${DOCKER_PREP_ASSETS:-$BASE_DIR/assets}"
DAEMON_JSON="/etc/docker/daemon.json"
MIRRORS=(
  "https://docker.m.daocloud.io"
  "https://docker.1ms.run"
  "https://docker.xuanyuan.me"
  "https://dockerhub.icu"
  "https://docker.1panel.live"
)

NEED_RESTART=0

# ---------- ① daemon.json 镜像源（幂等合并） ----------
if [ -f "$DAEMON_JSON" ] && grep -q "docker.m.daocloud.io" "$DAEMON_JSON"; then
  echo "[docker-prep] daemon.json 镜像源已置（daocloud 在位），跳过"
else
  if [ -f "$DAEMON_JSON" ]; then
    # 已有文件且无 daocloud 源：合并（保留已有其余键，不覆盖）
    python3 - "$DAEMON_JSON" <<'PYEOF'
import json, sys
p = sys.argv[1]
data = json.load(open(p))
existing = set(data.get("registry-mirrors", []))
add = ["https://docker.m.daocloud.io", "https://docker.1ms.run", "https://docker.xuanyuan.me",
       "https://dockerhub.icu", "https://docker.1panel.live"]
cur = list(existing)
for m in add:
    if m not in existing:
        cur.append(m)
data["registry-mirrors"] = cur
json.dump(data, open(p, "w"), indent=2, ensure_ascii=False)
PYEOF
  else
    cat > "$DAEMON_JSON" <<JSON
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me",
    "https://dockerhub.icu",
    "https://docker.1panel.live"
  ]
}
JSON
  fi
  NEED_RESTART=1
  echo "[docker-prep] daemon.json 镜像源已写入（合并保留既有键）"
fi

# ---------- ② nvidia-container-toolkit（本地 .deb，幂等） ----------
if command -v nvidia-ctk >/dev/null 2>&1; then
  echo "[docker-prep] nvidia-container-toolkit 已安装（$(nvidia-ctk --version 2>/dev/null | head -1 || echo nvidia-ctk)），跳过"
elif ls "$ASSETS_DIR"/nvidia-container-toolkit*.deb >/dev/null 2>&1; then
  echo "[docker-prep] 安装 nvidia-container-toolkit（本地资产，依赖顺序 dpkg）..."
  # 先装库/工具（base 依赖），最后装 toolkit（依赖 libnvidia-container1/dev/tools）
  dpkg -i "$ASSETS_DIR"/libnvidia-container1_*.deb "$ASSETS_DIR"/libnvidia-container-tools_*.deb \
        "$ASSETS_DIR"/libnvidia-container-dev_*.deb "$ASSETS_DIR"/nvidia-container-toolkit-base_*.deb >/dev/null 2>&1 || true
  dpkg -i "$ASSETS_DIR"/nvidia-container-toolkit_*.deb >/dev/null 2>&1 || true
  apt-get -f install -y >/dev/null 2>&1 || true     # 依赖缺口兜底（本地资产齐备时通常无缺口）
  if command -v nvidia-ctk >/dev/null 2>&1; then
    NEED_RESTART=1
    echo "[docker-prep] toolkit 安装完成（本地 dpkg，未依赖外网）"
  else
    echo "[docker-prep] ERROR: toolkit 安装仍不可用（资产不完整？请核对 assets/*.deb）" >&2
  fi
else
  echo "[docker-prep] WARN: 未找到 toolkit 且资产库无 .deb（$ASSETS_DIR）——跳过（运行 `docker run --gpus all` 将失败）" >&2
fi

# ---------- ③ nvidia runtime 注册（幂等） ----------
if docker info 2>/dev/null | grep -q "nvidia"; then
  echo "[docker-prep] nvidia runtime 已注册，跳过"
elif command -v nvidia-ctk >/dev/null 2>&1; then
  nvidia-ctk runtime configure --runtime=docker >/dev/null 2>&1 || true
  NEED_RESTART=1
  echo "[docker-prep] nvidia runtime 已注册（nvidia-ctk runtime configure）"
fi

# ---------- ④ 仅重启 docker 服务（不重启机器） ----------
if [ "$NEED_RESTART" = "1" ]; then
  systemctl restart docker
  sleep 3
  echo "[docker-prep] docker 服务已重启（机器未重启）"
fi

echo "[docker-prep] docker 前置就绪（幂等，可重复执行）"