#!/usr/bin/env bash
# migrate-kv.sh —— W0 服务化 KV 迁移脚本（防再次丢数据）
#
# 背景：W0 服务化（t18）把 KV 持久化从 wrangler/miniflare sqlite（DATA_DIR/v3/kv/...）
# 切换为 DATA_DIR/kv.json（JSON 对象 key→字符串）。升级容器后首次启动为空库，
# 旧设备/批次数据若不迁移会全部消失（t28 事故：两台生产机器曾因此不见）。
# 本脚本把旧 sqlite + blobs 还原并合并进现 kv.json。
#
# 职责：
#   1) 检测 DATA_DIR/v3/kv/ 下是否存在旧 sqlite（*.sqlite，排除 metadata/-wal/-shm）与 blobs/ 目录
#   2) 用 node:sqlite 读 _mf_entries(key, blob_id[, expiration]) + blobs/<blob_id> 文件还原全部键值
#      （值 = blob 文件内容 UTF-8；expiration 已过期的键跳过）
#   3) 与现 DATA_DIR/kv.json 合并：旧库优先（同键以旧库为准），新库独有键保留
#   4) 先备份现 kv.json（kv.json.bak-<YYYYMMDD-HHMMSS>）再原子写回（独立 tmp 名，避免与 server.js 冲突）
#   5) 输出迁移统计（总键数 / device 数 / batch 数 / 新增数 / 覆盖数）
#
# 用法（生产容器内）:
#   docker exec aliyun-cloud-1 sh /root/work/cybercafe/deploy/aliyun/migrate-kv.sh /data
#   或 DATA_DIR=/data deploy/aliyun/migrate-kv.sh
# 默认 DATA_DIR=/data（生产 compose 挂载卷）；无旧库时安全退出（exit 0）。
set -euo pipefail

# 注意：全量花括号化变量引用——macOS bash 3.2 会把中文标点紧邻的 $VAR 解析成含多字节字符的变量名
# （如 $V3_KV，）导致 set -u 误判 unbound（t16 同款缺陷），生产容器为 GNU bash 无碍但须本机可测。
DATA_DIR="${1:-${DATA_DIR:-/data}}"
KV_JSON="${DATA_DIR}/kv.json"
V3_KV="${DATA_DIR}/v3/kv"

say() { printf '\033[1;34m[migrate-kv]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[migrate-kv ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# node:sqlite 兼容探测：node 22.5–23.3 需 --experimental-sqlite，23.4+ 默认启用（传 flag 会报错）
node_sqlite() {
  if node --experimental-sqlite -e 'require("node:sqlite")' >/dev/null 2>&1; then
    node --experimental-sqlite "$@"
  else
    node "$@"
  fi
}

[ -d "${V3_KV}" ] || { say "未发现旧 KV 目录 ${V3_KV}，无迁移需要（exit 0）"; exit 0; }
[ -f "${KV_JSON}" ] || { say "未发现现 kv.json ${KV_JSON}，跳过合并（先启动一次服务生成空库再迁移）"; exit 1; }

say "旧 KV 目录: ${V3_KV}"
say "现 kv.json: ${KV_JSON}"

node_sqlite - "$DATA_DIR" <<'NODE'
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const dataDir = process.argv[2];
const kvJson = path.join(dataDir, "kv.json");
const v3kv = path.join(dataDir, "v3", "kv");

// ---------- 1) 定位旧 sqlite 与 blobs（v3/kv 递归扫描） ----------
const sqlites = [];
const blobsDirs = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "blobs") blobsDirs.push(p);
      else walk(p);
    } else if (
      e.name.endsWith(".sqlite") &&
      !e.name.startsWith("metadata") &&
      !e.name.endsWith("-wal") &&
      !e.name.endsWith("-shm")
    ) {
      sqlites.push(p);
    }
  }
})(v3kv);

if (sqlites.length === 0) {
  console.error("[migrate-kv] 未发现旧 sqlite（v3/kv 下无数据表文件），无迁移需要");
  process.exit(0);
}
console.log(`[migrate-kv] 发现旧 sqlite: ${sqlites.join(", ")}`);
console.log(`[migrate-kv] 发现 blobs 目录: ${blobsDirs.join(", ")} (${blobsDirs.reduce((n, d) => n + fs.readdirSync(d).length, 0)} 文件)`);

const findBlob = (blobId) => {
  for (const d of blobsDirs) {
    const p = path.join(d, blobId);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

// ---------- 2) 读 _mf_entries + blobs 还原全部键值 ----------
const old = {};
const now = Date.now();
for (const sq of sqlites) {
  let db;
  try { db = new DatabaseSync(sq, { readOnly: true }); }
  catch (e) { console.error(`[migrate-kv] 打开 sqlite 失败（跳过 ${sq}）: ${e.message}`); continue; }
  const rows = db.prepare("SELECT key, blob_id, expiration FROM _mf_entries").all();
  db.close();
  for (const row of rows) {
    if (row.expiration && now >= Number(row.expiration) * 1000) continue; // 已过期跳过
    const blobPath = findBlob(row.blob_id);
    if (!blobPath) { console.error(`[migrate-kv] 缺失 blob ${row.blob_id}（跳过键 ${row.key}）`); continue; }
    old[row.key] = fs.readFileSync(blobPath, "utf8");
  }
}
if (Object.keys(old).length === 0) {
  console.error("[migrate-kv] 旧库无有效键值，无迁移需要");
  process.exit(0);
}

// ---------- 3) 合并（旧库优先，保留新库独有键） ----------
let cur = {};
if (fs.existsSync(kvJson)) {
  try { cur = JSON.parse(fs.readFileSync(kvJson, "utf8")); }
  catch { cur = {}; }
}
let added = 0, overwritten = 0;
for (const [k, v] of Object.entries(old)) {
  if (!(k in cur)) added++;
  else if (cur[k] !== v) overwritten++;
  cur[k] = v;
}
const merged = cur;

// ---------- 4) 备份现 kv.json 再原子写回 ----------
const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
const bak = `${kvJson}.bak-${ts}`;
fs.copyFileSync(kvJson, bak);
const tmp = `${kvJson}.migrate-tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
fs.renameSync(tmp, kvJson);

// ---------- 5) 统计 ----------
const keys = Object.keys(merged);
const count = (prefix) => keys.filter((k) => k.startsWith(prefix)).length;
console.log(`[migrate-kv] 迁移完成：总键数=${keys.length}（新增 ${added} / 覆盖 ${overwritten}）`);
console.log(`[migrate-kv] 统计：device 数=${count("device:")}，batch 数=${count("batch:")}，devicekey 数=${count("devicekey:")}，cmd 数=${count("cmd:")}`);
console.log(`[migrate-kv] 备份: ${bak}`);
console.log(`[migrate-kv] 写回: ${kvJson}`);
NODE
echo "MIGRATE_EXIT=$?"