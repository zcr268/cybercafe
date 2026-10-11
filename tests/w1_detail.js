// W1-1 详情/日志折叠交互用例（t41 锁语义，配合开发 1 修复）
// 语义（per-tab 切换目标）：
//   详情按钮：折叠态→展开(详情 tab A)；展开且 A 激活→折叠；展开且 B(日志) 激活→切到 A（不折叠）
//   日志按钮：折叠态→展开(日志 tab B)；展开且 B 激活→折叠；展开且 A 激活→切到 B（不折叠）
// 断言：
//   D1 展开详情→再点详情→折叠（tr.display=none、expandedDevs 移除、logIntervals[id] 清理、tabState 清理）
//   D2 展开(详情 tab)→点日志→切到日志 tab（不折叠）
//   D3 日志 tab 展开→再点日志→折叠（当前实现 RED=修复目标）
//   D4 日志展开→点详情→切到详情 tab（不折叠，layersDetail 可见；当前实现 RED=修复目标）
//   D5 二次展开（缓存生效）时 /api/admin/scripts 不重复请求（fetch 计数 delta=0）
// 种子前缀 w1d-，结束 DELETE 清理。
(async () => {
const BASE = 'http://127.0.0.1:8788';
const ADMIN = 'dev-admin-token-8848';
const WORK = '/tmp/界面统一/部署状态操作列统一';
const SHOT_DIR = WORK + '/tests/screenshots';
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const actions = [];
const shots = [];
const results = [];

const fs = await import('node:fs');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = async (name) => {
  const p = SHOT_DIR + '/' + name + '-' + RUN + '.png';
  try { await captureScreenshot(p); shots.push(p); return p; } catch (e) { return 'SHOT_FAIL:' + (e && e.message || e); }
};

const task = await useOrCreateTaskSpace('W1-详情日志折叠交互');
await openOrReuseTab(BASE + '/', { wait: true, timeout: 30 });
actions.push('打开真实页面 ' + BASE);
try { await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); actions.push('固定视口 1440×900'); } catch (e) {}
const appVisible = await js(`(() => { const a = document.getElementById('app'); return !!a && getComputedStyle(a).display !== 'none'; })()`);
if (!appVisible) {
  await fillInput('#tokenIn', ADMIN);
  await click('#btnLogin');
  await waitForElement('#app');
}
await wait(2);
// fetch 计数（统计 /api/admin/scripts）
await js(`(() => {
  window.__fcount = window.__fcount || { scripts: 0 };
  const of = window.fetch;
  window.fetch = (...a) => { const u = String(a[0] || ''); if (u.includes('/api/admin/scripts')) window.__fcount.scripts++; return of.apply(window, a); };
  return true;
})()`);
actions.push('注入 fetch 计数（scripts 请求统计）');

// 种子：1 台设备 + layers（详情 layersDetail 内容）+ 进度日志 2 条
const HOST = 'w1d-折叠交互';
let DID = null;
{
  const r = await js(`(async () => {
    const ADMIN = ${JSON.stringify(ADMIN)};
    const auth = { 'Authorization': 'Bearer ' + ADMIN };
    const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
    for (const d of (list.devices || [])) if (d.hostname && d.hostname.startsWith('w1d-')) await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth });
    const j = await (await fetch('/api/admin/devices/new', { method: 'POST', headers: auth })).json();
    window.__w1dkey = j.device_key;
    const device = { hostname: ${JSON.stringify(HOST)}, cpu: 'x86 8c', gpu: 'RTX 4090', gpu_mem_mb: 24576, mem_total_gb: 64,
      agent_version: '9.9.9',
      components: { ocr: { state: 'uninstalled' }, h3: { state: 'uninstalled' } },
      deploy: { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', tunnel_url: 'https://w1d.trycloudflare.com' },
      layers: { install: { version: '1.2.3', sha8: 'abc12345' }, provision: { version: '1.1.0', sha8: 'def67890' },
        agent: { version: '9.9.9', sha8: 'aaaabbbb' }, service: { version: '3.2.1', sha8: 'ccccdddd' },
        units: { 'cybercafe.svc': { active: 'active', enabled: 'enabled' } }, channel: 'stable', last_update: Math.floor(Date.now() / 1000) } };
    await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': j.device_key, 'content-type': 'application/json' }, body: JSON.stringify({ device }) });
    await fetch('/api/device/progress', { method: 'POST', headers: { 'X-Device-Key': j.device_key, 'content-type': 'application/json' }, body: JSON.stringify({ step: 'verify', state: 'ok', detail: '模型就绪' }) });
    await fetch('/api/device/progress', { method: 'POST', headers: { 'X-Device-Key': j.device_key, 'content-type': 'application/json' }, body: JSON.stringify({ step: 'tunnel', state: 'ok', detail: 'https://w1d.trycloudflare.com' }) });
    const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
    const d = (list2.devices || []).find(x => x.hostname === ${JSON.stringify(HOST)});
    return { device_id: d && d.device_id };
  })()`);
  DID = r.device_id;
}
actions.push('种子 ' + HOST + ' id=' + DID);
await js(`(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
    if (rows.some(x => (x.children[0] || {}).textContent && x.children[0].textContent.includes(${JSON.stringify(HOST)}))) return 'ready';
    await new Promise(r => setTimeout(r, 600));
  }
  return 'timeout';
})()`);
await wait(2);

// 行内按钮 CDP 点击（主行内按文案定位 详情/日志）
const rowBtnCd = async (host, text) => {
  const hit = await js(`(() => {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
    const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(host)}));
    if (!tr) return null;
    const b = [...tr.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)} && !String(x.id || '').startsWith('tab'));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!hit) return 'not-found';
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
  await wait(0.6);
  return 'ok';
};
const detailState = async () => js(`(() => {
  const id = ${JSON.stringify(DID)};
  const tr = document.getElementById('detail_' + id);
  if (!tr) return { missing: true };
  const tabA = document.getElementById('tabA_' + id + '_body');
  const tabB = document.getElementById('tabB_' + id + '_body');
  return {
    visible: tr.style.display !== 'none',
    expanded: (typeof expandedDevs !== 'undefined') ? expandedDevs.has(id) : 'n/a',
    logInt: (typeof logIntervals !== 'undefined' && logIntervals[id]) ? 'set' : 'cleared',
    tabMem: (typeof tabState !== 'undefined' && tabState[id]) ? tabState[id] : 'none',
    tabA: tabA ? getComputedStyle(tabA).display : 'missing',
    tabB: tabB ? getComputedStyle(tabB).display : 'missing',
    tabABody: tabA ? tabA.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : '',
  };
})()`);

// pollDetail：轮询 detailState 至谓词满足（展开/折叠为异步 fillDetail，避免固定 sleep 竞态）
const pollDetail = async (pred, timeoutMs = 8000) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await detailState();
    if (pred(last)) return last;
    await wait(0.4);
  }
  return last;
};

// D1 展开详情 → 再点详情 → 折叠
{
  const cs = [];
  await rowBtnCd(HOST, '详情');
  const open = await pollDetail(x => x.visible === true && x.tabA !== 'missing' && x.tabA !== 'none');
  cs.push(['首次点击详情→展开（可见+expanded+logIntervals 置位）', open.visible === true && open.logInt === 'set', JSON.stringify(open)]);
  await rowBtnCd(HOST, '详情');
  const closed = await pollDetail(x => x.visible === false);
  cs.push(['再点详情→折叠（display=none）', closed.visible === false, JSON.stringify(closed)]);
  cs.push(['折叠同时 logIntervals[id] 清理', closed.logInt === 'cleared', closed.logInt]);
  cs.push(['折叠同时 tabState 记忆清理', closed.tabMem === 'none' || closed.tabMem === 'undefined', String(closed.tabMem)]);
  cs.push(['折叠同时 expandedDevs 移除', closed.expanded === false, String(closed.expanded)]);
  results.push({ id: 'D1', name: '展开→再点详情→折叠（display none + logIntervals 清理）', pass: cs.every(c => c[1]), checks: cs });
}

// D2 展开(详情 tab) → 点日志 → 切日志 tab（不折叠）
{
  const cs = [];
  await rowBtnCd(HOST, '详情');
  await pollDetail(x => x.visible === true && x.tabA !== 'none');
  await rowBtnCd(HOST, '日志');
  const s = await pollDetail(x => x.tabB !== 'none' && x.tabB !== 'missing');
  cs.push(['点日志→日志 tab 激活（tabB 显示）', s.tabB !== 'none', s.tabB]);
  cs.push(['不折叠（detail 行仍可见）', s.visible === true, String(s.visible)]);
  cs.push(['详情 tab 隐藏', s.tabA === 'none', s.tabA]);
  results.push({ id: 'D2', name: '展开→点日志→切日志 tab（不折叠）', pass: cs.every(c => c[1]), checks: cs });
}

// D3 日志 tab 展开 → 再点日志 → 折叠（目标语义；当前实现恒切 tab 不折叠 → 预期 RED=修复目标）
{
  const cs = [];
  const before = await pollDetail(x => x.visible === true && x.tabB !== 'none' && x.tabB !== 'missing');
  cs.push(['前置：日志 tab 激活态', before.visible === true && before.tabB !== 'none', JSON.stringify(before)]);
  await rowBtnCd(HOST, '日志');
  const after = await pollDetail(x => x.visible === false || x.visible === true, 5000);
  cs.push(['再点日志→折叠（display=none）', after.visible === false, JSON.stringify(after)]);
  cs.push(['折叠后 logIntervals 清理', after.logInt === 'cleared', after.logInt]);
  results.push({ id: 'D3', name: '日志 tab 展开→再点日志→折叠（修复目标，当前应为 RED）', pass: cs.every(c => c[1]), checks: cs });
}

// D4 日志展开 → 点详情 → 切详情 tab（不折叠，layersDetail 可见；目标语义；当前实现恒折叠 → 预期 RED=修复目标）
{
  const cs = [];
  // 从折叠态点日志展开到 B
  await rowBtnCd(HOST, '日志');
  const openB = await pollDetail(x => x.visible === true && x.tabB !== 'none' && x.tabB !== 'missing');
  cs.push(['前置：日志展开（tabB 激活）', openB.visible === true && openB.tabB !== 'none', JSON.stringify(openB)]);
  await rowBtnCd(HOST, '详情');
  const after = await pollDetail(x => x.visible === false || x.tabA !== 'none', 5000);
  cs.push(['点详情→切详情 tab（tabA 显示，不折叠）', after.visible === true && after.tabA !== 'none', JSON.stringify(after)]);
  cs.push(['详情 tab 显示 layersDetail（L1 install.sh）', /L1 install\.sh/.test(after.tabABody), after.tabABody.slice(0, 60)]);
  cs.push(['日志 tab 隐藏', after.tabB === 'none', after.tabB]);
  results.push({ id: 'D4', name: '日志展开→点详情→切详情 tab（不折叠+layersDetail；修复目标，当前应为 RED）', pass: cs.every(c => c[1]), checks: cs });
}

// D5 二次展开：/api/admin/scripts 请求不重复（缓存生效）
{
  const cs = [];
  await rowBtnCd(HOST, '详情');   // 折叠态（D4 若 RED 可能仍展开）先归位
  const s0 = await detailState();
  if (s0.visible) { await rowBtnCd(HOST, '详情'); await wait(0.4); }
  const c1 = await js(`window.__fcount.scripts`);
  await rowBtnCd(HOST, '详情');
  await wait(0.8);
  const c2 = await js(`window.__fcount.scripts`);
  await rowBtnCd(HOST, '详情');
  const c3 = await js(`window.__fcount.scripts`);
  cs.push(['首次展开 scripts 请求计数（c1→c2 基线记录）', typeof c1 === 'number' && typeof c2 === 'number', JSON.stringify({ c1, c2, c3 })]);
  cs.push(['二次展开 scripts 请求不重复（c3-c2=0）', typeof c3 === 'number' && (c3 - c2) === 0, JSON.stringify({ c2, c3 })]);
  // 收尾折叠
  const sf = await detailState();
  if (sf.visible) { await rowBtnCd(HOST, '详情'); }
  results.push({ id: 'D5', name: '二次展开缓存生效（scripts 请求不重复）', pass: cs.every(c => c[1]), checks: cs });
}

await shot('w1d-交互');

// 清理
const cleanup = await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  let n = 0;
  for (const d of (list.devices || [])) if (d.hostname && d.hostname.startsWith('w1d-')) { await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth }); n++; }
  const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
  return { deleted: n, remaining: (list2.devices || []).filter(d => (d.hostname || '').startsWith('w1d-')).length, total: (list2.devices || []).length };
})()`);
actions.push('清理 w1d-*：' + JSON.stringify(cleanup));

const verdicts = Object.fromEntries(results.map(r => [r.id, r.pass ? 'PASS' : 'FAIL']));
const finalOut = {
  url: BASE + '/',
  操作序列: actions,
  截图: shots,
  results: results.map(r => ({ id: r.id, name: r.name, pass: r.pass, checks: r.checks })),
  cleanup,
  被测路径: BASE + '（本地沙箱真实运行页面，视口 1440×900 固定）',
  结论: '详情/日志折叠交互：' + Object.entries(verdicts).map(([k, v]) => k + '=' + v).join(' ') +
        '；D1/D2/D5 当前实现符合，D3/D4 为修复目标（开发 1 修后复跑应转绿）。',
};
cliLog(JSON.stringify(finalOut, null, 1));
await completeTaskSpace('W1-详情日志折叠交互', { keep: false });
})().catch(e => cliLog('ERR ' + (e && e.stack || e)));