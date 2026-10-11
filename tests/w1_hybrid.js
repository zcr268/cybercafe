// W1-1 混合形态与聊天形态用例（t27 创建；t37 同步唯一部署模型语义）
// 新语义（t37，用户定）：一台设备同一时刻仅一个部署物（引擎/OCR/H3 平级互斥）——deploy 槽类型权威，
//   部署 H3 先卸载引擎、部署引擎后 H3 卸载；前端 targetName/级联默认/聊天形态随槽内 type。
// 用例：
//   H1 状态卡 type 权威：混合残留（engine+type:h3 / engine+type:ocr）→ 名称徽章=H3/OCR（非引擎）、
//      状态徽章=运行中、进度存在、一句话归属槽内类型（H3 含档位标注 / OCR 含版本）
//   H2 级联默认：h3 残留→文生视频→[H3]→档位（h3-fast 首项）→主按钮恒=部署引擎；ocr 残留→图生文→[OCR]；
//      纯引擎→文生文→引擎→模型（防回归保留）
//   C1 聊天形态：h3 残留→H3 视频形态（chatLabel=H3 v0.1.0、chatMeta=H3 文生视频、vidIn 显/ocrIn·chatIn 隐）；
//      ocr 残留→OCR 图片形态；纯 H3/纯 OCR 同；纯引擎→文本聊天（防回归保留）
// 种子 hostname 前缀 w1h-，结束 DELETE 清理。
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

