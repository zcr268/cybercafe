#!/usr/bin/env bash
# W0 云项目真实服务化 · 验证用例运行器
#
# 用法:
#   run.sh --mode baseline [--attach]                # 对现状 wrangler dev 形态录制基线契约
#   run.sh --mode service --cmd "<启动命令>"          # 对新服务形态做全量验收（生命周期/持久化/形态）
#   run.sh --mode service --attach                    # 仅契约冒烟，对已运行端点（不注入通道/不重启）
#   [--with-ego] [--port N] [--data-dir DIR] [--base-url URL] [--agent-src DIR] [--repo-root DIR]
#
# 流程（lifecycle 模式）:
#   起本地静态服务器（AGENT_LOCAL_BASE/AGENT_LOCAL_ROOT_BASE 真实挂载等价物）
#   → 起被测服务（真实进程）→ wait-ready → 用例 10/20/40/30/60/50a
#   → 重启服务（同 DATA_DIR）→ 用例 50b/10(重启后)/70（形态门禁）→ [ego UI] → 汇总
# 输出: .out/ 下 service.log / summary / state.json / 截图；exit 0=全绿
set -u
cd "$(dirname "$0")"
ROOT="$(pwd)"

MODE=baseline; ATTACH=false; WITH_EGO=false; PORT=8788; DATA_DIR=""; CMD=""; BASE_URL_ARG=""; AGENT_SRC_ARG=""; REPO_ROOT_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2;;
    --cmd) CMD="$2"; shift 2;;
    --attach) ATTACH=true; shift;;
    --with-ego) WITH_EGO=true; shift;;
    --port) PORT="$2"; shift 2;;
    --data-dir) DATA_DIR="$2"; shift 2;;
    --base-url) BASE_URL_ARG="$2"; shift 2;;
    --agent-src) AGENT_SRC_ARG="$2"; shift 2;;
    --repo-root) REPO_ROOT_ARG="$2"; shift 2;;
    *) echo "未知参数: $1" >&2; exit 2;;
  esac
done

export PORT MODE
export SERVICE_CMD="$CMD"                       # 传给 lifecycle/start.sh（MODE=service 必填；baseline 空则回落 wrangler dev）
export ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token-8848}"  # nohup 服务子进程经环境继承
BASE_URL="${BASE_URL_ARG:-http://127.0.0.1:${PORT}}"
export BASE_URL
# 每次运行独立 OUT_DIR（.out/run-<pid>）：state.json / service.pid / static pidfile / 截图全部实例隔离，
# 防并发运行（多执行者共享 worktree 时）互踩——已实测踩过（并发实例覆盖 service.pid/state.json 导致假绿）。
export OUT_DIR="$ROOT/.out/run-$$"
export DATA_DIR="${DATA_DIR:-$OUT_DIR/data}"
export AGENT_SRC="${AGENT_SRC_ARG:-$(cd "$ROOT/../../.." && pwd)/agent}"    # 仓库 agent/ 目录
export REPO_ROOT="${REPO_ROOT_ARG:-$(cd "$ROOT/../../.." && pwd)}"          # 仓库根目录
export SHOT_DIR="$OUT_DIR"                      # ego 界面验证截图目录（经 run-ui-check.sh 注入）

mkdir -p "$OUT_DIR" "$DATA_DIR"

