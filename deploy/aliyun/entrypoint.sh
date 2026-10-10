#!/bin/sh
set -e
# W0 服务化形态（t18）：真实独立 HTTP 服务 node server.js。
# server.js 直接读取容器环境变量——compose environment 注入
# PORT=8080 / DATA_DIR=/data / ADMIN_TOKEN / GITHUB_RAW_BASE / JSDELIVR_RAW_BASE /
# AGENT_LOCAL_BASE / AGENT_LOCAL_ROOT_BASE，不再依赖 wrangler / .dev.vars。
# KV 持久化到 DATA_DIR/kv.json（compose 卷挂载 /data，重启同卷数据不丢）。
exec node server.js
