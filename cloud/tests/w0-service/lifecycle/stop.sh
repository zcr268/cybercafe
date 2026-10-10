#!/usr/bin/env bash
# 停止被测服务（真实进程）。由 run.sh 调用。
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

PID_FILE="$OUT_DIR/service.pid"
if [ ! -f "$PID_FILE" ]; then echo "(无 PID 文件，跳过停止)"; exit 0; fi
PID=$(cat "$PID_FILE")
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  kill -9 "$PID" 2>/dev/null || true
  echo "已停止服务 PID=$PID"
else
  echo "(进程已不存在 PID=$PID)"
fi
rm -f "$PID_FILE"