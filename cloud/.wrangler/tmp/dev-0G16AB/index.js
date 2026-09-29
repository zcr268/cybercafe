var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var DEFAULT_RAW_BASE = "https://raw.githubusercontent.com/zcr268/cybercafe/main/agent";
var MODELS = ["qwen2.5:7b-instruct", "qwen2.5:14b-instruct-q4_k_m", "llama3.1:8b-instruct"];
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}
__name(json, "json");
async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256hex, "sha256hex");
function randKey(prefix) {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return prefix + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randKey, "randKey");
function rawBase(env) {
  return (env.GITHUB_RAW_BASE || DEFAULT_RAW_BASE).replace(/\/$/, "");
}
__name(rawBase, "rawBase");
async function fetchRepoFile(env, name) {
  const resp = await fetch(`${rawBase(env)}/${name}`, { cf: { cacheTtl: 30 } });
  if (!resp.ok) throw new Error(`fetch repo file ${name} failed: ${resp.status}`);
  return await resp.text();
}
__name(fetchRepoFile, "fetchRepoFile");
async function agentVersion(env) {
  const src = await fetchRepoFile(env, "cybercafe-agent.py");
  const m = src.match(/^VERSION\s*=\s*"([^"]+)"/m);
  return m ? m[1] : "0.0.0";
}
__name(agentVersion, "agentVersion");
function injectParams(src, apiBase, deviceKey) {
  return src.replaceAll("__API_BASE__", apiBase).replaceAll("__DEVICE_KEY__", deviceKey);
}
__name(injectParams, "injectParams");
async function deviceFromKey(request, env) {
  const key = request.headers.get("X-Device-Key") || "";
  if (!key) return null;
  const id = (await sha256hex(key)).slice(0, 12);
  const rec = await env.CYBERCAFE_KV.get(`devicekey:${await sha256hex(key)}`);
  if (!rec) return null;
  return { id, key };
}
__name(deviceFromKey, "deviceFromKey");
function adminOk(request, env) {
  if (!env.ADMIN_TOKEN) return { ok: false, resp: json({ error: "ADMIN_TOKEN \u672A\u914D\u7F6E" }, 500) };
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return { ok: false, resp: json({ error: "unauthorized" }, 401) };
  return { ok: true };
}
__name(adminOk, "adminOk");
async function handleRegister(request, env, dev) {
  const body = await request.json().catch(() => ({}));
  const info = body && body.device || {};
  const now = Math.floor(Date.now() / 1e3);
  const key = `device:${dev.id}`;
  const old = await env.CYBERCAFE_KV.get(key, "json") || {};
  const rec = {
    ...old,
    ...info,
    device_id: dev.id,
    first_seen: old.first_seen || now,
    last_seen: now,
    deploy: old.deploy || { state: "idle" }
  };
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));
  return json({ ok: true, device_id: dev.id });
}
__name(handleRegister, "handleRegister");
async function handleHeartbeat(request, env, dev) {
  const body = await request.json().catch(() => ({}));
  const upd = body && body.device || {};
  const now = Math.floor(Date.now() / 1e3);
  const key = `device:${dev.id}`;
  const old = await env.CYBERCAFE_KV.get(key, "json") || {};
  const rec = { ...old, ...upd, device_id: dev.id, last_seen: now };
  delete rec.command;
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));
  const cmdKey = `cmd:${dev.id}`;
  const cmd = await env.CYBERCAFE_KV.get(cmdKey, "json");
  if (cmd) await env.CYBERCAFE_KV.delete(cmdKey);
  let ver = "0.0.0";
  try {
    ver = await agentVersion(env);
  } catch (e) {
  }
  return json({ ok: true, server_time: now, agent_version: ver, command: cmd || null });
}
__name(handleHeartbeat, "handleHeartbeat");
async function handleProgress(request, env, dev) {
  const body = await request.json().catch(() => ({}));
  const now = Math.floor(Date.now() / 1e3);
  const key = `device:${dev.id}`;
  const rec = await env.CYBERCAFE_KV.get(key, "json") || { device_id: dev.id };
  rec.last_seen = now;
  rec.deploy = {
    ...rec.deploy || {},
    state: body.state === "fail" ? "failed" : body.step === "verify" && body.state === "ok" ? "online" : "deploying",
    step: body.step,
    step_state: body.state,
    detail: body.detail || "",
    ts: body.ts || now
  };
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));
  const logKey = `log:${dev.id}`;
  const logs = await env.CYBERCAFE_KV.get(logKey, "json") || [];
  logs.push({ ts: body.ts || now, step: body.step, state: body.state, detail: body.detail || "" });
  await env.CYBERCAFE_KV.put(logKey, JSON.stringify(logs.slice(-100)));
  return json({ ok: true });
}
__name(handleProgress, "handleProgress");
async function handleAdminDevices(env) {
  const list = await env.CYBERCAFE_KV.list({ prefix: "device:" });
  const now = Math.floor(Date.now() / 1e3);
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
__name(handleAdminDevices, "handleAdminDevices");
async function handleAdminNewDevice(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const key = randKey("cck-");
  await env.CYBERCAFE_KV.put(
    `devicekey:${await sha256hex(key)}`,
    JSON.stringify({ label: body.label || "", created_at: Math.floor(Date.now() / 1e3) })
  );
  return json({
    ok: true,
    device_key: key,
    install_command: `curl -fsSL "${origin}/install.sh?key=${key}" | bash`
  });
}
__name(handleAdminNewDevice, "handleAdminNewDevice");
async function handleAdminDeploy(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.device_id) return json({ error: "device_id required" }, 400);
  const model = MODELS.includes(body.model) ? body.model : MODELS[0];
  const cmd = {
    type: "deploy",
    model,
    api_key: randKey("sk-"),
    created_at: Math.floor(Date.now() / 1e3)
  };
  await env.CYBERCAFE_KV.put(`cmd:${body.device_id}`, JSON.stringify(cmd));
  await env.CYBERCAFE_KV.delete(`log:${body.device_id}`);
  const key = `device:${body.device_id}`;
  const rec = await env.CYBERCAFE_KV.get(key, "json") || { device_id: body.device_id };
  rec.deploy = { state: "queued", model, ts: Math.floor(Date.now() / 1e3) };
  await env.CYBERCAFE_KV.put(key, JSON.stringify(rec));
  return json({ ok: true, command: { ...cmd, api_key: void 0 } });
}
__name(handleAdminDeploy, "handleAdminDeploy");
async function handleAdminCommand(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.device_id || !["stop", "restart_tunnel"].includes(body.type))
    return json({ error: "device_id + type(stop|restart_tunnel) required" }, 400);
  await env.CYBERCAFE_KV.put(
    `cmd:${body.device_id}`,
    JSON.stringify({ type: body.type, created_at: Math.floor(Date.now() / 1e3) })
  );
  return json({ ok: true });
}
__name(handleAdminCommand, "handleAdminCommand");
async function handleAdminDeviceDetail(env, id) {
  const rec = await env.CYBERCAFE_KV.get(`device:${id}`, "json");
  if (!rec) return json({ error: "not found" }, 404);
  const logs = await env.CYBERCAFE_KV.get(`log:${id}`, "json") || [];
  const now = Math.floor(Date.now() / 1e3);
  rec.online = now - (rec.last_seen || 0) < 35;
  return json({ ok: true, device: rec, logs });
}
__name(handleAdminDeviceDetail, "handleAdminDeviceDetail");
async function handleAdminDeleteDevice(env, id) {
  const rec = await env.CYBERCAFE_KV.get(`device:${id}`, "json");
  await env.CYBERCAFE_KV.delete(`device:${id}`);
  await env.CYBERCAFE_KV.delete(`cmd:${id}`);
  await env.CYBERCAFE_KV.delete(`log:${id}`);
  return json({ ok: true, removed: !!rec });
}
__name(handleAdminDeleteDevice, "handleAdminDeleteDevice");
async function handleInstallSh(request, env, url) {
  const key = url.searchParams.get("key") || "";
  if (!key) return new Response("missing ?key=\n", { status: 400 });
  const rec = await env.CYBERCAFE_KV.get(`devicekey:${await sha256hex(key)}`);
  if (!rec) return new Response("invalid device key\n", { status: 403 });
  try {
    const src = await fetchRepoFile(env, "install.sh");
    const body = injectParams(src, url.origin, key);
    return new Response(body, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8" } });
  } catch (e) {
    return new Response(`fetch install.sh failed: ${e.message}
`, { status: 502 });
  }
}
__name(handleInstallSh, "handleInstallSh");
async function handleAgentLatest(request, env, dev, url) {
  try {
    const src = await fetchRepoFile(env, "cybercafe-agent.py");
    const body = injectParams(src, url.origin, dev.key);
    return new Response(body, { headers: { "Content-Type": "text/x-python; charset=utf-8" } });
  } catch (e) {
    return new Response(`fetch agent failed: ${e.message}
`, { status: 502 });
  }
}
__name(handleAgentLatest, "handleAgentLatest");
async function handleAgentVersion(env) {
  try {
    return json({ ok: true, version: await agentVersion(env) });
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}
__name(handleAgentVersion, "handleAgentVersion");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/install.sh" && request.method === "GET")
        return await handleInstallSh(request, env, url);
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
      if (path.startsWith("/api/admin/")) {
        const a = adminOk(request, env);
        if (!a.ok) return a.resp;
        if (path === "/api/admin/devices" && request.method === "GET")
          return await handleAdminDevices(env);
        if (path === "/api/admin/devices/new" && request.method === "POST")
          return await handleAdminNewDevice(request, env, url.origin);
        if (path === "/api/admin/deploy" && request.method === "POST")
          return await handleAdminDeploy(request, env);
        if (path === "/api/admin/command" && request.method === "POST")
          return await handleAdminCommand(request, env);
        const m = path.match(/^\/api\/admin\/device\/([0-9a-f]{12})$/);
        if (m && request.method === "GET") return await handleAdminDeviceDetail(env, m[1]);
        if (m && request.method === "DELETE") return await handleAdminDeleteDevice(env, m[1]);
        return json({ error: "not found" }, 404);
      }
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return new Response("cybercafe cloud (no assets bound)", { status: 200 });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};

// ../../../../.npm/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../.npm/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-uslLT3/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../.npm/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-uslLT3/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
