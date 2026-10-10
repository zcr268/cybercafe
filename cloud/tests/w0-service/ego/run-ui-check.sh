#!/usr/bin/env bash
# ego 浏览器真实页面 UI 验证运行器（run.sh --with-ego 调用）
# 以 stdin 方式把 ui-check.mjs 交给 ego-browser-dsh nodejs 执行（兼容两种 ego 一代面）。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
if command -v ego-browser-dsh >/dev/null 2>&1; then
  ego-browser-dsh nodejs < "$DIR/ui-check.mjs"
elif command -v ego-browser >/dev/null 2>&1; then
  ego-browser nodejs < "$DIR/ui-check.mjs"
else
  echo '{"conclusion":"FAIL","error":"ego-browser-dsh / ego-browser 命令不可用"}' >&2
  exit 2
fi
