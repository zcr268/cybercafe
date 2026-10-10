#!/usr/bin/env bash
# W0 云项目真实服务化 · 验证用例公共库
# 用法: . ./lib/common.sh （各 cases/*.sh 与 run.sh 均以本文件为公共基础）
#
# 被测路径声明（真实路径承诺，禁止 mock）：
#   本套件所有断言都通过 curl 直连真实 HTTP 端点（BASE_URL），服务以真实进程运行
#   （lifecycle/start.sh 启动），KV 持久化必须落盘为真实本地文件（service 形态契约为
#   DATA_DIR/kv.json），脚本分发通道走真实本地静态服务器或真实 raw/jsDelivr 网络。
#   任何进程内共享通道、内存模拟传输、假持久化一律不算通过。

set -u

# ---------- 环境（契约） ----------
BASE_URL="${BASE_URL:-http://127.0.0.1:8788}"     # 被测服务真实端点
ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token-8848}" # 管理鉴权 Bearer（本地沙箱默认值）
PORT="${PORT:-8788}"                               # 被测服务监听端口
MODE="${MODE:-baseline}"                           # baseline=wrangler dev 现状 / service=新独立服务形态
DATA_DIR="${DATA_DIR:-}"                           # KV 持久化目录（service 形态契约：DATA_DIR/kv.json）
OUT_DIR="${OUT_DIR:-$(pwd)/.out}"                  # 运行产物（日志/状态/截图），已 gitignore
CURL_TIMEOUT="${CURL_TIMEOUT:-10}"

mkdir -p "$OUT_DIR"

# ---------- TAP 风格结果 ----------
TEST_N=0; FAIL_N=0; SKIP_N=0
ok()      { TEST_N=$((TEST_N+1)); printf 'ok %d - %s\n'    "$TEST_N" "$1"; }
skip()    { TEST_N=$((TEST_N+1)); SKIP_N=$((SKIP_N+1)); printf 'skip %d - %s\n' "$TEST_N" "$1"; }
not_ok()  { TEST_N=$((TEST_N+1)); FAIL_N=$((FAIL_N+1)); printf 'not ok %d - %s\n' "$TEST_N" "$1"; }

# ---------- HTTP 请求 helper ----------
# req METHOD PATH [curl 额外参数...] → 设 $HTTP_CODE $BODY $CTYPE $BODY_FILE（原始响应体文件）
_TMP_BODY="${OUT_DIR}/.last_body.$$"
req() {
  local m="$1" p="$2"; shift 2
  HTTP_CODE=$(curl -s -m "$CURL_TIMEOUT" -X "$m" -o "$_TMP_BODY" -w '%{http_code}' "$@" "${BASE_URL}${p}" 2>/dev/null || echo 000)
  BODY_FILE="$_TMP_BODY"
  BODY=$(cat "$_TMP_BODY" 2>/dev/null || true)
  CTYPE=$(curl -s -m "$CURL_TIMEOUT" -X "$m" -o /dev/null -w '%{content_type}' "$@" "${BASE_URL}${p}" 2>/dev/null || true)
}

# req_json METHOD PATH [curl 额外参数...] → 另设 ${JSON_OK}（body 是否为合法 JSON）
req_json() {
  req "$@"
  JSON_OK=false
  if [ "$HTTP_CODE" != "000" ] && [ -n "$BODY" ]; then
    if node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' <<<"$BODY" 2>/dev/null; then JSON_OK=true; fi
  fi
}

# json_field <json文本> <点路径> → stdout（取不到输出空串；对象/数组输出 JSON 串）
json_field() {
  node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const k=process.argv[1].split(".");let v=d;for(const x of k){if(v==null)break;v=v[x];}if(v===undefined)process.exit(1);console.log(typeof v==="object"?JSON.stringify(v):String(v));' "$2" <<<"$1" 2>/dev/null || true
}

# ---------- 跨用例状态（.out/state.json） ----------
save_state() { node -e 'const fs=require("fs");const p=process.argv[1];let d={};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}d[process.argv[2]]=process.argv[3];fs.writeFileSync(p,JSON.stringify(d))' "$OUT_DIR/state.json" "$1" "$2"; }
load_state() { node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=d[process.argv[2]];console.log(v===undefined?"":String(v))}catch(e){console.log("")}' "$OUT_DIR/state.json" "$1"; }

# ---------- 断言 ----------
# assert_code <描述> <期望HTTP码>        （基于最近一次 req）
assert_code() {
  local d="$1" e="$2"
  if [ "$HTTP_CODE" = "$e" ]; then ok "$d (HTTP $HTTP_CODE)"; else not_ok "$d (HTTP=${HTTP_CODE}，期望 $e)"; fi
}
# assert_contains <描述> <needle> <haystack>
assert_contains() {
  local d="$1" n="$2" h="$3"
  if printf '%s' "$h" | grep -qF -- "$n"; then ok "$d"; else not_ok "${d}（缺少内容: ${n}）"; fi
}
# assert_eq <描述> <actual> <expected>
assert_eq() {
  local d="$1" a="$2" e="$3"
  if [ "$a" = "$e" ]; then ok "$d (=$e)"; else not_ok "$d (actual=$a expected=$e)"; fi
}
# assert_json_ok <描述>（基于最近一次 req_json：ok 字段 == true）
assert_json_ok() {
  if [ "$JSON_OK" = true ] && [ "$(json_field "$BODY" ok)" = "true" ]; then ok "$1"; else not_ok "$1（body=${BODY}）"; fi
}
# assert_json_field <描述> <点路径> <期望值>
assert_json_field() {
  local d="$1" p="$2" e="$3" a
  a=$(json_field "$BODY" "$p")
  if [ "$a" = "$e" ]; then ok "$d (=$e)"; else not_ok "$d (actual=$a expected=$e)"; fi
}

# ---------- 汇总 ----------
# summary <case名>：输出汇总；失败返回 1
summary() {
  printf '\n# %s: %d tests, %d failed, %d skipped\n' "$1" "$TEST_N" "$FAIL_N" "$SKIP_N"
  [ "$FAIL_N" -eq 0 ] || return 1
}
