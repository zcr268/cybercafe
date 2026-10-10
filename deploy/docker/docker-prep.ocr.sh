#!/usr/bin/env bash
# docker-prep.ocr.sh —— OCR 模型 docker 前置（A 脚本，t106 完备化）
# 约定：每模型一个 docker-prep.<model>.sh（A=前置依赖），模型 install.sh docker 形态为 B 脚本。
# 本脚本：调 base（源/toolkit/runtime）→ OCR 专属（python:3.11-slim 基座预拉 + 预构建
#         cybercafe-ocr:1.1 镜像）→ 写就绪标记 /opt/cybercafe/docker-prep.ocr.done
# 幂等：基座/镜像已存在跳过；标记重跑覆盖；build 上下文用仓库 ocr/ocr.py（L1 已落位 /opt 时可用）。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER="/opt/cybercafe/docker-prep.ocr.done"
IMAGE="cybercafe-ocr:1.1"                    # 与 B 脚本（ocr/install.sh docker 形态）tag 对齐
PORT="8820"
PIP_INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"

bash "$DIR/docker-prep-base.sh"

echo "[docker-prep.ocr] 预拉 OCR 基座 python:3.11-slim（已存在则跳过）"
docker image inspect python:3.11-slim >/dev/null 2>&1 \
  && echo "[docker-prep.ocr] python:3.11-slim 已就位，跳过" \
  || timeout 300 docker pull python:3.11-slim

echo "[docker-prep.ocr] 预构建 ${IMAGE}（已存在则跳过）..."
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[docker-prep.ocr] ${IMAGE} 已就位，跳过构建"
else
  OSAB="$(dirname "$(dirname "$DIR")")/ocr/ocr.py"   # /opt/cybercafe/docker-prep → /opt/ocr/ocr.py
  if [ -f "$OSAB" ]; then
    CTX=$(mktemp -d)
    cat > "$CTX/Dockerfile" <<'DFEOF'
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglvnd0 libglx0 libglib2.0-0 libxcb1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -i __PIP_INDEX__ rapidocr-onnxruntime
WORKDIR /app
COPY ocr.py /app/ocr.py
EXPOSE 8820
CMD ["python", "/app/ocr.py", "--serve", "--host", "0.0.0.0", "--port", "8820"]
DFEOF
    sed -i "s|__PIP_INDEX__|$PIP_INDEX|" "$CTX/Dockerfile"
    cp "$OSAB" "$CTX/ocr.py"
    if ! timeout 600 docker build -t "$IMAGE" "$CTX"; then
      echo "[docker-prep.ocr] ERROR: 镜像预构建失败（见上；B 脚本将现场构建，装机动作不受阻断）" >&2
      rm -rf "$CTX"
      exit 1
    fi
    rm -rf "$CTX"
  else
    echo "[docker-prep.ocr] WARN: 未找到仓库 ocr.py（$OSAB），跳过预构建（B 脚本现场构建）" >&2
  fi
fi

echo "docker-prep.ocr $(date +%s) image=$IMAGE" > "$MARKER"
echo "[docker-prep.ocr] 就绪标记已写（$MARKER）——OCR 前置完成（B 脚本直接 docker run）"