# 清理（EXIT trap：任何退出路径都回收 static 服务器与服务进程，防残留）
cleanup() {
  for f in static-agent.pid static-root.pid service.pid; do
    if [ -f "$OUT_DIR/$f" ]; then kill "$(cat "$OUT_DIR/$f")" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

echo "== W0 服务化验证启动 =="
echo "MODE=$MODE BASE_URL=$BASE_URL DATA_DIR=$DATA_DIR ATTACH=$ATTACH"

run_case() { # run_case <case脚本> [arg...]；退出码 77 = 预期红（形态门禁在 baseline 下的录制），计入 0
  local f="$1"; shift
  local name; name=$(basename "$f")
  echo ""
  echo "===== case: $name ====="
  bash "$f" "$@"
  local rc=$?
  if [ "$rc" = 77 ]; then
    echo "！！case $name: 预期红（当前形态不满足该验收点，红色基线已记录，不判 FAIL）"
  elif [ "$rc" != 0 ]; then
    echo "！！case $name: 存在不通过断言（FAIL_COUNT=${rc}）"
    FAIL_TOTAL=1
  fi
}

FAIL_TOTAL=0

# ---------- 本地静态通道服务器（真实 HTTP，等价生产 public/_agent 与 /_repo 挂载） ----------
if ! $ATTACH; then
  echo "== 启动本地静态通道服务器（agent/ + 仓库根） =="
  AGENT_PORT=$((20000 + RANDOM % 10000))
  ROOT_PORT=$((30000 + RANDOM % 10000))
  node "$ROOT/lifecycle/static-server.mjs" "$AGENT_SRC" "$AGENT_PORT" >"$OUT_DIR/static-agent.log" 2>&1 &
  echo $! > "$OUT_DIR/static-agent.pid"
  node "$ROOT/lifecycle/static-server.mjs" "$REPO_ROOT" "$ROOT_PORT" >"$OUT_DIR/static-root.log" 2>&1 &
  echo $! > "$OUT_DIR/static-root.pid"
  for _ in $(seq 1 20); do
    curl -s -m 1 -o /dev/null "http://127.0.0.1:$AGENT_PORT/cybercafe-agent.py" && break
    sleep 0.5
  done
  export AGENT_LOCAL_BASE="http://127.0.0.1:$AGENT_PORT"
  export AGENT_LOCAL_ROOT_BASE="http://127.0.0.1:$ROOT_PORT"
  echo "AGENT_LOCAL_BASE=$AGENT_LOCAL_BASE AGENT_LOCAL_ROOT_BASE=$AGENT_LOCAL_ROOT_BASE"

  # ---------- 被测服务（真实进程） ----------
  bash lifecycle/start.sh || { echo "服务启动失败，见 .out/service.log" >&2; exit 1; }
  bash lifecycle/wait-ready.sh || { echo "服务未就绪，见 .out/service.log" >&2; exit 1; }
  echo "服务已就绪 PID=$(cat "$OUT_DIR/service.pid")"
fi

# ---------- 契约用例 ----------
run_case cases/10-static-ui.sh
run_case cases/20-route-contract.sh
run_case cases/40-admin-api.sh
run_case cases/30-device-api.sh
if $ATTACH; then
  echo "(attach 模式：跳过通道注入/持久化重启/形态门禁用例)"
else
  run_case cases/60-script-channel.sh
  run_case cases/50-persistence.sh a

  # ---------- 重启（同 DATA_DIR，验证 KV 持久化真实落盘不丢） ----------
  echo ""
  echo "===== 重启被测服务（同 DATA_DIR=${DATA_DIR}） ====="
  bash lifecycle/stop.sh
  bash lifecycle/start.sh
  bash lifecycle/wait-ready.sh || { echo "重启后服务未就绪" >&2; FAIL_TOTAL=1; }
  run_case cases/50-persistence.sh b
  run_case cases/10-static-ui.sh            # 重启后静态 UI 仍可用
  run_case cases/70-form.sh                 # 形态门禁：真实进程非 wrangler + KV 本地文件
fi

# ---------- ego 浏览器真实页面 UI 验证 ----------
if $WITH_EGO; then
  echo ""
  echo "===== ego 浏览器真实页面 UI 验证 ====="
  out=$(bash ego/run-ui-check.sh 2>&1)
  echo "$out" | tail -8
  if echo "$out" | grep -q '"conclusion":"PASS"'; then echo "EGO UI: PASS"; else echo "EGO UI: FAIL"; FAIL_TOTAL=1; fi
fi

echo ""
echo "==============================================="
if [ "$FAIL_TOTAL" = 1 ]; then
  echo "W0 验证结果: FAIL（存在不通过断言，见上方 not ok / 红标记）"
  exit 1
fi
echo "W0 验证结果: PASS（MODE=$MODE BASE_URL=${BASE_URL}）"
exit 0