// CyberCafe 云管理端 (Cloudflare Worker)
// - 设备注册/心跳/进度上报（X-Device-Key 鉴权）
// - 管理 API（Bearer ADMIN_TOKEN 鉴权）
// - 安装脚本/控制脚本实时下发（从 GitHub 仓库 agent/ 拉取并注入参数）
// - 静态管理 UI（assets）

// 脚本/文件分发通道（2026-09-29 加固）：
// - 主通道 raw.githubusercontent.com：Fastly 边缘 TTL 5min；实测 query 不参与缓存键，
//   ?t= bust 对 raw 与 jsDelivr 均无效（已移除）
// - 韧性回退 jsDelivr @main：实测 query 被忽略、按路径缓存 s-maxage=12h——仅作兜底；
//   aliyun 出口访问 raw 超时时自动回退，即使漏注入 GITHUB_RAW_BASE 也不会复现生产超时故障
// - aliyun 生产首选通道 AGENT_LOCAL_BASE：compose 把仓库 agent/ 只读挂载进静态资源目录
//   public/_agent，dev server 每请求实时读盘，git pull 后即时生效、零外部依赖。
//   （实测：本运行时 workerd 沙箱拒绝 node:fs 磁盘读、env.ASSETS 未注入，
//     worker 经 loopback HTTP 取自身静态资源是唯一可靠本地通道）
const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com/zcr268/cybercafe/main/agent";
const DEFAULT_JSDELIVR_BASE = "https://cdn.jsdelivr.net/gh/zcr268/cybercafe@main/agent";
const FETCH_TIMEOUT_MS = 5000;
const VERSION_CACHE_TTL_MS = 60000;
// 网络通道自适应：isolate 内记住上次成功通道，避免 aliyun 每次先吃 raw 超时
let lastNetworkOk = null; // "raw" | "jsdelivr"

// 引擎 × 模型 目录：UI 引擎下拉 + 模型级联下拉的源数据；部署指令携带 engine 字段
// - ollama 走 Ollama 仓库 tag；vllm/sglang 走 HuggingFace 模型 id（HF_ENDPOINT=hf-mirror 拉权重）
// - vLLM 镜像 v0.4.1 / SGLang v0.4.1.post4-cu121 为 CUDA 12.1 基底，兼容该机驱动 535.274.02（CUDA 12.2）
// - strata = Strata 专用运行时（Niko1221/Strata，仅 Qwen3.8-Flash-Next Coder 档 IQ1_M，
//   驱动≥580 / 内存≥31GB / 磁盘≥80GB，low-RAM resident，单并发），OpenAI 兼容 API 亦走 127.0.0.1:11434
const ENGINES = {
  ollama: ["qwen2.5:7b-instruct", "qwen2.5:14b-instruct-q4_k_m", "llama3.1:8b"],
  vllm: ["Qwen/Qwen2-7B-Instruct-AWQ", "Qwen/Qwen2-1.5B-Instruct-AWQ"],
  sglang: ["Qwen/Qwen2.5-7B-Instruct-AWQ", "Qwen/Qwen2.5-14B-Instruct-AWQ"],
  strata: ["Qwen3.8-Flash-Next-Coder"],
};
const MODELS = Object.values(ENGINES).flat();

