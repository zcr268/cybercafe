// W1-1 补测试盲区：引擎+组件共存混合形态 + 聊天形态（t27）
// 背景：生产实测发现「引擎+组件共存」形态——agent 把 H3/OCR 组件状态写入 deploy 槽（type/step/detail/quant/tier），
//       云端深度合并保留 engine；W1 前端曾以 dep.type==='h3'/'ocr' 全面劫持（状态卡/级联默认/聊天形态），
//       现有纯引擎/纯组件 9 场景种子无法拦截 → 本用例补混合形态回归门禁。
// 用例：
//   H1 混合形态状态卡（3 台：vllm+h3 残留、ollama+h3 残留、ollama+ocr 残留）——名称徽章=引擎·模型（非 OCR/H3）、
//      状态徽章=运行中、进度存在、一句话不含 h3 档位（h3-hd/h3-fast/Q4_K_M）
//   H2 混合形态操作列默认=文生文→引擎→模型→部署引擎（级联不被组件 type 劫持）
//   C1 聊天形态：混合设备 chatLabel=引擎+模型（非 'H3 0.1.0'）、chatMeta=「文本聊天」+输入框显示；
//      纯 H3/OCR 设备聊天为 视频/图片 形态（防回归）
// 种子说明：混合设备 deploy 补 state:'online'（agent 上报 H3 运行态，状态徽章=运行中所必需；cardState 不推导组件态）
//          与 tunnel_url（聊天下拉要求在线+隧道）；hostname 前缀 w1h-，结束 DELETE 清理。
(async () => {
const BASE = 'http://127.0.0.1:8788';
const ADMIN = 'dev-admin-token-8848';
const WORK = '/tmp/界面统一/部署状态操作列统一';
const SHOT_DIR = WORK + '/tests/screenshots';
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const actions = [];
const shots = [];

const fs = await import('node:fs');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = async (name) => {
  const p = SHOT_DIR + '/' + name + '-' + RUN + '.png';
  try { await captureScreenshot(p); shots.push(p); return p; } catch (e) { return 'SHOT_FAIL:' + (e && e.message || e); }
};

// ---------- 种子 ----------
const scenarios = [
  { key: 'hy-vllm-h3',  host: 'w1h-混合vllm-h3',   kind: 'hybrid', engine: 'vllm',   model: 'Qwen/Qwen2-1.5B-Instruct-AWQ',
    deploy: { state: 'online', engine: 'vllm', model: 'Qwen/Qwen2-1.5B-Instruct-AWQ', type: 'h3', step: 'h3', detail: 'H3 安装完成（running）', quant: 'Q4_K_M', tier: 'h3-hd', version: '0.1.0', tunnel_url: 'https://hy-vllm.trycloudflare.com' },
    comps: { ocr: { state: 'installed' }, h3: { state: 'running' } } },
  { key: 'hy-ollama-h3', host: 'w1h-混合ollama-h3', kind: 'hybrid', engine: 'ollama', model: 'qwen2.5:7b-instruct',
    deploy: { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', type: 'h3', step: 'h3', detail: 'H3 安装完成（running）', quant: 'Q4_K_M', tier: 'h3-hd', version: '0.1.0', tunnel_url: 'https://hy-ollama.trycloudflare.com' },
    comps: { ocr: { state: 'installed' }, h3: { state: 'running' } } },
  { key: 'hy-ollama-ocr', host: 'w1h-混合ollama-ocr', kind: 'hybrid', engine: 'ollama', model: 'qwen2.5:7b-instruct',
    deploy: { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', type: 'ocr', step: 'ocr', detail: 'OCR 安装完成', version: '1.4.4', tunnel_url: 'https://hy-ollama-ocr.trycloudflare.com' },
    comps: { ocr: { state: 'installed' }, h3: { state: 'uninstalled' } } },
  { key: 'pure-ocr', host: 'w1h-纯OCR', kind: 'pure', pure: 'OCR',
    deploy: { state: 'online', type: 'ocr', version: '1.4.4', tunnel_url: 'https://pure-ocr.trycloudflare.com' },
    comps: { ocr: { state: 'installed' }, h3: { state: 'uninstalled' } } },
  { key: 'pure-h3',  host: 'w1h-纯H3',  kind: 'pure', pure: 'H3',
    deploy: { state: 'online', type: 'h3', version: '0.1.0', tunnel_url: 'https://pure-h3.trycloudflare.com' },
    comps: { ocr: { state: 'uninstalled' }, h3: { state: 'running' } } },
];
const devicesById = {};   // key -> device_id

// ---------- 语义表 ----------
const STATE_TOKENS = ['运行中','online','部署中','deploying','排队','queued','已停止','停止','stopped','闲置','idle','失败','failed','安装中','installing','卸载中','uninstalling'];
const PRESENCE = ['在线','离线'];
const badgesOf = el => el.filter(e => !e.btn && !e.link && e.bg && e.bg !== 'rgba(0, 0, 0, 0)' && e.radius >= 6 && !PRESENCE.includes(e.text));

const task = await useOrCreateTaskSpace('W1-混合形态验收-v2');
await openOrReuseTab(BASE + '/', { wait: true, timeout: 30 });
actions.push('打开真实页面 ' + BASE);
// 视口固定（t30 环境发现：ego 窗口偶发 0×0 视口 → 截图/CDP 坐标点击失效），一次到位防复现
try { await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); actions.push('固定视口 1440×900'); } catch (e) { actions.push('视口固定失败（尽力而为）：' + String(e && e.message || e)); }
const appVisible = await js(`(() => { const a = document.getElementById('app'); return !!a && getComputedStyle(a).display !== 'none'; })()`);
if (!appVisible) {
  await fillInput('#tokenIn', ADMIN);
  await click('#btnLogin');
  actions.push('输入 token 并点击 登录');
  await waitForElement('#app');
} else {
  actions.push('复用已登录会话');
}
await wait(2);

// ---------- 种子（页面内 fetch；首步清 w1h-* 残留） ----------
const seed = await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list.devices || [])) {
    if (d.hostname && d.hostname.startsWith('w1h-')) await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth });
  }
  window.__w1hkeys = window.__w1hkeys || {};
  const S = ${JSON.stringify(scenarios)};
  const out = {};
  for (const sc of S) {
    const j = await (await fetch('/api/admin/devices/new', { method: 'POST', headers: auth })).json();
    window.__w1hkeys[sc.host] = j.device_key;
    const device = { hostname: sc.host, cpu: 'x86 8c', gpu: 'RTX 4090', gpu_mem_mb: 24576, mem_total_gb: 64,
      agent_version: '9.9.9', components: sc.comps, deploy: sc.deploy };
    const r = await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': j.device_key, 'content-type': 'application/json' }, body: JSON.stringify({ device }) });
    out[sc.host] = { hb: r.status };
  }
  const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list2.devices || [])) if (d.hostname && d.hostname.startsWith('w1h-')) out[d.hostname].device_id = d.device_id;
  return out;
})()`);
for (const sc of scenarios) devicesById[sc.key] = (seed[sc.host] || {}).device_id;
actions.push('种子混合形态设备：' + JSON.stringify(Object.fromEntries(scenarios.map(s => [s.key, seed[s.host] && seed[s.host].hb]))));

await waitForElement('#devRows tr');
await js(`(async () => {
  const hosts = ${JSON.stringify(scenarios.map(s => s.host))};
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
    const texts = rows.map(tr => (tr.children[0] || {}).textContent || '').join(' ');
    if (hosts.every(h => texts.includes(h))) return 'ready';
    await new Promise(r => setTimeout(r, 600));
  }
  return 'timeout';
})()`);
await js(`(async () => {
  const keys = window.__w1hkeys || {};
  for (const h of Object.keys(keys)) {
    await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': keys[h], 'content-type': 'application/json' }, body: JSON.stringify({ device: {} }) });
  }
  return Object.keys(keys).length;
})()`);
await wait(1);
await shot('w1h-01-roster');

const describe = await js(`(async () => {
  const describeRow = (host) => {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
    const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(host));
    if (!tr) return { host, found: false };
    const tdS = tr.children[2], tdO = tr.children[3];
    if (!tdS || !tdO) return { host, found: true, malformed: true };
    const txt = el => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
    const walk = root => {
      const out = [];
      if (!root) return out;
      const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = it.nextNode())) {
        if (n.tagName === 'BR' || n.tagName === 'OPTION' || n.children.length > 0) continue;
        const cs = getComputedStyle(n);
        const t = txt(n);
        if (!t) continue;
        out.push({ tag: n.tagName, cls: String(n.className || ''), text: t.slice(0, 140),
          bg: cs.backgroundColor, radius: parseFloat(cs.borderRadius) || 0,
          link: n.tagName === 'A', btn: n.tagName === 'BUTTON',
          bar: n.classList.contains('bar') || !!n.querySelector('.bar'), pct: /\\d+%/.test(t) });
      }
      return out;
    };
    return { host, found: true, statusText: txt(tdS), opsText: txt(tdO), statusEl: walk(tdS),
      buttons: [...tdO.querySelectorAll('button')].map(b => ({ id: b.id || '', cls: b.className, text: txt(b) })),
      selects: [...tdO.querySelectorAll('select')].map(s => ({ id: s.id || '', value: s.value, options: [...s.options].map(o => ({ value: o.value, text: o.textContent.trim(), selected: o.selected })) })) };
  };
  const S = ${JSON.stringify(scenarios)};
  const out = {};
  for (const sc of S) out[sc.key] = describeRow(sc.host);
  return out;
})()`);
actions.push('摘录 5 行（3 混合 + 2 纯组件）状态/操作列 DOM');

const results = [];

// H1 混合形态状态卡（名称徽章=引擎·模型、状态徽章=运行中、进度、一句话无 h3 档位）
{
  const r = { id: 'H1', name: '混合形态（引擎+组件共存）状态卡不被组件 type 劫持', checks: [] };
  for (const sc of scenarios) {
    if (sc.kind !== 'hybrid') continue;
    const d = describe[sc.key];
    if (!d.found) { r.checks.push([sc.key + ': 行未找到', false]); continue; }
    const st = d.statusEl;
    const badges = badgesOf(st);
    const si = badges.findIndex(b => STATE_TOKENS.includes(b.text));
    const nameBadge = si > 0 ? badges.slice(0, si)[0] : null;
    const stateBadge = si >= 0 ? badges[si] : null;
    const pos = el => st.indexOf(el);
    const namePos = nameBadge ? pos(nameBadge) : -1;
    const statePos = stateBadge ? pos(stateBadge) : -1;
    const prog = st.find(e => e.bar || (e.pct && !e.btn && !e.link));
    const progPos = prog ? pos(prog) : -1;
    const plain = st.filter(e => !e.btn && !e.link && e.bg === 'rgba(0, 0, 0, 0)' && e.text.trim().length >= 2);
    const after = progPos >= 0 ? plain.filter(e => pos(e) > progPos) : plain.filter(e => pos(e) > statePos);
    const sentence = after.length ? after[after.length - 1] : null;
    const cs = [];
    const nbt = nameBadge ? nameBadge.text : '';
    cs.push(['名称徽章含引擎(' + sc.engine + ') 且非 OCR/H3', !!nameBadge && nbt.includes(sc.engine) && !/^H3\b|^OCR\b/.test(nbt), nbt || '∅']);
    cs.push(['状态徽章=运行中', !!stateBadge && (stateBadge.text === '运行中' || stateBadge.text === 'online'), stateBadge ? stateBadge.text : '∅']);
    cs.push(['顺序 名称<状态', namePos >= 0 && statePos >= 0 && namePos < statePos, namePos + '/' + statePos]);
    cs.push(['进度元素存在', progPos >= 0, progPos < 0 ? '无' : '有']);
    const snt = sentence ? sentence.text : '';
    cs.push(['一句话不含 h3 档位(h3-hd/h3-fast/Q4_K_M)', !!sentence && !/h3-(hd|fast)|Q4_K_M/i.test(snt), snt.slice(0, 50) || '∅']);
    r.checks.push([sc.key + '(' + sc.host + ')', cs.every(c => c[1]), cs]);
  }
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// H2 混合形态操作列默认 = 文生文→引擎→模型→部署引擎（级联不被组件 type 劫持）
{
  const cs = [];
  for (const k of ['hy-vllm-h3', 'hy-ollama-h3', 'hy-ollama-ocr']) {
    const sc = scenarios.find(s => s.key === k);
    const d = describe[k];
    if (!d.found) { cs.push([k + ': 行未找到', false]); continue; }
    const sels = d.selects;
    const depBtn = d.buttons.find(b => /部署引擎/.test(b.text));
    const t0 = sels[0] ? sels[0].options.find(o => o.selected) : null;
    const e0 = sels[1] ? sels[1].options.find(o => o.selected) : null;
    const o0 = sels[2] ? sels[2].options.find(o => o.selected) : null;
    cs.push([k + ' 类型默认=文生文', !!t0 && (t0.value === 'text' || t0.text === '文生文'), t0 ? (t0.value + '/' + t0.text) : '∅']);
    cs.push([k + ' 引擎默认=' + sc.engine, !!e0 && e0.value === sc.engine, e0 ? e0.value : '∅']);
    cs.push([k + ' 模型默认=' + sc.model, !!o0 && o0.value === sc.model, o0 ? o0.value : '∅']);
    cs.push([k + ' 主按钮=部署引擎', !!depBtn && depBtn.text === '部署引擎', depBtn ? depBtn.text : '∅']);
    const eOpts = sels.length >= 2 ? sels[1].options.map(o => o.value || o.text) : [];
    const notHijacked = eOpts.length >= 1 && !(eOpts.length === 1 && (eOpts[0] === 'OCR' || eOpts[0] === 'H3'));
    cs.push([k + ' 引擎下拉非 OCR/H3 固定项（级联未被组件 type 劫持）', notHijacked, eOpts.join('|') || '∅']);
  }
  results.push({ id: 'H2', name: '混合形态操作列默认=文生文→引擎→模型→部署引擎（级联不被劫持）', pass: cs.every(c => c[1]), checks: cs });
}

// C1 聊天形态：混合=文本；纯 H3/OCR=视频/图片（防回归）
{
  const cs = [];
  const rid = devicesById['hy-vllm-h3'];
  const chat = await js(`(async () => {
    const sel = document.getElementById('chatDev');
    if (!sel) return { err: 'no chatDev' };
    const options = [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim() }));
    const set = async (id) => {
      sel.value = id;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const meta = document.getElementById('chatMeta').textContent.trim();
      const dsp = id => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'missing'; };
      return { meta, chatIn: dsp('chatIn'), vidIn: dsp('vidIn'), ocrIn: dsp('ocrIn') };
    };
    const out = { options };
    out.hybrid = await set(${JSON.stringify(rid)});
    out.pureH3 = await set(${JSON.stringify(devicesById['pure-h3'])});
    out.pureOcr = await set(${JSON.stringify(devicesById['pure-ocr'])});
    return out;
  })()`);
  const labelOf = (arr, host) => (arr.options.find(o => o.text.includes(host)) || {}).text || '∅';
  cs.push(['chatLabel(混合vllm)=vllm+模型 非 H3', /vllm/.test(labelOf(chat, 'w1h-混合vllm-h3')) && /Qwen\/Qwen2-1\.5B/.test(labelOf(chat, 'w1h-混合vllm-h3')) && !/H3 0\.1\.0/.test(labelOf(chat, 'w1h-混合vllm-h3')), labelOf(chat, 'w1h-混合vllm-h3')]);
  cs.push(['chatLabel(混合ollama)=ollama+模型', /ollama/.test(labelOf(chat, 'w1h-混合ollama-h3')) && /qwen2\.5:7b/.test(labelOf(chat, 'w1h-混合ollama-h3')) && !/H3 0\.1\.0/.test(labelOf(chat, 'w1h-混合ollama-h3')), labelOf(chat, 'w1h-混合ollama-h3')]);
  cs.push(['chatLabel(纯OCR)=OCR 1.4.4（选项文本含 hostname 前缀）', /OCR 1\.4\.4/.test(labelOf(chat, 'w1h-纯OCR')), labelOf(chat, 'w1h-纯OCR')]);
  cs.push(['chatLabel(纯H3)=H3 0.1.0（选项文本含 hostname 前缀）', /H3 0\.1\.0/.test(labelOf(chat, 'w1h-纯H3')), labelOf(chat, 'w1h-纯H3')]);
  cs.push(['混合 chatMeta=文本聊天 且 文本输入框显示/视频·图片框隐藏', chat.hybrid && /文本聊天/.test(chat.hybrid.meta) && chat.hybrid.chatIn !== 'none' && chat.hybrid.vidIn === 'none' && chat.hybrid.ocrIn === 'none', JSON.stringify(chat.hybrid)]);
  cs.push(['纯H3 chatMeta=H3 文生视频 且 视频框显示', chat.pureH3 && /H3 文生视频/.test(chat.pureH3.meta) && chat.pureH3.vidIn !== 'none', JSON.stringify(chat.pureH3)]);
  cs.push(['纯OCR chatMeta=OCR 图片识别 且 图片框显示', chat.pureOcr && /OCR 图片识别/.test(chat.pureOcr.meta) && chat.pureOcr.ocrIn !== 'none', JSON.stringify(chat.pureOcr)]);
  actions.push('聊天形态切换断言（混合/纯H3/纯OCR）');
  results.push({ id: 'C1', name: '聊天形态：混合=文本聊天；纯H3=视频；纯OCR=图片（防回归）', pass: cs.every(c => c[1]), checks: cs });
}

await shot('w1h-02-chat-hybrid');
await shot('w1h-03-chat-h3');
await shot('w1h-04-chat-ocr');

// ---------- 清理 w1h-* ----------
await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  let n = 0;
  for (const d of (list.devices || [])) if (d.hostname && d.hostname.startsWith('w1h-')) { await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth }); n++; }
  const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
  return { deleted: n, remainingW1h: (list2.devices || []).filter(d => (d.hostname || '').startsWith('w1h-')).length, total: (list2.devices || []).length };
})()`);
await shot('w1h-05-cleanup');

const verdicts = Object.fromEntries(results.map(r => [r.id, r.pass ? 'PASS' : 'FAIL']));
const finalOut = {
  url: BASE + '/',
  操作序列: actions,
  截图: shots,
  results: results.map(r => ({ id: r.id, name: r.name, pass: r.pass, checks: r.checks })),
  被测路径: BASE + '（本地沙箱真实运行页面，wrangler dev，token dev-admin-token-8848）',
  结论: '混合形态/聊天形态盲区用例：' + Object.entries(verdicts).map(([k, v]) => k + '=' + v).join(' ') +
        '；实现侧 41184ec（引擎部署优先）修复后应全 PASS。',
};
cliLog(JSON.stringify(finalOut, null, 1));
await completeTaskSpace('W1-混合形态验收-v2', { keep: false });
})().catch(e => cliLog('ERR ' + (e && e.stack || e)));