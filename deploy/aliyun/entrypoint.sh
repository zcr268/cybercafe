#!/bin/sh
set -e
# wrangler dev 从 .dev.vars 读 secret；由容器环境变量注入
echo "ADMIN_TOKEN=${ADMIN_TOKEN:?missing ADMIN_TOKEN}" > /app/cloud/.dev.vars
# KV 等本地状态持久化到 /data（docker volume）
exec wrangler dev --port 8080 --ip 0.0.0.0 --persist-to /data
