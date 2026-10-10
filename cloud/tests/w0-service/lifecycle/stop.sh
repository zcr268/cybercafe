#!/usr/bin/env bash
# 停止被测服务（真实进程）。由 run.sh 调用。
# 收敛语义：kill pidfile 进程 → 轮询直到端口真实释放 → 仍残留则按端口 kill 监听者（防孤儿占端口）。
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

port_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2; exit}'; }

PID_FILE="$OUT_DIR/service.pid"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "已停止服务 PID=$PID"
  else
    echo "(PID 文件进程已不存在 PID=$PID)"
  fi
  rm -f "$PID_FILE"
else
  echo "(无 PID 文件)"
fi

# 端口释放收敛：最多 15s；超时则按端口 kill 监听者（本生命周期模式端口归本套件所有）
for _ in $(seq 1 15); do
  [ -z "$(port_pid)" ] && { echo "端口 $PORT 已释放"; exit 0; }
  sleep 1
done
LPID=$(port_pid)
if [ -n "$LPID" ]; then
  echo "警告: 端口 $PORT 仍被 PID=$LPID 占用（孤儿残留），按端口清理" >&2
  kill "$LPID" 2>/dev/null || true
  for _ in $(seq 1 5); do [ -z "$(port_pid)" ] && break; sleep 1; done
  kill -9 "$LPID" 2>/dev/null || true
fi
echo "端口 $PORT 已释放"
exit 0