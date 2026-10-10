#!/usr/bin/env bash
# 启动被测服务（真实进程，生命周期入口）。由 run.sh 调用，继承其导出环境。
#   MODE=baseline : SERVICE_CMD 未给时用 wrangler dev（.dev.vars 注入，与生产 entrypoint.sh 同款）
#   MODE=service  : SERVICE_CMD 必须给出新服务形态启动命令（真实进程，禁止 wrangler dev）
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

SERVICE_CMD="${SERVICE_CMD:-}"
WRANGLER_CMD="${WRANGLER_CMD:-npx --yes wrangler@latest}"

if [ -z "$SERVICE_CMD" ]; then
  if [ "$MODE" = "baseline" ]; then
    SERVICE_CMD="$WRANGLER_CMD dev --port $PORT --ip 127.0.0.1 --persist-to '$DATA_DIR'"
  else
    echo "ERROR: MODE=service 必须提供 --cmd \"<启动命令>\"（新服务形态，见 README）" >&2
    exit 2
  fi
fi

# baseline（wrangler dev）经 .dev.vars 读 secret/var：与生产 entrypoint.sh 同款注入
if [ "$MODE" = "baseline" ]; then
  VARS_FILE="$(pwd)/.dev.vars"
  : > "$VARS_FILE"
  printf 'ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN" >> "$VARS_FILE"
  [ -n "${GITHUB_RAW_BASE:-}" ]      && printf 'GITHUB_RAW_BASE=%s\n' "$GITHUB_RAW_BASE" >> "$VARS_FILE"
  [ -n "${JSDELIVR_RAW_BASE:-}" ]    && printf 'JSDELIVR_RAW_BASE=%s\n' "$JSDELIVR_RAW_BASE" >> "$VARS_FILE"
  [ -n "${AGENT_LOCAL_BASE:-}" ]     && printf 'AGENT_LOCAL_BASE=%s\n' "$AGENT_LOCAL_BASE" >> "$VARS_FILE"
  [ -n "${AGENT_LOCAL_ROOT_BASE:-}" ] && printf 'AGENT_LOCAL_ROOT_BASE=%s\n' "$AGENT_LOCAL_ROOT_BASE" >> "$VARS_FILE"
fi

# 真实进程：nohup 拉起到独立会话，环境变量经 export 继承。
# exec 前缀让 bash 壳直接替换为服务进程（$! 即真实服务 PID，避免 kill 壳后 node 孤儿占端口）。
nohup bash -c "exec $SERVICE_CMD" >"$OUT_DIR/service.log" 2>&1 &
echo $! > "$OUT_DIR/service.pid"
echo "启动: $SERVICE_CMD (PID $(cat "$OUT_DIR/service.pid"))"