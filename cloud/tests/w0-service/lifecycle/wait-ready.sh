#!/usr/bin/env bash
# 等待被测服务就绪：BASE_URL/ 返回 200（真实 TCP/HTTP 可达）。由 run.sh 调用。
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

for i in $(seq 1 60); do
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$BASE_URL/" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then echo "服务就绪: $BASE_URL (${i}s)"; exit 0; fi
  if [ -f "$OUT_DIR/service.pid" ]; then
    kill -0 "$(cat "$OUT_DIR/service.pid")" 2>/dev/null || { echo "服务进程已退出，见 .out/service.log" >&2; exit 1; }
  fi
  sleep 1
done
echo "等待超时: $BASE_URL 60s 未就绪，见 .out/service.log" >&2
exit 1