// ---------- 工具 ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randKey(prefix) {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return prefix + [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randCode(prefix) {
  // 批次码：短随机（6字节=12 hex）便于镜像预置/命令行使用
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return prefix + [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

function rawBase(env) {
  return (env.GITHUB_RAW_BASE || DEFAULT_RAW_BASE).replace(/\/$/, "");
}

function jsdelivrBase(env) {
  return (env.JSDELIVR_RAW_BASE || DEFAULT_JSDELIVR_BASE).replace(/\/$/, "");
}

async function readLocalRepoFile(env, name) {
  // 本地首选通道：AGENT_LOCAL_BASE 指向开发服务器自身静态资源（public/_agent 挂载了仓库 agent/）。
  // 经 loopback HTTP 读取（实测 workerd 沙箱拒绝 node:fs 磁盘读、env.ASSETS 未注入）。
  const resp = await fetch(`${env.AGENT_LOCAL_BASE.replace(/\/$/, "")}/${name}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

async function fetchRepoFile(env, name) {
  // 通道 0：AGENT_LOCAL_BASE（aliyun 生产首选，compose 挂载仓库 agent/ → public/_agent）
  if (env.AGENT_LOCAL_BASE) {
    try { return await readLocalRepoFile(env, name); }
    catch (e) { /* 本地通道失败 → 网络通道兜底 */ }
  }
  // 通道 1/2：raw 主 + jsDelivr 回退（自适应顺序，各 5s 超时）
  const raw = `${rawBase(env)}/${name}`;
  const jsd = `${jsdelivrBase(env)}/${name}`;
  const firstUrl = lastNetworkOk === "jsdelivr" ? jsd : raw;
  const secondUrl = firstUrl === jsd ? raw : jsd;
  const label = firstUrl === jsd ? "jsdelivr" : "raw";
  try {
    const resp = await fetch(firstUrl, { cf: { cacheTtl: 30 }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    lastNetworkOk = label;
    return await resp.text();
  } catch (e1) {
    try {
      const resp = await fetch(secondUrl, { cf: { cacheTtl: 30 }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      lastNetworkOk = secondUrl === jsd ? "jsdelivr" : "raw";
      return await resp.text();
    } catch (e2) {
      throw new Error(`fetch ${name} failed (${label}: ${e1.message}; fallback: ${e2.message})`);
    }
  }
}

// 经 cloudflared 等反代时 url.protocol 是 http，用 X-Forwarded-Proto 还原真实协议
function publicOrigin(request, url) {
  const proto = request.headers.get("X-Forwarded-Proto") || url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

let versionCache = null; // { v, at }

async function agentVersion(env) {
  // 60s 内存缓存：心跳不必每次外拉脚本源，降低外部依赖面；新版本最迟 60s 内生效
  const now = Date.now();
  if (versionCache && now - versionCache.at < VERSION_CACHE_TTL_MS) return versionCache.v;
  const src = await fetchRepoFile(env, "cybercafe-agent.py");
  const m = src.match(/^VERSION\s*=\s*"([^"]+)"/m);
  const v = m ? m[1] : "0.0.0";
  versionCache = { v, at: now };
  return v;
}

function injectParams(src, apiBase, deviceKey) {
  return src.replaceAll("__API_BASE__", apiBase).replaceAll("__DEVICE_KEY__", deviceKey);
}

// ---------- 鉴权 ----------

async function deviceFromKey(request, env) {
  const key = request.headers.get("X-Device-Key") || "";
  if (!key) return null;
  const h = await sha256hex(key);
  const rec = await env.CYBERCAFE_KV.get(`devicekey:${h}`);
  if (!rec) return null;
  return { id: h.slice(0, 12), key, keyHash: h };
}

function adminOk(request, env) {
  if (!env.ADMIN_TOKEN) return { ok: false, resp: json({ error: "ADMIN_TOKEN 未配置" }, 500) };
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return { ok: false, resp: json({ error: "unauthorized" }, 401) };
  return { ok: true };
}

// ---------- 设备侧 API ----------

async function handleRegister(request, env, dev) {
  const body = await request.json().catch(() => ({}));
  const info = (body && body.device) || {};
  const now = Math.floor(Date.now() / 1000);
  const key = `device:${dev.id}`;
  const old = (await env.CYBERCAFE_KV.get(key, "json")) || {};
  const rec = {
    ...old,
    ...info,
    device_id: dev.id,
    key_hash: dev.keyHash,
    first_seen: old.first_seen || now,
    last_seen: now,
    deploy: old.deploy || { state: "idle" },
  };
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));
  return json({ ok: true, device_id: dev.id });
}

async function handleHeartbeat(request, env, dev) {
  const body = await request.json().catch(() => ({}));
  const upd = (body && body.device) || {};
  const now = Math.floor(Date.now() / 1000);
  const key = `device:${dev.id}`;
  const old = (await env.CYBERCAFE_KV.get(key, "json")) || {};
  const rec = { ...old, ...upd, device_id: dev.id, last_seen: now };
  delete rec.command;
  // deploy 深度合并：agent 部分上报（如 restart_tunnel 仅带 state/tunnel_url）时保留已有
  // engine/model/model_api_key，避免重建隧道后聊天失去鉴权 Key；
  // stop 语义为整体清空运行态 → 直接替换（丢弃过期 tunnel_url/engine 等）
  if (upd.deploy && typeof upd.deploy === "object") {
    rec.deploy = upd.deploy.state === "stopped"
      ? { ...upd.deploy, ts: upd.deploy.ts || now }
      : { ...(old.deploy || {}), ...upd.deploy, ts: upd.deploy.ts || now };
  }
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));

  // 取出待执行指令（一次性）
  const cmdKey = `cmd:${dev.id}`;
  const cmd = await env.CYBERCAFE_KV.get(cmdKey, "json");
  if (cmd) await env.CYBERCAFE_KV.delete(cmdKey);

  let ver = "0.0.0";
  try { ver = await agentVersion(env); } catch (e) { /* 仓库不可达时跳过自更新 */ }

  // 变速心跳：有待执行指令或部署进行中 → 3s 快轮询；否则 10s
  const st = (rec.deploy && rec.deploy.state) || "idle";
  const pollAfter = (cmd || st === "queued" || st === "deploying") ? 3 : 10;
  return json({ ok: true, server_time: now, agent_version: ver, command: cmd || null, poll_after: pollAfter });
}

async function handleProgress(request, env, dev) {
  const body = await request.json().catch(() => ({}));
  const now = Math.floor(Date.now() / 1000);
  const key = `device:${dev.id}`;
  const rec = (await env.CYBERCAFE_KV.get(key, "json")) || { device_id: dev.id };
  rec.last_seen = now;
  const prevState = (rec.deploy && rec.deploy.state) || "idle";
  let state = body.state === "fail" ? "failed"
    : (body.step === "verify" && body.state === "ok" ? "online" : "deploying");
  // 迟到的旧进度不推翻已 online 的结论（新一轮部署会先经 admin/deploy 重置为 queued）
  if (prevState === "online" && state === "deploying") state = "online";
  rec.deploy = {
    ...(rec.deploy || {}),
    state,
    step: body.step,
    step_state: body.state,
    detail: body.detail || "",
    ts: body.ts || now,
  };
  // 隧道/验证步骤回报 ok 时把公网地址固化进 deploy 记录（最终结果心跳偶发丢失也不影响 UI 聊天）
  if (body.state === "ok" && (body.step === "tunnel" || body.step === "verify")) {
    const m = (body.detail || "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) rec.deploy.tunnel_url = m[0];
  }
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));

  // 追加进度日志（保留最近100条）
  const logKey = `log:${dev.id}`;
  const logs = (await env.CYBERCAFE_KV.get(logKey, "json")) || [];
  logs.push({ ts: body.ts || now, step: body.step, state: body.state, detail: body.detail || "" });
  await env.CYBERCAFE_KV.put(logKey, JSON.stringify(logs.slice(-100)));
  return json({ ok: true });
}

// ---------- 批次码（基础镜像批量装机）----------
// /api/device/provision 无 X-Device-Key 鉴权：批次码本身即装机凭证（镜像预置，首启自动注册）。
// KV key 约定：
//   batch:<code>            = {code, label, quota, used, created, expires}
//   prov:machine:<machine>  = {key, batch, created_at}   machine_id → 设备 key（重复装机复用）
//   devicekey:<hash>        = 沿用现有，新增 batch/machine_id 字段

async function handleDeviceProvision(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const code = String(body.batch_code || "").trim();
  const machineId = String(body.machine_id || "").trim();
  if (!code) return json({ error: "batch_code required" }, 400);
  if (!machineId) return json({ error: "machine_id required" }, 400);
  const now = Math.floor(Date.now() / 1000);

  const batchKey = `batch:${code}`;
  const batch = await env.CYBERCAFE_KV.get(batchKey, "json");
  if (!batch) return json({ error: `batch ${code} not found` }, 403);

  // 同一 machine_id 已在本批次注册过 → 复用原设备 key，不消耗配额、不受过期/配额限制；
  // 仅限同批次复用，避免跨批次领取他人设备 key（machine_id 非机密）。
  const mapKey = `prov:machine:${machineId}`;
  const mapped = await env.CYBERCAFE_KV.get(mapKey, "json");
  // provision 入参的硬件信息（hostname/os），用于预置设备记录；复用路径不强制要求
  const info = (body.device && typeof body.device === "object") ? body.device : {};
  let key;
  let reused = !!(mapped && mapped.batch === code);
  let keyHash = null;
  if (reused) {
    key = mapped.key;
    keyHash = await sha256hex(key);
  } else {
    if (batch.expires && now > batch.expires) return json({ error: `batch ${code} expired` }, 403);
    // 配额满检查仅对显式限量的批次生效（quota:null = 无限）
    if (batch.quota != null && (batch.used || 0) >= batch.quota) return json({ error: `batch ${code} quota full` }, 403);
    key = randKey("cck-");
    keyHash = await sha256hex(key);
    await env.CYBERCAFE_KV.put(`devicekey:${keyHash}`,
      JSON.stringify({ label: String(info.hostname || "").slice(0, 120), batch: code,
                       machine_id: machineId, created_at: now }));
    await env.CYBERCAFE_KV.put(mapKey, JSON.stringify({ key, batch: code, created_at: now }));
    // 配额计数（KV 无原子自增；provision 为一次性首启行为，读改写可接受）
    batch.used = (batch.used || 0) + 1;
    await env.CYBERCAFE_KV.put(batchKey, JSON.stringify(batch));
  }

  // 设备记录预置 batch 来源字段（agent 首次注册/心跳 merge 时保留）
  const id = (await sha256hex(key)).slice(0, 12);
  const devKey = `device:${id}`;
  const old = (await env.CYBERCAFE_KV.get(devKey, "json")) || {};
  await env.CYBERCAFE_KV.put(devKey, JSON.stringify({
    ...old,
    device_id: id,
    key_hash: keyHash,
    machine_id: machineId,
    batch: code,
    hostname: String(info.hostname || old.hostname || "").slice(0, 120),
    os: String(info.os || old.os || "").slice(0, 120),
    first_seen: old.first_seen || now,
    provisioned_at: now,
  }));

  return json({ ok: true, device_key: key, device_id: id, batch: code, reused,
                api_base: publicOrigin(request, url) });
}

// ---------- 管理侧 API ----------

async function kvListAll(kv, prefix) {
  // KV list 单页最多 1000 键，遍历 cursor 取全量，避免设备/批次超千台被截断
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

async function handleAdminDevices(env) {
  const keys = await kvListAll(env.CYBERCAFE_KV, "device:");
  const now = Math.floor(Date.now() / 1000);
  const recs = await Promise.all(keys.map(k => env.CYBERCAFE_KV.get(k.name, "json")));
  const devices = [];
  for (const rec of recs) {
    if (!rec) continue;
    rec.online = now - (rec.last_seen || 0) < 35;
    devices.push(rec);
  }
  devices.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  return json({ ok: true, devices, models: MODELS, engines: ENGINES });
}

async function handleAdminCreateBatch(request, env) {
  const body = await request.json().catch(() => ({}));
  // quota 可选：不填（undefined/null/空串）= 无限（KV quota:null，provision 跳过配额检查）；
  // 显式填数量才限。兼容已建批次（quota 明确值）语义不变。
  let quota = null;
  if (body.quota !== undefined && body.quota !== null && body.quota !== "") {
    quota = parseInt(body.quota, 10);
    if (!Number.isInteger(quota) || quota < 1) return json({ error: "quota 需为 >=1 的整数（不填=无限）" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  let expires = body.expires;
  if (typeof expires === "string" && expires) {
    const t = Date.parse(expires);
    if (isNaN(t)) return json({ error: "expires 需为 ISO 时间或秒级时间戳" }, 400);
    expires = Math.floor(t / 1000);
  }
  if (expires === undefined || expires === null || expires === "") {
    expires = null;
  } else if (typeof expires !== "number" || !isFinite(expires) || expires <= now) {
    return json({ error: "expires 需为未来的秒级时间戳或 ISO 时间" }, 400);
  }
  const code = randCode("ccb-");
  const rec = {
    code,
    label: String(body.label || "").slice(0, 200),
    quota,
    used: 0,
    created: now,
    expires,
  };
  await env.CYBERCAFE_KV.put(`batch:${code}`, JSON.stringify(rec));
  return json({ ok: true, ...rec });
}

async function handleAdminListBatches(env) {
  const keys = await kvListAll(env.CYBERCAFE_KV, "batch:");
  const now = Math.floor(Date.now() / 1000);
  const recs = await Promise.all(keys.map(k => env.CYBERCAFE_KV.get(k.name, "json")));
  const batches = [];
  for (const rec of recs) {
    if (!rec) continue;
    rec.remaining = rec.quota == null ? null : Math.max(0, rec.quota - (rec.used || 0));
    rec.expired = !!(rec.expires && now > rec.expires);
    batches.push(rec);
  }
  batches.sort((a, b) => (b.created || 0) - (a.created || 0));
  return json({ ok: true, batches });
}

async function handleAdminDeleteBatch(env, code) {
  // 删除 batch:<code>；顺带清理该批次 prov:machine 映射（避免孤儿映射长期残留）。
  // 已注册设备记录（device:<id>）保留——agent 心跳/部署不受影响，仅该码无法再 provision 新机。
  const rec = await env.CYBERCAFE_KV.get(`batch:${code}`, "json");
  await env.CYBERCAFE_KV.delete(`batch:${code}`);
  const keys = await kvListAll(env.CYBERCAFE_KV, "prov:machine:");
  for (const k of keys) {
    const m = await env.CYBERCAFE_KV.get(k.name, "json");
    if (m && m.batch === code) await env.CYBERCAFE_KV.delete(k.name);
  }
  return json({ ok: true, removed: !!rec });
}

async function handleAdminNewDevice(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const key = randKey("cck-");
  await env.CYBERCAFE_KV.put(`devicekey:${await sha256hex(key)}`,
    JSON.stringify({ label: body.label || "", created_at: Math.floor(Date.now() / 1000) }));
  return json({
    ok: true,
    device_key: key,
    install_command: `curl -fsSL "${origin}/install.sh?key=${key}" | bash`,
  });
}

async function handleAdminDeploy(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.device_id) return json({ error: "device_id required" }, 400);
  const engine = Object.prototype.hasOwnProperty.call(ENGINES, body.engine) ? body.engine : "ollama";
  const models = ENGINES[engine] || [];
  const model = models.includes(body.model) ? body.model : models[0];
  if (!model) return json({ error: `engine ${engine} has no models` }, 400);
  const cmd = {
    type: "deploy",
    engine,
    model,
    api_key: randKey("sk-"),
    created_at: Math.floor(Date.now() / 1000),
  };
  await env.CYBERCAFE_KV.put(`cmd:${body.device_id}`, JSON.stringify(cmd));
  // 清理旧日志，标记排队中
  await env.CYBERCAFE_KV.delete(`log:${body.device_id}`);
  const key = `device:${body.device_id}`;
  const rec = await env.CYBERCAFE_KV.get(key, "json");
  if (!rec) return json({ error: "device not found" }, 404);
  // model_api_key 随排队指令落盘：即使最终结果心跳因真机网络偶发失败丢失，
  // UI 聊天也能拿到本次部署的鉴权 Key（t4 真机验证发现：部署完成瞬间心跳 TLS 超时导致记录缺 Key）
  rec.deploy = { state: "queued", engine, model, model_api_key: cmd.api_key, ts: Math.floor(Date.now() / 1000) };
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));
  return json({ ok: true, command: { ...cmd, api_key: undefined } });
}

async function handleAdminCommand(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.device_id || !["stop", "restart_tunnel"].includes(body.type))
    return json({ error: "device_id + type(stop|restart_tunnel) required" }, 400);
  const exists = await env.CYBERCAFE_KV.get(`device:${body.device_id}`, "json");
  if (!exists) return json({ error: "device not found" }, 404);
  await env.CYBERCAFE_KV.put(`cmd:${body.device_id}`,
    JSON.stringify({ type: body.type, created_at: Math.floor(Date.now() / 1000) }));
  return json({ ok: true });
}

async function handleAdminDeviceDetail(env, id) {
  const rec = await env.CYBERCAFE_KV.get(`device:${id}`, "json");
  if (!rec) return json({ error: "not found" }, 404);
  const logs = (await env.CYBERCAFE_KV.get(`log:${id}`, "json")) || [];
  const now = Math.floor(Date.now() / 1000);
  rec.online = now - (rec.last_seen || 0) < 35;
  return json({ ok: true, device: rec, logs });
}

async function handleAdminDeleteDevice(env, id) {
  const rec = await env.CYBERCAFE_KV.get(`device:${id}`, "json");
  await env.CYBERCAFE_KV.delete(`device:${id}`);
  await env.CYBERCAFE_KV.delete(`cmd:${id}`);
  await env.CYBERCAFE_KV.delete(`log:${id}`);
  if (rec) {
    // 连带吊销设备密钥（防止删除后旧 key 重新注册复活设备）与批次 machine 映射
    if (rec.key_hash) await env.CYBERCAFE_KV.delete(`devicekey:${rec.key_hash}`);
    if (rec.machine_id) await env.CYBERCAFE_KV.delete(`prov:machine:${rec.machine_id}`);
  }
  return json({ ok: true, removed: !!rec });
}

// ---------- 脚本下发 ----------

async function handleInstallSh(request, env, url) {
  const key = url.searchParams.get("key") || "";
  if (!key) return new Response("missing ?key=\n", { status: 400 });
  const rec = await env.CYBERCAFE_KV.get(`devicekey:${await sha256hex(key)}`);
  if (!rec) return new Response("invalid device key\n", { status: 403 });
  try {
    const src = await fetchRepoFile(env, "install.sh");
    const body = injectParams(src, publicOrigin(request, url), key);
    return new Response(body, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8" } });
  } catch (e) {
    return new Response(`fetch install.sh failed: ${e.message}\n`, { status: 502 });
  }
}

async function handleAgentLatest(request, env, dev, url) {
  try {
    const src = await fetchRepoFile(env, "cybercafe-agent.py");
    const body = injectParams(src, publicOrigin(request, url), dev.key);
    return new Response(body, { headers: { "Content-Type": "text/x-python; charset=utf-8" } });
  } catch (e) {
    return new Response(`fetch agent failed: ${e.message}\n`, { status: 502 });
  }
}

async function handleAgentVersion(env) {
  try {
    return json({ ok: true, version: await agentVersion(env) });
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

// ---------- 路由 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 安装脚本（key 在 query 中）
      if (path === "/install.sh" && request.method === "GET")
        return await handleInstallSh(request, env, url);

      // 设备侧
      // provision：无 X-Device-Key 鉴权——批次码即装机凭证（基础镜像首启自动注册）
      if (path === "/api/device/provision" && request.method === "POST")
        return await handleDeviceProvision(request, env, url);
      if (path === "/api/agent/latest" && request.method === "GET") {
        const dev = await deviceFromKey(request, env);
        if (!dev) return json({ error: "invalid device key" }, 401);
        return await handleAgentLatest(request, env, dev, url);
      }
      if (path === "/api/device/register" && request.method === "POST") {
        const dev = await deviceFromKey(request, env);
        if (!dev) return json({ error: "invalid device key" }, 401);
        return await handleRegister(request, env, dev);
      }
      if (path === "/api/device/heartbeat" && request.method === "POST") {
        const dev = await deviceFromKey(request, env);
        if (!dev) return json({ error: "invalid device key" }, 401);
        return await handleHeartbeat(request, env, dev);
      }
      if (path === "/api/device/progress" && request.method === "POST") {
        const dev = await deviceFromKey(request, env);
        if (!dev) return json({ error: "invalid device key" }, 401);
        return await handleProgress(request, env, dev);
      }
      if (path === "/api/agent/version" && request.method === "GET")
        return await handleAgentVersion(env);

      // 管理侧
      if (path.startsWith("/api/admin/")) {
        const a = adminOk(request, env);
        if (!a.ok) return a.resp;
        if (path === "/api/admin/devices" && request.method === "GET")
          return await handleAdminDevices(env);
        if (path === "/api/admin/devices/new" && request.method === "POST")
          return await handleAdminNewDevice(request, env, publicOrigin(request, url));
        if (path === "/api/admin/deploy" && request.method === "POST")
          return await handleAdminDeploy(request, env);
        if (path === "/api/admin/command" && request.method === "POST")
          return await handleAdminCommand(request, env);
        if (path === "/api/admin/batches" && request.method === "POST")
          return await handleAdminCreateBatch(request, env);
        if (path === "/api/admin/batches" && request.method === "GET")
          return await handleAdminListBatches(env);
        const bm = path.match(/^\/api\/admin\/batches\/([^/]+)$/);
        if (bm && request.method === "DELETE")
          return await handleAdminDeleteBatch(env, decodeURIComponent(bm[1]));
        const m = path.match(/^\/api\/admin\/device\/([0-9a-f]{12})$/);
        if (m && request.method === "GET") return await handleAdminDeviceDetail(env, m[1]);
        if (m && request.method === "DELETE") return await handleAdminDeleteDevice(env, m[1]);
        return json({ error: "not found" }, 404);
      }

      // 其余走静态资源（管理 UI）
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return new Response("cybercafe cloud (no assets bound)", { status: 200 });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
