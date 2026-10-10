#!/usr/bin/env bash
# 用例: W0-1 · 静态 UI 由服务自身提供且可访问（验收点 2）
# 断言: / 与 /index.html 由被测服务自身返回（curl 直连 BASE_URL，真实端点），
#       页面含管理 UI 关键骨架，未知路径 404（静态边界正确）。
set -u
cd "$(dirname "$0")/.."
. ./lib/common.sh

req_json GET /
assert_code "GET / 返回 200" 200
assert_contains "GET / 响应为管理 UI 页面（含标题）" "CyberCafe 云管理" "$BODY"
assert_contains "GET / 含登录面板骨架 #tokenIn" 'id="tokenIn"' "$BODY"
assert_contains "GET / 含设备表骨架 #devRows" 'id="devRows"' "$BODY"
assert_contains "GET / 含批次表骨架 #batchRows" 'id="batchRows"' "$BODY"

req_json GET /index.html
assert_code "GET /index.html 返回 200" 200
if [ "$(json_field "$BODY" title)" = "" ]; then
  # /index.html 为 HTML（非 JSON）
  assert_contains "GET /index.html 与 / 同一页面" "CyberCafe 云管理" "$BODY"
fi

# 静态边界：未知路径由被测服务自身 404（不是反代吞掉、也不是误回首页）
req GET /no-such-page-xyz.html
assert_code "未知静态路径 404" 404

req GET /api/device/unknown-route
assert_code "未知设备侧路由 404" 404

summary "10-static-ui"
