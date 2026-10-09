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

// t37：与 fetchRepoFile 同通道逻辑的并行版本，返回 { text, source }（source: local/raw/jsdelivr）。
// 不改动现有 fetchRepoFile 的返回契约（现有调用方继续只拿文本）。
async function fetchRepoFileWithChannel(env, name) {
  if (env.AGENT_LOCAL_BASE) {
    try { return { text: await readLocalRepoFile(env, name), source: "local" }; }
    catch (e) { /* 本地通道失败 → 网络通道兜底 */ }
  }
  const raw = `${rawBase(env)}/${name}`;
  const jsd = `${jsdelivrBase(env)}/${name}`;
  const firstUrl = lastNetworkOk === "jsdelivr" ? jsd : raw;
  const secondUrl = firstUrl === jsd ? raw : jsd;
  const label = firstUrl === jsd ? "jsdelivr" : "raw";
  try {
    const resp = await fetch(firstUrl, { cf: { cacheTtl: 30 }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    lastNetworkOk = label;
    return { text: await resp.text(), source: label };
  } catch (e1) {
    const resp = await fetch(secondUrl, { cf: { cacheTtl: 30 }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    lastNetworkOk = secondUrl === jsd ? "jsdelivr" : "raw";
    return { text: await resp.text(), source: secondUrl === jsd ? "jsdelivr" : "raw" };
  }
}

// t41：仓库根目录文件通道（uninstall-all.sh 等位于 agent/ 之外）。
// 网络基座 = agent 通道基座去掉尾部 /agent（仓库根）；本地基座 AGENT_LOCAL_ROOT_BASE
// （compose 把仓库根只读挂载到 public/_repo）；与 fetchRepoFile 同构的自适应回退。
async function fetchRepoFileRoot(env, name) {
  if (env.AGENT_LOCAL_ROOT_BASE) {
    try {
      const resp = await fetch(`${env.AGENT_LOCAL_ROOT_BASE.replace(/\/$/, "")}/${name}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      // 本地静态通道对缺失文件可能回吐 worker 兜底文本（200）：按内容特征识别并降级网络通道
      if (text === "cybercafe cloud (no assets bound)" || text.length < 64) throw new Error("local asset placeholder");
      return text;
    } catch (e) { /* 本地失败 → 网络兜底 */ }
  }
  const rootRaw = rawBase(env).replace(/\/agent\/?$/, "").replace(/\/$/, "");
  const rootJsd = jsdelivrBase(env).replace(/\/agent\/?$/, "").replace(/\/$/, "");
  const raw = `${rootRaw}/${name}`;
  const jsd = `${rootJsd}/${name}`;
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
      throw new Error(`fetch root ${name} failed (${label}: ${e1.message}; fallback: ${e2.message})`);
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

// 请求来源外网 IP：生产走 cloudflared → workerd，CF-Connecting-IP 由 Cloudflare 注入；
// X-Forwarded-For 作兜底（取最左的真实来源，右段为代理链）。
function requestSrcIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf && cf.trim()) return cf.trim();
  const xff = (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim();
  return xff || "";
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
  // 请求来源外网 IP（云侧视角）；为空时不覆盖已有值（避免本地/异常请求抹掉真实外网 IP）
  const srcIp = requestSrcIp(request);
  if (srcIp) {
    rec.remote_ip = srcIp;
    rec.remote_ip_ts = now;
  }
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
  // 请求来源外网 IP（云侧视角）；为空时不覆盖已有值
  const srcIp = requestSrcIp(request);
  if (srcIp) {
    rec.remote_ip = srcIp;
    rec.remote_ip_ts = now;
  }
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
//   prov:machine:<machine>  = {key, batch, created_at, hw_id?}   machine_id → 设备 key（兼容旧路径）
//   prov:hw:<hardware_id>   = {key, batch, created_at, machine_id}  硬件指纹 → 设备 key（t33 主去重键）
//   devicekey:<hash>        = 沿用现有，新增 batch/machine_id/hw_id 字段

async function handleDeviceProvision(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const code = String(body.batch_code || "").trim();
  const machineId = String(body.machine_id || "").trim();
  const hardwareId = String(body.hardware_id || "").trim();
  const hwSourceRaw = String(body.hw_source || "").trim();
  // t39：指纹来源 gpu|mac|machine-id；空/未知值按空处理（旧脚本/旧机器不携带）
  const hwSource = ["gpu", "mac", "machine-id"].includes(hwSourceRaw) ? hwSourceRaw : "";
  if (!code) return json({ error: "batch_code required" }, 400);
  if (!machineId) return json({ error: "machine_id required" }, 400);
  const now = Math.floor(Date.now() / 1000);

  const batchKey = `batch:${code}`;
  const batch = await env.CYBERCAFE_KV.get(batchKey, "json");
  if (!batch) return json({ error: `batch ${code} not found` }, 403);

  // 去重键优先级：prov:hw:<hardware_id>（t33，克隆自愈按新指纹发新 key、同指纹复用不消耗配额）
  // > prov:machine:<machine_id>（仅当 hardware_id 缺失时使用，兼容旧脚本/旧机器，不破坏既有记录）
  const useHw = !!hardwareId;
  const mapKey = useHw ? `prov:hw:${hardwareId}` : `prov:machine:${machineId}`;
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
    const mappedRec = { key, batch: code, created_at: now, machine_id: machineId };
    if (hardwareId) mappedRec.hw_id = hardwareId;
    if (hwSource) mappedRec.hw_source = hwSource;
    await env.CYBERCAFE_KV.put(`devicekey:${keyHash}`,
      JSON.stringify({ label: String(info.hostname || "").slice(0, 120), batch: code,
                       machine_id: machineId,
                       ...(hardwareId ? { hw_id: hardwareId } : {}),
                       ...(hwSource ? { hw_source: hwSource } : {}),
                       created_at: now }));
    await env.CYBERCAFE_KV.put(mapKey, JSON.stringify(mappedRec));
    // 兼容：同时维护 machine 映射（旧路径去重继续可用；克隆换机后更新为最新 key）
    if (hardwareId) {
      await env.CYBERCAFE_KV.put(`prov:machine:${machineId}`,
        JSON.stringify({ key, batch: code, created_at: now, machine_id: machineId, hw_id: hardwareId,
                         ...(hwSource ? { hw_source: hwSource } : {}) }));
    }
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
    hw_id: hardwareId || (mapped && mapped.hw_id) || old.hw_id || "",
    hw_source: hwSource || (mapped && mapped.hw_source) || old.hw_source || "",
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

// ---------- 离线设备惰性清理（t35） + 退役阈值可配置（t37） ----------
// 生产是 wrangler dev 跑在容器里、无 Cron Triggers → 惰性触发：
// 管理端请求设备列表时距上次清理 ≥1h 执行一次，时间戳写 KV（meta:last_cleanup）。
const PURGE_AFTER_S = 30 * 86400;    // 清除：离线 ≥30 天（删 device:/cmd:/log:，保留复活钥匙）——阈值固定，用户不改
const RETIRE_OPTIONS_S = [1800, 3600, 21600, 86400, 259200, 604800]; // 退役可选项：0.5h/1h/6h/1d/3d/7d
const DEFAULT_RETIRE_AFTER_S = 604800;   // 默认退役：7 天
const SETTINGS_KEY = "settings:retire_after_s";
const CLEANUP_INTERVAL_S = 3600;     // 惰性触发间隔
const CLEANUP_CAP = 200;             // 单次调用处理上限（防大列表单请求撑爆）
const META_CLEANUP_KEY = "meta:last_cleanup";

// 退役阈值读取：KV 持久化；未设置/非法值回落默认 7 天（实时生效——退役是每次刷新按当前阈值的派生值）
async function getRetireAfterS(env) {
  const v = await env.CYBERCAFE_KV.get(SETTINGS_KEY);
  if (v === null || v === undefined) return DEFAULT_RETIRE_AFTER_S;
  const n = Number(v);
  return RETIRE_OPTIONS_S.includes(n) ? n : DEFAULT_RETIRE_AFTER_S;
}

async function handleAdminGetSettings(env) {
  return json({ ok: true, retire_after_s: await getRetireAfterS(env), purge_after_s: PURGE_AFTER_S, options: RETIRE_OPTIONS_S });
}

async function handleAdminSetSettings(request, env) {
  const body = await request.json().catch(() => ({}));
  const v = body.retire_after_s;
  // 服务端白名单校验：只接受 6 个选项值，其余一律 400 且不落库
  if (typeof v !== "number" || !RETIRE_OPTIONS_S.includes(v)) {
    return json({ error: `retire_after_s 必须是 ${RETIRE_OPTIONS_S.join("/")} 之一` }, 400);
  }
  await env.CYBERCAFE_KV.put(SETTINGS_KEY, String(v));
  return json({ ok: true, retire_after_s: v });
}

// ---------- 脚本版本/指纹（t37） ----------
// 4 个下发脚本：agent 用 VERSION= 常量，其余三个用注释式 `# Version: X.Y.Z`（B 部分新增）
const SCRIPT_FILES = ["cybercafe-agent.py", "install.sh", "provision.sh", "cybercafe-provision.service"];
const SCRIPT_VERSION_RE = /^#\s*Version:\s*([0-9.]+)/m;

async function scriptInfo(env, name) {
  const { text, source } = await fetchRepoFileWithChannel(env, name);
  const sha = (await sha256hex(text)).slice(0, 8);      // 实际下发字节的 sha256 前 8 位
  const bytes = new TextEncoder().encode(text).length;
  let version = null;
  if (name === "cybercafe-agent.py") {
    const m = text.match(/^VERSION\s*=\s*"([^"]+)"/m);
    version = m ? m[1] : null;
  } else {
    const m = text.match(SCRIPT_VERSION_RE);
    version = m ? m[1] : null;
  }
  return { name, sha, bytes, source, version };
}

async function handleAdminScripts(env) {
  const out = [];
  for (const name of SCRIPT_FILES) {
    try {
      out.push(await scriptInfo(env, name));
    } catch (e) {
      out.push({ name, sha: null, bytes: 0, source: null, version: null, error: e.message });
    }
  }
  return json({ ok: true, scripts: out });
}

// 离线时长：last_seen 缺失用 first_seen 兜底；两者都缺返回 -1（保守跳过，不清理不隐藏）
function deviceOfflineSeconds(rec, now) {
  const ts = rec.last_seen || rec.first_seen || 0;
  if (!ts) return -1;
  return Math.max(0, now - ts);
}

// 幂等可重入清理：≥30 天清除 device:/cmd:/log:
// ——必须保留 devicekey:<hash>（agent 只启动时注册一次，删密钥=机器即使活着也永久消失；
//    保留密钥=回来心跳即复活）；同时保留 prov:machine/prov:hw 映射（同机回来不重领码）。
async function runDeviceCleanup(env, now) {
  const retireAfterS = await getRetireAfterS(env);   // 退役阈值走配置（实时生效）
  const keys = await kvListAll(env.CYBERCAFE_KV, "device:");
  let purged = 0, retired = 0, scanned = 0;
  for (const k of keys) {
    if (++scanned > CLEANUP_CAP) break;
    const id = k.name.slice("device:".length);
    const rec = await env.CYBERCAFE_KV.get(k.name, "json");
    if (!rec) continue;
    const secs = deviceOfflineSeconds(rec, now);
    if (secs < 0) continue;
    if (secs >= PURGE_AFTER_S) {
      await env.CYBERCAFE_KV.delete(`device:${id}`);
      await env.CYBERCAFE_KV.delete(`cmd:${id}`);
      await env.CYBERCAFE_KV.delete(`log:${id}`);
      purged++;
    } else if (secs >= retireAfterS) {
      retired++;   // 退役仅按时间派生（记录保留，列表侧隐藏）；无需写状态
    }
  }
  return { purged, retired, scanned };
}

async function handleAdminCleanup(env) {
  const now = Math.floor(Date.now() / 1000);
  const r = await runDeviceCleanup(env, now);
  await env.CYBERCAFE_KV.put(META_CLEANUP_KEY, String(now));
  return json({ ok: true, ...r });
}

async function maybeRunLazyCleanup(env, now) {
  const last = Number((await env.CYBERCAFE_KV.get(META_CLEANUP_KEY)) || 0);
  if (now - last < CLEANUP_INTERVAL_S) return null;
  const r = await runDeviceCleanup(env, now);
  await env.CYBERCAFE_KV.put(META_CLEANUP_KEY, String(now));
  return r;
}

async function handleAdminDevices(env, url) {
  const now = Math.floor(Date.now() / 1000);
  // 惰性触发：距上次清理 ≥1h 执行一次（幂等；在此先清后列，列表反映最新状态）
  await maybeRunLazyCleanup(env, now);
  const retireAfterS = await getRetireAfterS(env);   // 退役阈值走配置（实时生效）
  const includeRetired = (url.searchParams.get("include_retired") || "") === "1";
  const keys = await kvListAll(env.CYBERCAFE_KV, "device:");
  const recs = await Promise.all(keys.map(k => env.CYBERCAFE_KV.get(k.name, "json")));
  const devices = [];
  let retiredHidden = 0;
  for (const rec of recs) {
    if (!rec) continue;
    rec.online = now - (rec.last_seen || 0) < 35;
    const secs = deviceOfflineSeconds(rec, now);
    if (secs >= retireAfterS) {
      if (!includeRetired) { retiredHidden++; continue; }   // 退役隐藏（计数），?include_retired=1 展开
    }
    devices.push(rec);
  }
  // t78 UI 反馈：稳定键排序（hostname→device_id），心跳 last_seen 变化不再引起行顺序跳动
  devices.sort((a, b) => (a.hostname || a.device_id || "").localeCompare(b.hostname || b.device_id || ""));
  return json({ ok: true, devices, models: MODELS, engines: ENGINES, retired_hidden: retiredHidden });
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
  // 删除 batch:<code>；顺带清理该批次 prov:machine / prov:hw 映射（避免孤儿映射长期残留）。
  // 已注册设备记录（device:<id>）保留——agent 心跳/部署不受影响，仅该码无法再 provision 新机。
  const rec = await env.CYBERCAFE_KV.get(`batch:${code}`, "json");
  await env.CYBERCAFE_KV.delete(`batch:${code}`);
  const keys = await kvListAll(env.CYBERCAFE_KV, "prov:machine:");
  for (const k of keys) {
    const m = await env.CYBERCAFE_KV.get(k.name, "json");
    if (m && m.batch === code) await env.CYBERCAFE_KV.delete(k.name);
  }
  const hwKeys = await kvListAll(env.CYBERCAFE_KV, "prov:hw:");
  for (const k of hwKeys) {
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
  if (!body.device_id || !["stop", "restart_tunnel", "ocr", "h3"].includes(body.type))
    return json({ error: "device_id + type(stop|restart_tunnel|ocr|h3) required" }, 400);
  if (body.type === "ocr" && !["install", "uninstall"].includes(body.action))
    return json({ error: "ocr action(install|uninstall) required" }, 400);
  if (body.type === "h3" && !["install", "uninstall", "start", "stop"].includes(body.action))
    return json({ error: "h3 action(install|uninstall|start|stop) required" }, 400);
  const exists = await env.CYBERCAFE_KV.get(`device:${body.device_id}`, "json");
  if (!exists) return json({ error: "device not found" }, 404);
  await env.CYBERCAFE_KV.put(`cmd:${body.device_id}`,
    JSON.stringify({ type: body.type, ...(body.action ? { action: body.action } : {}),
                     created_at: Math.floor(Date.now() / 1000) }));
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
    // 连带吊销设备密钥（防止删除后旧 key 重新注册复活设备）与批次 machine/hw 映射
    if (rec.key_hash) await env.CYBERCAFE_KV.delete(`devicekey:${rec.key_hash}`);
    if (rec.machine_id) await env.CYBERCAFE_KV.delete(`prov:machine:${rec.machine_id}`);
    if (rec.hw_id) await env.CYBERCAFE_KV.delete(`prov:hw:${rec.hw_id}`);
  }
  return json({ ok: true, removed: !!rec });
}

// ---------- 脚本下发 ----------

// 无 key 文件下发白名单（?batch= 一键装机命令场景：install.sh 原始脚本公开下发，
// 批次模式自行领取 cck- key；provision.sh/service 供镜像预置/自包含命令取用）
// 白名单：name → 文件所在作用域（agent=agent/ 目录，走既有 fetchRepoFile 通道；
// root=仓库根目录，走 fetchRepoFileRoot 通道）。仅精确名单可下发，杜绝路径穿越/越权读取。
const INSTALL_EXTRA_ALLOW = {
  "install.sh": "agent",
  "provision.sh": "agent",
  "cybercafe-provision.service": "agent",
  "cybercafe-deploy.py": "agent",
  "uninstall-all.sh": "root",
  "ocr/install.sh": "root",     // t71：OCR 组件经 extra 通道下发（root 作用域 + ocr/ 子路径）
  "ocr/uninstall.sh": "root",
  "ocr/ocr.py": "root",
  "minimax-h3/install.sh": "root",   // t74：H3 组件经 extra 通道下发（root 作用域 + minimax-h3/ 子路径）
  "minimax-h3/uninstall.sh": "root",
};

async function handleInstallSh(request, env, url) {
  // ?key=<设备KEY>      → 单机安装：校验设备 key，注入 API_BASE/DEVICE_KEY
  // ?batch=<批次码>     → 批次一键装机（裸机无脚本场景）：无需 key，下发原始 install.sh
  //                       （占位符不注入，批次模式自行从 --api-base 参数 / provision API 取地址）
  const key = url.searchParams.get("key") || "";
  const batch = url.searchParams.get("batch") || "";
  if (!key && !batch) return new Response("missing ?key= or ?batch=\n", { status: 400 });
  if (key) {
    const rec = await env.CYBERCAFE_KV.get(`devicekey:${await sha256hex(key)}`);
    if (!rec) return new Response("invalid device key\n", { status: 403 });
  }
  try {
    const src = await fetchRepoFile(env, "install.sh");
    const body = key ? injectParams(src, publicOrigin(request, url), key) : src;
    return new Response(body, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8" } });
  } catch (e) {
    return new Response(`fetch install.sh failed: ${e.message}\n`, { status: 502 });
  }
}

async function handleInstallExtra(env, url) {
  // 白名单内部文件下发（镜像预置/一键装机命令在裸环境取配套文件；仓库文件本身公开）。
  // agent/ 文件走既有 fetchRepoFile；根目录文件（uninstall-all.sh）走 fetchRepoFileRoot。
  const name = url.searchParams.get("name") || "";
  const scope = INSTALL_EXTRA_ALLOW[name];
  if (!scope) return json({ error: "not allowed" }, 403);
  try {
    const src = scope === "root" ? await fetchRepoFileRoot(env, name) : await fetchRepoFile(env, name);
    return new Response(src, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return json({ error: `fetch ${name} failed: ${e.message}` }, 502);
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
      // 安装脚本（?key= 单机注入 / ?batch= 批次一键装机原始下发）
      if (path === "/install.sh" && request.method === "GET")
        return await handleInstallSh(request, env, url);

      // 白名单内部文件下发（镜像预置/一键装机配套文件，公开）
      if (path === "/install-extra" && request.method === "GET")
        return await handleInstallExtra(env, url);

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
          return await handleAdminDevices(env, url);
        if (path === "/api/admin/devices/cleanup" && request.method === "POST")
          return await handleAdminCleanup(env);
        if (path === "/api/admin/scripts" && request.method === "GET")
          return await handleAdminScripts(env);
        if (path === "/api/admin/settings" && request.method === "GET")
          return await handleAdminGetSettings(env);
        if (path === "/api/admin/settings" && request.method === "POST")
          return await handleAdminSetSettings(request, env);
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