const scenarios = [
  { key: 'hy-vllm-h3',   host: 'w1h-混合vllm-h3', kind: 'hybrid-h3',
    deploy: { state: 'online', engine: 'vllm', model: 'Qwen/Qwen2-1.5B-Instruct-AWQ', type: 'h3', step: 'h3', detail: 'H3 安装完成', version: '0.1.0', tier: 'h3-hd', quant: 'Q4_K_M', tunnel_url: 'https://hy-vllm.trycloudflare.com' },
    comps: { ocr: { state: 'installed' }, h3: { state: 'running' } } },
  { key: 'hy-ollama-h3', host: 'w1h-混合ollama-h3', kind: 'hybrid-h3',
    deploy: { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', type: 'h3', step: 'h3', detail: 'H3 安装完成', version: '0.1.0', tier: 'h3-hd', quant: 'Q4_K_M', tunnel_url: 'https://hy-ollama.trycloudflare.com' },
    comps: { ocr: { state: 'installed' }, h3: { state: 'running' } } },
  { key: 'hy-ollama-ocr', host: 'w1h-混合ollama-ocr', kind: 'hybrid-ocr',
    deploy: { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', type: 'ocr', step: 'ocr', detail: 'OCR 安装完成', version: '1.4.4', tunnel_url: 'https://hy-ollama-ocr.trycloudflare.com' },
    comps: { ocr: { state: 'installed' }, h3: { state: 'uninstalled' } } },
  { key: 'pure-ocr', host: 'w1h-纯OCR', kind: 'pure-ocr',
    deploy: { state: 'online', type: 'ocr', version: '1.4.4', tunnel_url: 'https://pure-ocr.trycloudflare.com' },
    comps: { ocr: { state: 'installed' }, h3: { state: 'uninstalled' } } },
  { key: 'pure-h3',  host: 'w1h-纯H3',  kind: 'pure-h3',
    deploy: { state: 'online', type: 'h3', version: '0.1.0', tier: 'h3-hd', quant: 'Q4_K_M', tunnel_url: 'https://pure-h3.trycloudflare.com' },
    comps: { ocr: { state: 'uninstalled' }, h3: { state: 'running' } } },
  { key: 'pure-engine', host: 'w1h-纯引擎', kind: 'pure-engine',
    deploy: { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', tunnel_url: 'https://pure-engine.trycloudflare.com' },
    comps: { ocr: { state: 'uninstalled' }, h3: { state: 'uninstalled' } } },
];
const devicesById = {};

const STATE_TOKENS = ['运行中','online','部署中','deploying','排队','queued','已停止','停止','stopped','闲置','idle','失败','failed','安装中','installing','卸载中','uninstalling'];
const PRESENCE = ['在线','离线'];
const badgesOf = el => el.filter(e => !e.btn && !e.link && e.bg && e.bg !== 'rgba(0, 0, 0, 0)' && e.radius >= 6 && !PRESENCE.includes(e.text));

const task = await useOrCreateTaskSpace('W1-混合形态与聊天形态验收-v3');
await openOrReuseTab(BASE + '/', { wait: true, timeout: 30 });
actions.push('打开真实页面 ' + BASE);
try { await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); actions.push('固定视口 1440×900'); } catch (e) { actions.push('视口固定失败（尽力而为）：' + String(e && e.message || e)); }
const appVisible = await js(`(() => { const a = document.getElementById('app'); return !!a && getComputedStyle(a).display !== 'none'; })()`);
if (!appVisible) {
  await fillInput('#tokenIn', ADMIN);
  await click('#btnLogin');
  actions.push('输入 token 并点击 登录');
  await waitForElement('#app');
}
await wait(2);

const seed = await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list.devices || [])) if (d.hostname && d.hostname.startsWith('w1h-')) await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth });
  window.__w1hkeys = window.__w1hkeys || {};
  const S = ${JSON.stringify(scenarios)};
  const out = {};
  for (const sc of S) {
    const j = await (await fetch('/api/admin/devices/new', { method: 'POST', headers: auth })).json();
    window.__w1hkeys[sc.host] = j.device_key;
    const device = { hostname: sc.host, cpu: 'x86 8c', gpu: 'RTX 4090', gpu_mem_mb: 24576, mem_total_gb: 64,
      agent_version: '9.9.9', components: sc.comps, deploy: sc.deploy };
    await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': j.device_key, 'content-type': 'application/json' }, body: JSON.stringify({ device }) });
    out[sc.host] = { hb: 'ok' };
  }
  const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list2.devices || [])) if (d.hostname && d.hostname.startsWith('w1h-')) out[d.hostname].device_id = d.device_id;
  return out;
})()`);
for (const sc of scenarios) devicesById[sc.key] = (seed[sc.host] || {}).device_id;
actions.push('种子 6 台（3 混合残留 + 纯OCR/纯H3/纯引擎）：' + JSON.stringify(Object.fromEntries(scenarios.map(s => [s.key, seed[s.host] && seed[s.host].hb ? 'ok' : 'fail']))));

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
await wait(2);
await shot('w1h-01-roster');

const describe = await js(`(async () => {
  const describeRow = (host) => {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
    const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(host));
    if (!tr) return { host, found: false };
    const tdS = tr.children[2], tdO = tr.children[3];
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
      barTexts: [...tdS.querySelectorAll('.bar')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
      buttons: [...tdO.querySelectorAll('button')].map(b => ({ id: b.id || '', cls: b.className, text: txt(b) })),
      selects: [...tdO.querySelectorAll('select')].map(s => ({ id: s.id || '', value: s.value, options: [...s.options].map(o => ({ value: o.value, text: o.textContent.trim(), selected: o.selected })) })) };
  };
  const S = ${JSON.stringify(scenarios)};
  const out = {};
  for (const sc of S) out[sc.key] = describeRow(sc.host);
  return out;
})()`);
actions.push('摘录 6 行状态/操作列 DOM');

const results = [];

// H1 状态卡 type 权威（唯一部署模型）：混合残留 → 名称徽章=H3/OCR（非引擎）
{
  const r = { id: 'H1', name: '状态卡 type 权威（唯一部署模型）：h3 残留→H3、ocr 残留→OCR、纯引擎→引擎', checks: [] };
  for (const sc of scenarios) {
    const d = describe[sc.key];
    if (!d.found) { r.checks.push([sc.key + ': 行未找到', false]); continue; }
    const badges = badgesOf(d.statusEl);
    const si = badges.findIndex(b => STATE_TOKENS.includes(b.text));
    const nameBadge = si > 0 ? badges.slice(0, si)[0] : null;
    const stateBadge = si >= 0 ? badges[si] : null;
    const prog = d.statusEl.find(e => e.bar || (e.pct && !e.btn && !e.link));
    const plain = d.statusEl.filter(e => !e.btn && !e.link && e.bg === 'rgba(0, 0, 0, 0)' && e.text.trim().length >= 2);
    const sentence = plain.length ? plain[plain.length - 1].text : '';
    const expName = sc.kind === 'hybrid-h3' || sc.kind === 'pure-h3' ? 'H3'
      : sc.kind === 'hybrid-ocr' || sc.kind === 'pure-ocr' ? 'OCR' : 'ollama';
    const cs = [];
    const nameOk = sc.kind === 'pure-engine'
      ? nameBadge && nameBadge.text.startsWith('ollama') && !/OCR|H3/.test(nameBadge.text)
      : nameBadge && nameBadge.text === expName;
    cs.push(['名称徽章=' + (sc.kind === 'pure-engine' ? 'ollama·模型' : expName) + '（type 权威，非引擎）', !!nameOk, nameBadge ? nameBadge.text : '∅']);
    cs.push(['状态徽章=运行中', !!stateBadge && stateBadge.text === '运行中', stateBadge ? stateBadge.text : '∅']);
    cs.push(['进度元素存在', !!prog, prog ? '有' : '无']);
    if (sc.kind === 'hybrid-h3' || sc.kind === 'pure-h3') {
      cs.push(['一句话含 h3-hd 档位标注（h3-hd (Q4_K_M)）', /h3-hd/.test(sentence) && /Q4_K_M/.test(sentence), sentence.slice(0, 60) || '∅']);
    } else if (sc.kind === 'hybrid-ocr' || sc.kind === 'pure-ocr') {
      cs.push(['一句话含 OCR 版本 v1.4.4', /v1\.4\.4/.test(sentence), sentence.slice(0, 60) || '∅']);
    } else {
      cs.push(['一句话归属引擎（非 h3/OCR 残留）', sentence.length > 0 && !/h3-hd|OCR/.test(sentence), sentence.slice(0, 60) || '∅']);
    }
    r.checks.push([sc.key + '(' + sc.host + ')', cs.every(c => c[1]), cs]);
  }
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// H2 级联默认随 type 权威
{
  const cs = [];
  for (const k of ['hy-vllm-h3', 'hy-ollama-h3']) {
    const d = describe[k];
    if (!d.found) { cs.push([k + ': 行未找到', false]); continue; }
    const sels = d.selects;
    const depBtn = d.buttons.find(b => /部署引擎/.test(b.text));
    const t0 = sels[0] ? sels[0].options.find(o => o.selected) : null;
    const e0 = sels[1] ? sels[1].options : [];
    const o0 = sels[2] ? sels[2].options : [];
    cs.push([k + ' 类型默认=文生视频(h3)', !!t0 && (t0.value === 'h3' || t0.text === '文生视频'), t0 ? (t0.value + '/' + t0.text) : '∅']);
    cs.push([k + ' 引擎下拉=[H3] 固定', e0.length === 1 && (e0[0].value === 'H3' || e0[0].text === 'H3'), e0.map(o => o.value || o.text).join('|') || '∅']);
    cs.push([k + ' 档位含 h3-fast/h3-hd 且首项= h3-fast', o0.length >= 2 && o0.some(o => /h3-fast/.test(o.value || o.text)) && o0.some(o => /h3-hd/.test(o.value || o.text)) && (o0.find(o => o.selected) || o0[0]).value === 'h3-fast', o0.map(o => (o.selected ? '*' : '') + (o.value || o.text)).join('|')]);
    cs.push([k + ' 主按钮恒=部署引擎', !!depBtn && depBtn.text === '部署引擎', depBtn ? depBtn.text : '∅']);
  }
  for (const k of ['hy-ollama-ocr', 'pure-ocr']) {
    const d = describe[k];
    if (!d.found) { cs.push([k + ': 行未找到', false]); continue; }
    const sels = d.selects;
    const depBtn = d.buttons.find(b => /部署引擎/.test(b.text));
    const t0 = sels[0] ? sels[0].options.find(o => o.selected) : null;
    const e0 = sels[1] ? sels[1].options : [];
    cs.push([k + ' 类型默认=图生文(ocr)', !!t0 && (t0.value === 'ocr' || t0.text === '图生文'), t0 ? (t0.value + '/' + t0.text) : '∅']);
    cs.push([k + ' 引擎下拉=[OCR] 固定', e0.length === 1 && (e0[0].value === 'OCR' || e0[0].text === 'OCR'), e0.map(o => o.value || o.text).join('|') || '∅']);
    cs.push([k + ' 档位=OCR（rapidocr 1.4.4）', sels[2] && /rapidocr/.test(sels[2].options.map(o => o.text).join('')), sels[2] ? sels[2].options.map(o => o.text).join('|') : '∅']);
    cs.push([k + ' 主按钮恒=部署引擎', !!depBtn && depBtn.text === '部署引擎', depBtn ? depBtn.text : '∅']);
  }
  {
    const d = describe['pure-engine'];
    if (!d.found) { cs.push(['pure-engine: 行未找到', false]); } else {
      const sels = d.selects;
      const depBtn = d.buttons.find(b => /部署引擎/.test(b.text));
      const t0 = sels[0] ? sels[0].options.find(o => o.selected) : null;
      const e0 = sels[1] ? sels[1].options.find(o => o.selected) : null;
      const o0 = sels[2] ? sels[2].options.find(o => o.selected) : null;
      cs.push(['纯引擎 类型默认=文生文', !!t0 && (t0.value === 'text' || t0.text === '文生文'), t0 ? (t0.value + '/' + t0.text) : '∅']);
      cs.push(['纯引擎 引擎默认=ollama', !!e0 && e0.value === 'ollama', e0 ? e0.value : '∅']);
      cs.push(['纯引擎 模型默认=qwen2.5:7b-instruct', !!o0 && o0.value === 'qwen2.5:7b-instruct', o0 ? o0.value : '∅']);
      cs.push(['纯引擎 主按钮恒=部署引擎', !!depBtn && depBtn.text === '部署引擎', depBtn ? depBtn.text : '∅']);
    }
  }
  results.push({ id: 'H2', name: '级联默认随 type 权威（h3→文生视频/[H3]/档位；ocr→图生文/[OCR]；纯引擎→文生文）', pass: cs.every(c => c[1]), checks: cs });
}

// C1 聊天形态随 type 权威
{
  const cs = [];
  const chat = await js(`(async () => {
    const sel = document.getElementById('chatDev');
    if (!sel) return { err: 'no chatDev' };
    const options = [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim() }));
    const set = async (host) => {
      const o = options.find(x => x.text.includes(host));
      if (!o) return { meta: 'option-missing', chatIn: 'n/a', vidIn: 'n/a', ocrIn: 'n/a' };
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const dsp = id => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'missing'; };
      return { meta: document.getElementById('chatMeta').textContent.trim(), chatIn: dsp('chatIn'), vidIn: dsp('vidIn'), ocrIn: dsp('ocrIn') };
    };
    const out = { options };
    out.hybridH3 = await set('w1h-混合vllm-h3');
    out.hybridOcr = await set('w1h-混合ollama-ocr');
    out.pureH3 = await set('w1h-纯H3');
    out.pureOcr = await set('w1h-纯OCR');
    out.pureEng = await set('w1h-纯引擎');
    return out;
  })()`);
  const labelOf = (arr, host) => { const t = (arr.options.find(o => o.text.includes(host)) || {}).text || '∅'; const m = t.match(/（([^）]+)）$/); return m ? m[1] : t; };
  cs.push(['混合h3 chatLabel=H3 0.1.0（type 权威，非引擎·模型）', /H3 0\.1\.0/.test(labelOf(chat, 'w1h-混合vllm-h3')), labelOf(chat, 'w1h-混合vllm-h3')]);
  cs.push(['混合ocr chatLabel=OCR 1.4.4', /OCR 1\.4\.4/.test(labelOf(chat, 'w1h-混合ollama-ocr')), labelOf(chat, 'w1h-混合ollama-ocr')]);
  cs.push(['纯H3 chatLabel=H3 0.1.0', /H3 0\.1\.0/.test(labelOf(chat, 'w1h-纯H3')), labelOf(chat, 'w1h-纯H3')]);
  cs.push(['纯OCR chatLabel=OCR 1.4.4', /OCR 1\.4\.4/.test(labelOf(chat, 'w1h-纯OCR')), labelOf(chat, 'w1h-纯OCR')]);
  cs.push(['纯引擎 chatLabel=ollama+模型', /ollama/.test(labelOf(chat, 'w1h-纯引擎')) && /qwen2\.5:7b/.test(labelOf(chat, 'w1h-纯引擎')), labelOf(chat, 'w1h-纯引擎')]);
  cs.push(['混合h3 聊天=H3 文生视频形态（vidIn 显/ocrIn·chatIn 隐）', chat.hybridH3 && /H3 文生视频/.test(chat.hybridH3.meta) && chat.hybridH3.vidIn !== 'none' && chat.hybridH3.ocrIn === 'none' && chat.hybridH3.chatIn === 'none', JSON.stringify(chat.hybridH3)]);
  cs.push(['混合ocr 聊天=OCR 图片形态（ocrIn 显）', chat.hybridOcr && /OCR 图片识别/.test(chat.hybridOcr.meta) && chat.hybridOcr.ocrIn !== 'none', JSON.stringify(chat.hybridOcr)]);
  cs.push(['纯H3 聊天=视频形态（防回归）', chat.pureH3 && /H3 文生视频/.test(chat.pureH3.meta) && chat.pureH3.vidIn !== 'none', JSON.stringify(chat.pureH3)]);
  cs.push(['纯OCR 聊天=图片形态（防回归）', chat.pureOcr && /OCR 图片识别/.test(chat.pureOcr.meta) && chat.pureOcr.ocrIn !== 'none', JSON.stringify(chat.pureOcr)]);
  cs.push(['纯引擎 聊天=文本聊天（防回归）', chat.pureEng && /文本聊天/.test(chat.pureEng.meta) && chat.pureEng.chatIn !== 'none' && chat.pureEng.vidIn === 'none', JSON.stringify(chat.pureEng)]);
  actions.push('聊天形态断言（混合h3/混合ocr/纯H3/纯OCR/纯引擎）');
  results.push({ id: 'C1', name: '聊天形态随 type 权威（h3=视频、ocr=图片、引擎=文本；防回归）', pass: cs.every(c => c[1]), checks: cs });
}

await shot('w1h-02-chat');

// ---------- 清理 w1h-* ----------
const cleanup = await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  let n = 0;
  for (const d of (list.devices || [])) if (d.hostname && d.hostname.startsWith('w1h-')) { await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth }); n++; }
  const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
  return { deleted: n, remainingW1h: (list2.devices || []).filter(d => (d.hostname || '').startsWith('w1h-')).length, total: (list2.devices || []).length };
})()`);
await shot('w1h-03-cleanup');
actions.push('清理 w1h-*：' + JSON.stringify(cleanup));

const verdicts = Object.fromEntries(results.map(r => [r.id, r.pass ? 'PASS' : 'FAIL']));
const finalOut = {
  url: BASE + '/',
  操作序列: actions,
  截图: shots,
  results: results.map(r => ({ id: r.id, name: r.name, pass: r.pass, checks: r.checks })),
  被测路径: BASE + '（本地沙箱真实运行页面，wrangler dev，token dev-admin-token-8848）',
  结论: '唯一部署模型语义（t37 同步）：' + Object.entries(verdicts).map(([k, v]) => k + '=' + v).join(' ') + '。',
};
cliLog(JSON.stringify(finalOut, null, 1));
await completeTaskSpace('W1-混合形态与聊天形态验收-v3', { keep: false });
})().catch(e => cliLog('ERR ' + (e && e.stack || e)));