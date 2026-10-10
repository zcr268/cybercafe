#!/usr/bin/env bash
# ego 浏览器真实页面 UI 验证运行器（run.sh --with-ego 调用）
# 实测：ego-browser-dsh nodejs 子进程 process.env 为空（BASE_URL/ADMIN_TOKEN/SHOT_DIR 不传播），
# 故运行参数由本脚本（继承 run.sh 的 export）写入绝对路径配置文件，再以
# __UI_ENV_CFG__ 占位符注入 ui-check.mjs（stdin 管道方式，兼容两种 ego 一代面）。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/.out"
CFG="$DIR/.out/ui-env.json"
node -e 'const fs=require("fs");const shot=process.env.SHOT_DIR||process.argv[2];fs.writeFileSync(process.argv[1],JSON.stringify({base:process.env.BASE_URL||"http://127.0.0.1:8788",token:process.env.ADMIN_TOKEN||"dev-admin-token-8848",shotDir:shot}));' "$CFG" "$DIR/.out"
if command -v ego-browser-dsh >/dev/null 2>&1; then
  sed "s|__UI_ENV_CFG__|$CFG|g" "$DIR/ui-check.mjs" | ego-browser-dsh nodejs
elif command -v ego-browser >/dev/null 2>&1; then
  sed "s|__UI_ENV_CFG__|$CFG|g" "$DIR/ui-check.mjs" | ego-browser nodejs
else
  echo '{"conclusion":"FAIL","error":"ego-browser-dsh / ego-browser 命令不可用"}' >&2
  exit 2
fi
