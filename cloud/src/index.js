// CyberCafe 云管理端 (Cloudflare Worker)
// - 设备注册/心跳/进度上报（X-Device-Key 鉴权）
// - 管理 API（Bearer ADMIN_TOKEN 鉴权）
// - 安装脚本/控制脚本实时下发（从 GitHub 仓库 agent/ 拉取并注入参数）
// - 静态管理 UI（assets）

const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com/zcr268/cybercafe/main/agent";
const MODELS = ["qwen2.5:7b-instruct", "qwen2.5:14b-instruct-q4_k_m", "llama3.1:8b-instruct"];

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

function rawBase(env) {
  return (env.GITHUB_RAW_BASE || DEFAULT_RAW_BASE).replace(/\/$/, "");
}

async function fetchRepoFile(env, name) {
  // raw.githubusercontent.com CDN 缓存较久：按 60s 窗口加查询参数破缓存，
  // 保证「从仓库实时拉取」语义，同时避免每次心跳都打到 GitHub 源站。
  const bust = Math.floor(Date.now() / 60000);
  const resp = await fetch(`${rawBase(env)}/${name}?t=${bust}`, { cf: { cacheTtl: 30 } });
  if (!resp.ok) throw new Error(`fetch repo file ${name} failed: ${resp.status}`);
  return await resp.text();
}

// 经 cloudflared 等反代时 url.protocol 是 http，用 X-Forwarded-Proto 还原真实协议
function publicOrigin(request, url) {
  const proto = request.headers.get("X-Forwarded-Proto") || url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

async function agentVersion(env) {
  const src = await fetchRepoFile(env, "cybercafe-agent.py");
  const m = src.match(/^VERSION\s*=\s*"([^"]+)"/m);
  return m ? m[1] : "0.0.0";
}

function injectParams(src, apiBase, deviceKey) {
  return src.replaceAll("__API_BASE__", apiBase).replaceAll("__DEVICE_KEY__", deviceKey);
}

// ---------- 鉴权 ----------

async function deviceFromKey(request, env) {
  const key = request.headers.get("X-Device-Key") || "";
  if (!key) return null;
  const id = (await sha256hex(key)).slice(0, 12);
  const rec = await env.CYBERCAFE_KV.get(`devicekey:${await sha256hex(key)}`);
  if (!rec) return null;
  return { id, key };
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
  rec.deploy = {
    ...(rec.deploy || {}),
    state: body.state === "fail" ? "failed" : (body.step === "verify" && body.state === "ok" ? "online" : "deploying"),
    step: body.step,
    step_state: body.state,
    detail: body.detail || "",
    ts: body.ts || now,
  };
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));

  // 追加进度日志（保留最近100条）
  const logKey = `log:${dev.id}`;
  const logs = (await env.CYBERCAFE_KV.get(logKey, "json")) || [];
  logs.push({ ts: body.ts || now, step: body.step, state: body.state, detail: body.detail || "" });
  await env.CYBERCAFE_KV.put(logKey, JSON.stringify(logs.slice(-100)));
  return json({ ok: true });
}

// ---------- 管理侧 API ----------

async function handleAdminDevices(env) {
  const list = await env.CYBERCAFE_KV.list({ prefix: "device:" });
  const now = Math.floor(Date.now() / 1000);
  const devices = [];
  for (const k of list.keys) {
    const rec = await env.CYBERCAFE_KV.get(k.name, "json");
    if (!rec) continue;
    rec.online = now - (rec.last_seen || 0) < 35;
    devices.push(rec);
  }
  devices.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  return json({ ok: true, devices, models: MODELS });
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
  const model = MODELS.includes(body.model) ? body.model : MODELS[0];
  const cmd = {
    type: "deploy",
    model,
    api_key: randKey("sk-"),
    created_at: Math.floor(Date.now() / 1000),
  };
  await env.CYBERCAFE_KV.put(`cmd:${body.device_id}`, JSON.stringify(cmd));
  // 清理旧日志，标记排队中
  await env.CYBERCAFE_KV.delete(`log:${body.device_id}`);
  const key = `device:${body.device_id}`;
  const rec = (await env.CYBERCAFE_KV.get(key, "json")) || { device_id: body.device_id };
  rec.deploy = { state: "queued", model, ts: Math.floor(Date.now() / 1000) };
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));
  return json({ ok: true, command: { ...cmd, api_key: undefined } });
}

async function handleAdminCommand(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.device_id || !["stop", "restart_tunnel"].includes(body.type))
    return json({ error: "device_id + type(stop|restart_tunnel) required" }, 400);
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
