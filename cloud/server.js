// CyberCafe 云管理端 · 真实独立 HTTP 服务入口（W0 服务化）
//
// 运行形态（本地沙箱与生产容器通用，不再依赖 wrangler dev / CF 平台绑定）：
//   node server.js
// 环境变量（与现 .dev.vars / 容器注入同名契约，见 tests/w0-service/README）：
//   PORT                        监听端口（本地沙箱 8788 / 生产容器 8080，默认 8788）
//   ADMIN_TOKEN                 管理 API Bearer 鉴权
//   DATA_DIR                    KV 持久化目录（契约：DATA_DIR/kv.json；默认系统临时目录）
//   GITHUB_RAW_BASE / JSDELIVR_RAW_BASE   脚本分发网络通道基座（默认 raw.githubusercontent / jsDelivr）
//   AGENT_LOCAL_BASE / AGENT_LOCAL_ROOT_BASE  本地挂载通道（生产 compose 只读挂载等价物）
//
// 职责：
//   1) 本地文件 KV（DATA_DIR/kv.json，JSON 对象 key→value，value 为 JSON 字符串，
//      每次写后落盘、重启同 DATA_DIR 数据不丢）注入 env.CYBERCAFE_KV；
//   2) public/ 静态 UI 文件服务注入 env.STATIC_HANDLER（等价替换原 env.ASSETS 绑定）；
//   3) Node http 服务把真实 HTTP 请求转换为 Worker fetch 形态，交给 src/index.js 处理。
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import worker from "./src/index.js";

const CLOUD_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(CLOUD_ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), "cybercafe-kv"));
const PORT = Number(process.env.PORT || 8788);

// ---------- 本地文件 KV（契约：DATA_DIR/kv.json） ----------
// 内存 Map 承接读写（与 Cloudflare KV 同接口：get(key[, "json"]) / put / delete / list({prefix})）；
// 每次变更经串行写链落盘为 DATA_DIR/kv.json（key→JSON 字符串），保证 API 响应返回前文件已落盘。
function createLocalKV(dataDir) {
  const file = path.join(dataDir, "kv.json");
  const map = new Map();
  try {
    const obj = JSON.parse(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(obj)) map.set(k, v);
  } catch { /* 无文件/损坏 → 空库启动 */ }
  let chain = Promise.resolve();
  const persist = () => {
    chain = chain.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const obj = {};
      for (const k of [...map.keys()].sort()) obj[k] = map.get(k);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(obj));
      await rename(tmp, file);
    }).catch((e) => console.error("[kv] persist failed:", e && e.message || e));
    return chain;
  };
  return {
    async get(key, type) {
      const v = map.get(key);
      if (v === undefined) return null;
      if (type === "json") { try { return JSON.parse(v); } catch { return v; } }
      return v;
    },
    async put(key, value) { map.set(key, String(value)); await persist(); },
    async delete(key) { if (map.delete(key)) await persist(); },
    async list({ prefix = "", cursor } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, cursor: null };
    },
  };
}

// ---------- 静态 UI 文件服务（public/，路径穿越防护） ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
};

async function staticHandler(request, url) {
  let rel = url.pathname;
  if (rel === "/") rel = "/index.html";
  let dec;
  try { dec = decodeURIComponent(rel); } catch { return new Response("bad request", { status: 400 }); }
  const abs = path.normalize(path.join(PUBLIC_DIR, dec));
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const data = await readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    return new Response(data, { headers: { "Content-Type": MIME[ext] || "application/octet-stream" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

// ---------- HTTP 桥接（Node http ↔ Worker fetch 形态） ----------
// 跳过头传递头，避免 undici Request 构造对 content-length/transfer-encoding 与 body 的校验冲突
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-connection", "te", "trailer", "content-length"]);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

const env = {
  ...process.env,
  CYBERCAFE_KV: createLocalKV(DATA_DIR),
  STATIC_HANDLER: staticHandler,
};

async function onRequest(req, res) {
  try {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const url = new URL(req.url, `http://${host}`);
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (HOP_BY_HOP.has(req.rawHeaders[i].toLowerCase())) continue;
      headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    const withBody = req.method !== "GET" && req.method !== "HEAD";
    const body = withBody ? await readBody(req) : undefined;
    const request = new Request(url.href, {
      method: req.method,
      headers,
      ...(body !== undefined && body.length ? { body } : {}),
    });
    const resp = await worker.fetch(request, env);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.writeHead(resp.status, Object.fromEntries(resp.headers.entries()));
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}

const server = http.createServer(onRequest);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`cybercafe cloud service listening on http://0.0.0.0:${PORT} (kv: ${DATA_DIR}/kv.json)`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
