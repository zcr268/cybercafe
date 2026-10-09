#!/bin/sh
set -e
# wrangler dev 从 .dev.vars 读 secret/var；由容器环境变量注入
echo "ADMIN_TOKEN=${ADMIN_TOKEN:?missing ADMIN_TOKEN}" > /app/cloud/.dev.vars
# GITHUB_RAW_BASE 可选覆盖：aliyun 出口访问 raw.githubusercontent.com 超时，
# 默认用 jsDelivr 镜像（在 compose 中注入）作为网络回退；部署到真实 CF Worker 时可用原值
if [ -n "${GITHUB_RAW_BASE:-}" ]; then
    echo "GITHUB_RAW_BASE=${GITHUB_RAW_BASE}" >> /app/cloud/.dev.vars
fi
# AGENT_LOCAL_BASE（compose 挂载仓库 agent/ → public/_agent）：cloud 侧首选通道，
# worker 经 loopback HTTP 取 dev server 静态资源，git pull 后即时生效
if [ -n "${AGENT_LOCAL_BASE:-}" ]; then
    echo "AGENT_LOCAL_BASE=${AGENT_LOCAL_BASE}" >> /app/cloud/.dev.vars
fi
# AGENT_LOCAL_ROOT_BASE（compose 挂载仓库根 → public/_repo）：根目录通道（t41，
# ocr/*、minimax-h3/*、uninstall-all.sh）——漏注入会让根通道跳过本地、走 jsDelivr
# 12h 旧缓存（t88：生产 OCR 下发到无 CORS 旧版 ocr.py 的根因），必须同款注入
if [ -n "${AGENT_LOCAL_ROOT_BASE:-}" ]; then
    echo "AGENT_LOCAL_ROOT_BASE=${AGENT_LOCAL_ROOT_BASE}" >> /app/cloud/.dev.vars
fi
exec wrangler dev --port 8080 --ip 0.0.0.0 --persist-to /data
