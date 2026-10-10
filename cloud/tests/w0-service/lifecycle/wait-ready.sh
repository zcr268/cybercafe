#!/usr/bin/env bash
# 等待被测服务就绪：BASE_URL/ 返回 200（真实 TCP/HTTP 可达）。由 run.sh 调用。
# 就绪后核验「端口监听者 PID == service.pid」：
#   - 不匹配且 pidfile 进程已死 → 新进程启动失败（如 EADDRINUSE/崩溃），FAIL 而非假绿
#     （防「重启未真正生效、断言落在旧孤儿进程上」的静默误判）
#   - lsof 不可用（沙箱受限）→ 降级为 pidfile 进程存活检查并注明
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

port_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2; exit}'; }

for i in $(seq 1 60); do
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$BASE_URL/" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "服务就绪: $BASE_URL (${i}s)"
    PID_FILE_PID=$(cat "$OUT_DIR/service.pid" 2>/dev/null || true)
    LISTENER=$(port_pid)
    if command -v lsof >/dev/null 2>&1 && [ -n "$LISTENER" ]; then
      if [ -n "$PID_FILE_PID" ] && [ "$LISTENER" = "$PID_FILE_PID" ]; then
        echo "监听者核验: 端口 $PORT 监听 PID=$LISTENER == service.pid，一致"
        exit 0
      fi
      echo "FAIL: 端口 $PORT 监听者 PID=$LISTENER ≠ service.pid($PID_FILE_PID)；" >&2
      echo "      说明新进程未生效（可能 EADDRINUSE 崩溃），见 .out/service.log" >&2
      exit 1
    fi
    # lsof 不可用：降级检查 pidfile 进程存活
    if [ -n "$PID_FILE_PID" ] && ! kill -0 "$PID_FILE_PID" 2>/dev/null; then
      echo "FAIL: service.pid($PID_FILE_PID) 进程不存在（服务启动失败），见 .out/service.log" >&2
      exit 1
    fi
    echo "监听者核验: lsof 不可用，降级为 pidfile 进程存活检查（PID=$PID_FILE_PID）"
    exit 0
  fi
  if [ -f "$OUT_DIR/service.pid" ]; then
    kill -0 "$(cat "$OUT_DIR/service.pid")" 2>/dev/null || { echo "服务进程已退出，见 .out/service.log" >&2; exit 1; }
  fi
  sleep 1
done
echo "等待超时: $BASE_URL 60s 未就绪，见 .out/service.log" >&2
exit 1
