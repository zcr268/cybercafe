#!/bin/sh
set -e
# wrangler dev 从 .dev.vars 读 secret/var；由容器环境变量注入
echo "ADMIN_TOKEN=${ADMIN_TOKEN:?missing ADMIN_TOKEN}" > /app/cloud/.dev.vars
# GITHUB_RAW_BASE 可选覆盖：aliyun 出口访问 raw.githubusercontent.com 超时，
# 默认用 jsDelivr 镜像（在 compose 中注入）作为网络回退；部署到真实 CF Worker 时可用原值
if [ -n "${GITHUB_RAW_BASE:-}" ]; then
    echo "GITHUB_RAW_BASE=${GITHUB_RAW_BASE}" >> /app/cloud/.dev.vars
fi
# AGENT_LOCAL_DIR（compose 挂载仓库 agent/）：cloud 侧首选通道，git pull 后即时生效
if [ -n "${AGENT_LOCAL_DIR:-}" ]; then
    echo "AGENT_LOCAL_DIR=${AGENT_LOCAL_DIR}" >> /app/cloud/.dev.vars
fi
exec wrangler dev --port 8080 --ip 0.0.0.0 --persist-to /data
