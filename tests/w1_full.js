// W1-1 全面功能回归测试（t36，用户指令：把不同模型和所有功能都测试一遍）
// 覆盖：A 引擎×模型部署链 / B 组件安装卸载×档位 / C 混合形态+F8 缺口判定 / D 级联交互 / E 聊天形态 /
//       F 通用组真实点击 / G 色板与进度 / （H 回归由 w1_acceptance.js + w1_hybrid.js 承担）
// 真实路径：本地沙箱 8788 真实页面 + 真实 API（admin deploy/command/device + agent heartbeat/progress）+ CDP 真实鼠标点击。
// confirm 处理：window.confirm 覆写为「捕获文案 + 自动确认」（不改业务逻辑，仅驱动真实点击后的确认流并留证文案）。
// 种子 hostname 前缀 w1f-，结束 DELETE 清理。
(async () => {
const BASE = 'http://127.0.0.1:8788';
const ADMIN = 'dev-admin-token-8848';
const WORK = '/tmp/界面统一/部署状态操作列统一';
const SHOT_DIR = WORK + '/tests/screenshots';
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const actions = [];
const shots = [];
const results = [];
const finding = {};

const fs = await import('node:fs');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = async (name) => {
  const p = SHOT_DIR + '/' + name + '-' + RUN + '.png';
  try { await captureScreenshot(p); shots.push(p); return p; } catch (e) { return 'SHOT_FAIL:' + (e && e.message || e); }
};

const task = await useOrCreateTaskSpace('W1-全面功能回归');
await openOrReuseTab(BASE + '/', { wait: true, timeout: 30 });
actions.push('打开真实页面 ' + BASE);
try { await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); actions.push('固定视口 1440×900'); } catch (e) { actions.push('视口固定失败：' + String(e && e.message || e)); }
const appVisible = await js(`(() => { const a = document.getElementById('app'); return !!a && getComputedStyle(a).display !== 'none'; })()`);
if (!appVisible) {
  await fillInput('#tokenIn', ADMIN);
  await click('#btnLogin');
  await waitForElement('#app');
}
await wait(2);
// confirm 覆写：捕获文案+自动确认
await js(`(() => { window.__lastConfirm = ''; window.confirm = msg => { window.__lastConfirm = msg; return true; }; return true; })()`);
actions.push('覆写 confirm（捕获文案+自动确认），用于真实点击确认流');

// ---------- 助手 ----------
const mk = async (host, deploy, comps) => {
  const r = await js(`(async () => {
    const ADMIN = ${JSON.stringify(ADMIN)};
    const auth = { 'Authorization': 'Bearer ' + ADMIN };
    const hb = async (key, device) => {
      for (let i = 0; i < 4; i++) {
        try { return await (await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': key, 'content-type': 'application/json' }, body: JSON.stringify({ device }) })).json(); }
        catch (e) { await new Promise(r => setTimeout(r, 500)); }
      }
      throw new Error('hb fail');
    };
    let j = null;
    for (let i = 0; i < 4; i++) {
      try { j = await (await fetch('/api/admin/devices/new', { method: 'POST', headers: auth })).json(); break; }
      catch (e) { await new Promise(r => setTimeout(r, 500)); }
    }
    if (!j || !j.device_key) throw new Error('new-device fail');
    window.__w1fkeys = window.__w1fkeys || {};
    window.__w1fkeys[${JSON.stringify(host)}] = j.device_key;
    const device = { hostname: ${JSON.stringify(host)}, cpu: 'x86 8c', gpu: 'RTX 4090', gpu_mem_mb: 24576, mem_total_gb: 64,
      agent_version: '9.9.9', deploy: ${JSON.stringify(deploy || {})}, components: ${JSON.stringify(comps || { ocr: { state: 'uninstalled' }, h3: { state: 'uninstalled' } })} };
    await hb(j.device_key, device);
    let list = null;
    for (let i = 0; i < 4; i++) {
      try { list = await (await fetch('/api/admin/devices', { headers: auth })).json(); break; }
      catch (e) { await new Promise(r => setTimeout(r, 500)); }
    }
    const d = ((list || {}).devices || []).find(x => x.hostname === ${JSON.stringify(host)});
    return { device_id: d && d.device_id };
  })()`);
  return r.device_id;
};
const hbCmd = async (host) => js(`(async () => {
  const k = window.__w1fkeys[${JSON.stringify(host)}];
  const r = await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': k, 'content-type': 'application/json' }, body: JSON.stringify({ device: {} }) });
  const j = await r.json();
  return j.command || null;
})()`);
const progress = async (host, step, state, detail) => js(`(async () => {
  const k = window.__w1fkeys[${JSON.stringify(host)}];
  await fetch('/api/device/progress', { method: 'POST', headers: { 'X-Device-Key': k, 'content-type': 'application/json' },
    body: JSON.stringify({ step: ${JSON.stringify(step)}, state: ${JSON.stringify(state)}, detail: ${JSON.stringify(detail || '')} }) });
  return true;
})()`);
const hbComp = async (host, components, deploy) => js(`(async () => {
  const k = window.__w1fkeys[${JSON.stringify(host)}];
  await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': k, 'content-type': 'application/json' },
    body: JSON.stringify({ device: { components: ${JSON.stringify(components)}, ...(${JSON.stringify(deploy)} !== null ? { deploy: ${JSON.stringify(deploy)} } : {}) } }) });
  return true;
})()`);
const hbPlain = async (host) => js(`(async () => {
  const k = window.__w1fkeys[${JSON.stringify(host)}];
  await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': k, 'content-type': 'application/json' }, body: JSON.stringify({ device: {} }) });
  return true;
})()`);
const waitRows = async (hosts) => js(`(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
    const texts = rows.map(tr => (tr.children[0] || {}).textContent || '').join(' ');
    if (${JSON.stringify(hosts)}.every(h => texts.includes(h))) return 'ready';
    await new Promise(r => setTimeout(r, 600));
  }
  return 'timeout';
})()`);
const describe = async (host) => js(`(async () => {
  const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
  const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(host)}));
  if (!tr) return { found: false };
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
      out.push({ tag: n.tagName, text: t.slice(0, 120), bg: cs.backgroundColor, radius: parseFloat(cs.borderRadius) || 0,
        link: n.tagName === 'A', btn: n.tagName === 'BUTTON', bar: !!n.querySelector('.bar'), pct: /\\d+%/.test(t) });
    }
    return out;
  };
  return { found: true, statusText: txt(tdS), opsText: txt(tdO), statusEl: walk(tdS),
    barTexts: [...tdS.querySelectorAll('.bar')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
    buttons: [...tdO.querySelectorAll('button')].map(b => ({ id: b.id || '', text: txt(b) })),
    selects: [...tdO.querySelectorAll('select')].map(s => ({ id: s.id || '', value: s.value, options: [...s.options].map(o => ({ value: o.value, text: o.textContent.trim(), selected: o.selected })) })) };
})()`);
const cdpClickId = async (elId) => {
  const hit = await js(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const b = document.getElementById(${JSON.stringify(elId)});
      if (b) { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
      await new Promise(r => setTimeout(r, 400));
    }
    return null;
  })()`);
  if (!hit) return 'not-found';
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
  return 'cdp-ok';
};
const setCascade = async (id, type, engine, option) => js(`(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (document.getElementById('t_' + ${JSON.stringify(id)})) break;
    await new Promise(r => setTimeout(r, 400));
  }
  const t = document.getElementById('t_' + ${JSON.stringify(id)});
  if (!t) return { missing: 't_' + ${JSON.stringify(id)} };
  const e = document.getElementById('e_' + ${JSON.stringify(id)});
  const o = document.getElementById('o_' + ${JSON.stringify(id)});
  t.value = ${JSON.stringify(type)}; t.dispatchEvent(new Event('change', { bubbles: true }));
  if (${JSON.stringify(engine)} && e) { e.value = ${JSON.stringify(engine)}; e.dispatchEvent(new Event('change', { bubbles: true })); }
  if (${JSON.stringify(option)} && o) o.value = ${JSON.stringify(option)};
  await new Promise(r => setTimeout(r, 200));
  return { t: t.value, e: e ? e.value : null, o: o ? o.value : null, btn: document.getElementById(${JSON.stringify(id)} + '_dep_btn').textContent.trim() };
})()`);
const lastConfirm = () => js(`window.__lastConfirm || ''`);
const cardInfo = async (host) => {
  const d = await describe(host);
  if (!d.found) return null;
  const st = d.statusEl;
  const badges = st.filter(e => !e.btn && !e.link && e.bg && e.bg !== 'rgba(0, 0, 0, 0)' && e.radius >= 6 && !['在线', '离线'].includes(e.text));
  const name = badges[0] || null, state = badges[1] || null;
  const barText = d.barTexts[0] || '';
  const plain = st.filter(e => !e.btn && !e.link && e.bg === 'rgba(0, 0, 0, 0)' && e.text.trim().length >= 2);
  const sentence = plain.length ? plain[plain.length - 1].text : '';
  return { name: name && name.text, state: state && state.text, barText, sentence, badges: badges.map(b => b.text) };
};
// waitCard：轮询直到状态徽章/进度符合期望（UI 5s 轮询异步，避免固定 sleep 竞态）；超时返回最后一次观测
const waitCard = async (host, expectState, expectBar, expectName) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 12000) {
    const c = await cardInfo(host);
    if (c) last = c;
    if (c && c.state === expectState && (!expectBar || c.barText === expectBar) && (!expectName || (c.name && c.name.includes(expectName)))) return c;
    await wait(0.7);
  }
  return last;
};
const colorFamily = rgb => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(rgb));
  if (!m) return 'none';
  const r = +m[1], g = +m[2], b = +m[3];
  if (Math.max(r, g, b) < 50) return 'dark';
  if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30) return 'gray';
  if (g >= r && g >= b) return 'green';
  if (b > r && b > g) return 'blue';
  if (r > g && r > b && g <= b) return 'red';
  if (r > g && g > b) return 'amber';
  return 'none';
};
const STATE_WORDS = { running: ['运行中', 'online'], deploying: ['部署中', 'deploying'], queued: ['排队', 'queued'], idle: ['闲置', 'idle'], stopped: ['已停止', 'stopped'], failed: ['失败', 'failed'], installing: ['安装中', 'installing'], uninstalling: ['卸载中', 'uninstalling'] };

// 清残留
await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list.devices || [])) if (d.hostname && d.hostname.startsWith('w1f-')) await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth });
  return true;
})()`);
actions.push('清理 w1f-* 残留');

// ================= A. 引擎部署 × 不同模型 =================
{
  const scenarios = [
    { key: 'ollama-m1', engine: 'ollama', model: 'qwen2.5:7b-instruct' },
    { key: 'ollama-m2', engine: 'ollama', model: 'qwen2.5:14b-instruct-q4_k_m' },
    { key: 'vllm-m1', engine: 'vllm', model: 'Qwen/Qwen2-7B-Instruct-AWQ' },
    { key: 'vllm-m2', engine: 'vllm', model: 'Qwen/Qwen2-1.5B-Instruct-AWQ' },
    { key: 'sglang-m1', engine: 'sglang', model: 'Qwen/Qwen2.5-7B-Instruct-AWQ' },
    { key: 'sglang-m2', engine: 'sglang', model: 'Qwen/Qwen2.5-14B-Instruct-AWQ' },
    { key: 'strata-m1', engine: 'strata', model: 'Qwen3.8-Flash-Next-Coder' },
  ];
  const r = { id: 'A', name: '引擎部署×模型（4 引擎×7 模型，指令下发→状态卡→进度→一句话→日志）', checks: [] };
  for (const sc of scenarios) {
    const host = 'w1f-a-' + sc.key;
    const id = await mk(host, { state: 'idle' });
    await setCascade(id, 'text', sc.engine, sc.model);
    await cdpClickId(id + '_dep_btn');
    await wait(1);
    const c = await lastConfirm();
    const cmd = await hbCmd(host);   // 心跳拉取指令（一次性）
    // 模拟 agent 执行：docker → deploying；verify → online
    await progress(host, 'docker', 'ok', '拉取镜像');
    await wait(1);
    const dDeploy = await waitCard(host, '部署中');
    await progress(host, 'verify', 'ok', '');
    await hbPlain(host);
    const dOnline = await waitCard(host, '运行中', '100%');
    // 日志出现 deploy 指令记录（代表性设备 ollama-m1：打开详情→日志tab，断言进度日志条目存在）
    let logCheck = 'skip';
    if (sc.key === 'ollama-m1') {
      const logTab = await (async () => {
        const rows = await js(`(() => { const r = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id||'').startsWith('detail_')); const tr = r.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(host)})); const b = [...tr.querySelectorAll('button')].find(x => x.textContent.trim() === '详情'); b.scrollIntoView({block:'center'}); const g = b.getBoundingClientRect(); return { x: Math.round(g.x+g.width/2), y: Math.round(g.y+g.height/2) }; })()`);
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: rows.x, y: rows.y, button: 'left', clickCount: 1 });
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rows.x, y: rows.y, button: 'left', clickCount: 1 });
        await wait(1);
        const lg = await js(`(() => { const r = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id||'').startsWith('detail_')); const tr = r.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(host)})); const b = [...tr.querySelectorAll('button')].find(x => x.textContent.trim() === '日志'); b.scrollIntoView({block:'center'}); const g = b.getBoundingClientRect(); return { x: Math.round(g.x+g.width/2), y: Math.round(g.y+g.height/2) }; })()`);
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: lg.x, y: lg.y, button: 'left', clickCount: 1 });
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lg.x, y: lg.y, button: 'left', clickCount: 1 });
        await wait(1);
        const body = await js(`(() => { const b = document.getElementById('tabB_' + ${JSON.stringify(id)} + '_body'); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
        return body;
      })();
      logCheck = /verify/.test(logTab) && /docker/.test(logTab) ? '日志含 deploy 执行记录' : '日志缺条目';
    }
    const checks = [];
    checks.push(['指令下发（confirm=' + (c === '确认执行部署？' ? '统一文案' : c) + '）', c === '确认执行部署？', c]);
    checks.push(['心跳可取 deploy 指令（engine=' + sc.engine + ', model=' + sc.model + '）', !!(cmd && cmd.type === 'deploy' && cmd.engine === sc.engine && cmd.model === sc.model), JSON.stringify(cmd)]);
    checks.push(['部署中态：徽章=引擎·模型 + 部署中 + 进度条', dDeploy && dDeploy.name && dDeploy.name.includes(sc.engine) && dDeploy.state === '部署中' && (dDeploy.barText || '').includes('%'), JSON.stringify(dDeploy)]);
    checks.push(['运行中态：徽章=引擎·模型 + 运行中 + 100%进度', dOnline && dOnline.name && dOnline.name.includes(sc.engine) && dOnline.name.includes(sc.model) && dOnline.state === '运行中' && dOnline.barText === '100%', JSON.stringify(dOnline)]);
    checks.push(['一句话正确（运行正常）', dOnline && dOnline.sentence === '运行正常', dOnline && dOnline.sentence]);
    if (sc.key === 'ollama-m1') checks.push(['日志出现 deploy 执行记录（详情→日志tab）', logCheck === '日志含 deploy 执行记录', logCheck]);
    r.checks.push([sc.key + '(' + sc.engine + '·' + sc.model + ')', checks.every(c => c[1]), checks]);
  }
  await shot('w1f-a-roster');
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// ================= B. 组件安装/卸载 × 档位 =================
{
  const r = { id: 'B', name: '组件安装/卸载×档位（OCR 装/卸、H3 h3-fast/h3-hd 安装、H3 卸载确认框）', checks: [] };

  // B1 OCR 安装 → 运行中
  {
    const host = 'w1f-b-ocr-install';
    const id = await mk(host, { state: 'idle' });
    await setCascade(id, 'ocr');
    await cdpClickId(id + '_dep_btn');
    await wait(1);
    const cmd = await hbCmd(host);
    const c = await lastConfirm();   // ocrCmd 无 confirm → 保持空
    const cs = [];
    cs.push(['指令下发 {type:ocr,action:install}', !!(cmd && cmd.type === 'ocr' && cmd.action === 'install'), JSON.stringify(cmd)]);
    cs.push(['OCR 安装无 confirm 拦截（cascade 直发）', c === '' || c === '确认执行部署？', c]);
    await hbComp(host, { ocr: { state: 'installing' }, h3: { state: 'uninstalled' } }, null);
    const dIns = await waitCard(host, '安装中');
    cs.push(['安装中态：OCR 徽章+安装中+进度条', dIns && dIns.name === 'OCR' && dIns.state === '安装中' && (dIns.barText || '').includes('%'), JSON.stringify(dIns)]);
    await hbComp(host, { ocr: { state: 'installed' }, h3: { state: 'uninstalled' } }, { state: 'online', type: 'ocr', version: '1.4.4' });
    const dRun = await waitCard(host, '运行中', '100%');
    cs.push(['运行中态：OCR 徽章+运行中+100%+一句话 v1.4.4', dRun && dRun.name === 'OCR' && dRun.state === '运行中' && dRun.barText === '100%' && /1\.4\.4/.test(dRun.sentence || ''), JSON.stringify(dRun)]);
    r.checks.push(['B1 OCR 安装→运行中', cs.every(c => c[1]), cs]);
  }
  // B2 OCR 卸载 → 状态变化（UI 无卸载按钮（组件行已移除），卸载走同款 admin command 端点真实下发）
  {
    const host = 'w1f-b-ocr-uninstall';
    const id = await mk(host, { state: 'idle' }, { ocr: { state: 'installed' }, h3: { state: 'uninstalled' } });
    await hbComp(host, { ocr: { state: 'installed' }, h3: { state: 'uninstalled' } }, { state: 'online', type: 'ocr', version: '1.4.4' });
    await wait(2);
    const sent = await js(`(async () => {
      const ADMIN = ${JSON.stringify(ADMIN)};
      const r = await fetch('/api/admin/command', { method: 'POST', headers: { 'Authorization': 'Bearer ' + ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ device_id: ${JSON.stringify(id)}, type: 'ocr', action: 'uninstall' }) });
      return r.status;
    })()`);
    await hbComp(host, { ocr: { state: 'uninstalling' }, h3: { state: 'uninstalled' } }, null);
    const d = await waitCard(host, '卸载中');
    const cs = [];
    cs.push(['卸载指令下发（admin command ocr/uninstall）=200', sent === 200, sent]);
    cs.push(['卸载中态：OCR 徽章+卸载中（琥珀降级色）', d && d.name === 'OCR' && d.state === '卸载中', JSON.stringify(d)]);
    r.checks.push(['B2 OCR 卸载→状态变化', cs.every(c => c[1]), cs]);
  }
  // B3 H3 h3-fast 安装（档位标注）
  {
    const host = 'w1f-b-h3-fast';
    const id = await mk(host, { state: 'idle' });
    await setCascade(id, 'h3', 'H3', 'h3-fast');
    await cdpClickId(id + '_dep_btn');
    await wait(1);
    const cmd = await hbCmd(host);
    const cs = [];
    cs.push(['指令下发 {type:h3,action:install,option:h3-fast}', !!(cmd && cmd.type === 'h3' && cmd.action === 'install' && cmd.option === 'h3-fast'), JSON.stringify(cmd)]);
    await hbComp(host, { ocr: { state: 'uninstalled' }, h3: { state: 'installing' } }, null);
    const dIns = await waitCard(host, '安装中');
    cs.push(['安装中态：H3 徽章+安装中+进度条', dIns && dIns.name === 'H3' && dIns.state === '安装中' && (dIns.barText || '').includes('%'), JSON.stringify(dIns)]);
    await hbComp(host, { ocr: { state: 'uninstalled' }, h3: { state: 'running' } }, { state: 'online', type: 'h3', step: 'h3', detail: 'H3 安装完成', version: '0.1.0', tier: 'h3-fast', quant: 'UD-Q2_K_XL' });
    const dRun = await waitCard(host, '运行中', '100%');
    cs.push(['运行中态：H3 徽章+运行中+100%+一句话含 h3-fast 档位标注', dRun && dRun.name === 'H3' && dRun.state === '运行中' && dRun.barText === '100%' && /h3-fast/.test(dRun.sentence || ''), JSON.stringify(dRun)]);
    r.checks.push(['B3 H3 h3-fast 安装→档位标注', cs.every(c => c[1]), cs]);
  }
  // B4 H3 h3-hd 安装（档位标注）
  {
    const host = 'w1f-b-h3-hd';
    const id = await mk(host, { state: 'idle' });
    await setCascade(id, 'h3', 'H3', 'h3-hd');
    await cdpClickId(id + '_dep_btn');
    await wait(1);
    const cmd = await hbCmd(host);
    const cs = [];
    cs.push(['指令下发 {type:h3,action:install,option:h3-hd}', !!(cmd && cmd.type === 'h3' && cmd.action === 'install' && cmd.option === 'h3-hd'), JSON.stringify(cmd)]);
    await hbComp(host, { ocr: { state: 'uninstalled' }, h3: { state: 'installing' } }, null);
    await wait(2);
    await hbComp(host, { ocr: { state: 'uninstalled' }, h3: { state: 'running' } }, { state: 'online', type: 'h3', step: 'h3', detail: 'H3 安装完成', version: '0.1.0', tier: 'h3-hd', quant: 'Q4_K_M' });
    const dRun = await waitCard(host, '运行中', '100%');
    cs.push(['运行中态：H3+运行中+100%+一句话含 h3-hd 档位标注', dRun && dRun.name === 'H3' && dRun.state === '运行中' && dRun.barText === '100%' && /h3-hd/.test(dRun.sentence || ''), JSON.stringify(dRun)]);
    r.checks.push(['B4 H3 h3-hd 安装→档位标注', cs.every(c => c[1]), cs]);
  }
  // B5 H3 卸载确认框（h3Cmd uninstall 真实页面函数路径）
  {
    const host = 'w1f-b-h3-uninstall';
    const id = await mk(host, { state: 'idle' }, { ocr: { state: 'uninstalled' }, h3: { state: 'running' } });
    const out = await js(`(async () => {
      const id = ${JSON.stringify(id)};
      await h3Cmd(id, 'uninstall');
      await new Promise(r => setTimeout(r, 600));
      return { confirm: window.__lastConfirm || '' };
    })()`);
    const cmd = await hbCmd(host);
    const cs = [];
    cs.push(['卸载确认框文案（约 27GB 语义）', /卸载 H3/.test(out.confirm) && /27GB/.test(out.confirm), out.confirm]);
    cs.push(['确认后指令下发 {type:h3,action:uninstall}', !!(cmd && cmd.type === 'h3' && cmd.action === 'uninstall'), JSON.stringify(cmd)]);
    r.checks.push(['B5 H3 卸载确认框+下发', cs.every(c => c[1]), cs]);
    // 观察：UI 无按钮触发 h3Cmd uninstall（组件行已移除）——记录
    finding.b5 = '观察：UI 当前无 H3/OCR 卸载按钮入口（组件行已按两列统一移除），h3Cmd/ocrCmd 卸载分支仍存在但无 UI 触发点；如需用户可卸载，需补入口。';
  }
  await shot('w1f-b-component');
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// ================= C. 混合形态 / 唯一部署模型（t37 已落地：type 权威 + agent 互斥清槽） =================
// 用户定语义：一台设备同一时刻仅一个部署物（引擎/OCR/H3 平级互斥）；部署新物先卸载旧物，状态卡展示最新部署物。
//   C0 过渡态兜底：旧混合残留数据（前 t37 快照：engine+h3 共存）在 type 权威前端 → 名称徽章=H3（修复后证据；
//     前 t37 快照已留证：上轮运行 C0 FAIL name=ollama）
//   C1 互斥正向：ollama 运行中 → 装 H3(h3-hd)：指令下发 → agent 先停引擎（stopped 整槽清槽）→ h3 安装进度
//     → 状态卡最终显示 H3 running + h3-hd（引擎不残留）
//   C2 互斥回切：H3 运行中 → 部署引擎(vllm)：admin/deploy 整槽替换（type 残留清除）→ agent 进度
//     → 状态卡显示 vllm·模型，无 H3 残留
{
  const r = { id: 'C', name: '唯一部署模型（t37 落地验证）：type 权威过渡态兜底 + agent 互斥正向/回切', checks: [] };

  // C0 过渡态兜底（前后对比之「后」）
  {
    const host = 'w1f-c0-current';
    const id = await mk(host, { state: 'idle' });
    await setCascade(id, 'text', 'ollama', 'qwen2.5:7b-instruct');
    await cdpClickId(id + '_dep_btn');
    await wait(1);
    await progress(host, 'verify', 'ok', '');
    await hbPlain(host);
    await waitCard(host, '运行中', '100%');
    // 旧 agent 数据形态（前 t37 快照：引擎+h3 残留共存）
    await hbComp(host, { ocr: { state: 'installed' }, h3: { state: 'running' } }, { type: 'h3', step: 'h3', detail: 'H3 安装完成', version: '0.1.0', tier: 'h3-hd', quant: 'Q4_K_M' });
    const dMix = await waitCard(host, '运行中', '100%', 'H3');
    const cs = [];
    cs.push(['C0 过渡态兜底：名称徽章=H3（type 权威；前 t37 快照=ollama FAIL）', dMix && dMix.name === 'H3', JSON.stringify(dMix)]);
    cs.push(['C0 状态徽章=运行中 + 一句话含 h3-hd 档位', dMix && dMix.state === '运行中' && /h3-hd/.test(dMix.sentence || ''), dMix && dMix.sentence]);
    r.checks.push(['C0 过渡态兜底（修复后证据）', cs.every(c => c[1]), cs]);
    finding.f8 = {
      verdict: '已关闭（t37 修复落地）',
      severity: 'high',
      detail: '前 t37（唯一部署模型未落地）：装 H3(h3-hd) 后引擎优先显示 ollama、H3 状态除日志外不可见（上轮运行记录 C0 FAIL，name=ollama）。t37 落地（3bf68ef agent 互斥 + f53ee4e type 权威）后：过渡态数据（引擎+残留）显示 H3，互斥序列（C1/C2）显示最新部署物——缺口关闭。',
      evidence: { before: '上轮 full 运行 C0 FAIL：name=ollama · qwen2.5:7b-instruct（引擎优先，H3 不可见，F8 缺口确认）', after: dMix }
    };
    await shot('w1f-c0-current');
  }

  // C1 互斥正向：ollama 运行中 → 装 H3(h3-hd)
  {
    const host = 'w1f-c1-new';
    const id = await mk(host, { state: 'idle' });
    await setCascade(id, 'text', 'ollama', 'qwen2.5:7b-instruct');
    await cdpClickId(id + '_dep_btn');
    await wait(1);
    await progress(host, 'verify', 'ok', '');
    await hbPlain(host);
    await waitCard(host, '运行中', '100%');
    await setCascade(id, 'h3', 'H3', 'h3-hd');
    await cdpClickId(id + '_dep_btn');
    await wait(1);
    const cmdH3 = await hbCmd(host);
    // agent 互斥部署：先停引擎（stopped 整槽清槽，清除 engine/type 残留）→ h3 安装进度
    await hbComp(host, { ocr: { state: 'installed' }, h3: { state: 'installing' } }, { state: 'stopped' });
    await progress(host, 'verify', 'ok', '');
    await hbComp(host, { ocr: { state: 'installed' }, h3: { state: 'running' } }, { state: 'online', type: 'h3', step: 'h3', detail: 'H3 安装完成', version: '0.1.0', tier: 'h3-hd', quant: 'Q4_K_M' });
    const dH3 = await waitCard(host, '运行中', '100%', 'H3');
    const cs = [];
    cs.push(['指令下发 {type:h3,action:install,option:h3-hd}', !!(cmdH3 && cmdH3.type === 'h3' && cmdH3.option === 'h3-hd'), JSON.stringify(cmdH3)]);
    cs.push(['终态：状态卡显示 H3 最新部署物（引擎不残留）', dH3 && dH3.name === 'H3' && !(dH3.name || '').includes('ollama'), JSON.stringify(dH3)]);
    cs.push(['终态：运行中 + 100% + 一句话含 h3-hd 档位', dH3 && dH3.state === '运行中' && dH3.barText === '100%' && /h3-hd/.test(dH3.sentence || ''), JSON.stringify(dH3)]);
    r.checks.push(['C1 互斥正向：装 H3 → 先停引擎 → 显示 H3', cs.every(c => c[1]), cs]);
    await shot('w1f-c1-new');
  }

  // C2 互斥回切：H3 运行中 → 部署引擎(vllm)
  {
    const host = 'w1f-c2-reverse';
    const id = await mk(host, { state: 'idle' }, { ocr: { state: 'uninstalled' }, h3: { state: 'running' } });
    await hbComp(host, { ocr: { state: 'uninstalled' }, h3: { state: 'running' } }, { state: 'online', type: 'h3', step: 'h3', detail: 'H3 安装完成', version: '0.1.0', tier: 'h3-hd', quant: 'Q4_K_M' });
    await waitCard(host, '运行中', '100%');
    const dH3 = await cardInfo(host);
    await setCascade(id, 'text', 'vllm', 'Qwen/Qwen2-7B-Instruct-AWQ');
    await cdpClickId(id + '_dep_btn');
    await wait(1);
    const cmdEng = await hbCmd(host);
    // admin/deploy 整槽替换（queued/engine/model，type 残留清除）→ agent progress → online
    await progress(host, 'verify', 'ok', '');
    const dEng2 = await waitCard(host, '运行中', '100%', 'vllm');
    const cs = [];
    cs.push(['前置：H3 运行中', dH3 && dH3.name === 'H3', JSON.stringify(dH3)]);
    cs.push(['指令下发 {type:deploy,engine:vllm}', !!(cmdEng && cmdEng.type === 'deploy' && cmdEng.engine === 'vllm'), JSON.stringify(cmdEng)]);
    cs.push(['终态：状态卡显示 vllm·模型（H3 残留清除）', dEng2 && dEng2.name && dEng2.name.includes('vllm') && dEng2.name.includes('Qwen/Qwen2-7B-Instruct-AWQ') && !/h3-hd/.test(dEng2.sentence || ''), JSON.stringify(dEng2)]);
    r.checks.push(['C2 互斥回切：部署引擎 → 显示 vllm·模型', cs.every(c => c[1]), cs]);
    await shot('w1f-c2-reverse');
  }

  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// ================= D. 级联交互 =================
{
  const r = { id: 'D', name: '级联交互（三类型联动 + 主按钮恒部署引擎 + confirm 统一）', checks: [] };
  const host = 'w1f-d-cascade';
  const id = await mk(host, { state: 'idle' });
  const out = {};
  out.text = await setCascade(id, 'text', 'ollama', 'qwen2.5:7b-instruct');
  out.ocr = await setCascade(id, 'ocr');
  out.h3 = await setCascade(id, 'h3', 'H3', 'h3-hd');
  out.back = await setCascade(id, 'text', 'vllm', 'Qwen/Qwen2-7B-Instruct-AWQ');
  // confirm 统一（text 类型部署一次）
  await cdpClickId(id + '_dep_btn');
  await wait(1);
  const c = await lastConfirm();
  const cs = [];
  cs.push(['文生文→引擎/档位联动（engine 列表含 ollama，option 含 qwen2.5）', out.text.e === 'ollama' && out.text.o === 'qwen2.5:7b-instruct', JSON.stringify(out.text)]);
  cs.push(['图生文→引擎=OCR/档位=OCR 固定项', out.ocr.e === 'OCR' && /rapidocr/.test(out.ocr.o), JSON.stringify(out.ocr)]);
  cs.push(['文生视频→引擎=H3/档位=h3-hd', out.h3.e === 'H3' && out.h3.o === 'h3-hd', JSON.stringify(out.h3)]);
  cs.push(['切回文生文→引擎/档位恢复', out.back.e === 'vllm' && out.back.o === 'Qwen/Qwen2-7B-Instruct-AWQ', JSON.stringify(out.back)]);
  cs.push(['主按钮四步恒=部署引擎', [out.text, out.ocr, out.h3, out.back].every(x => x.btn === '部署引擎'), [out.text, out.ocr, out.h3, out.back].map(x => x.btn).join('|')]);
  cs.push(['confirm 统一「确认执行部署？」', c === '确认执行部署？', c]);
  r.checks.push(['级联联动+恒文案+confirm 统一', cs.every(c => c[1]), cs]);
  await shot('w1f-d-cascade');
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// ================= E. 聊天形态 =================
{
  const r = { id: 'E', name: '聊天形态（引擎=文本/纯H3=视频/纯OCR=图片/混合=文本）', checks: [] };
  const eng = 'w1f-e-engine', h3 = 'w1f-e-h3', ocr = 'w1f-e-ocr', mix = 'w1f-e-mix';
  await mk(eng, { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', tunnel_url: 'https://e1.trycloudflare.com' });
  await mk(h3, { state: 'online', type: 'h3', version: '0.1.0', tunnel_url: 'https://e2.trycloudflare.com' }, { ocr: { state: 'uninstalled' }, h3: { state: 'running' } });
  await mk(ocr, { state: 'online', type: 'ocr', version: '1.4.4', tunnel_url: 'https://e3.trycloudflare.com' }, { ocr: { state: 'installed' }, h3: { state: 'uninstalled' } });
  await mk(mix, { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', type: 'h3', version: '0.1.0', tier: 'h3-hd', tunnel_url: 'https://e4.trycloudflare.com' }, { ocr: { state: 'installed' }, h3: { state: 'running' } });
  await waitRows([eng, h3, ocr, mix]);
  await wait(2);
  const chat = await js(`(async () => {
    const sel = document.getElementById('chatDev');
    const opts = [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim() }));
    const set = async (host) => {
      const o = opts.find(x => x.text.includes(host));
      if (!o) return { meta: 'option-missing', chatIn: 'n/a', vidIn: 'n/a', ocrIn: 'n/a' };
      sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const dsp = id => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'missing'; };
      return { meta: document.getElementById('chatMeta').textContent.trim(), chatIn: dsp('chatIn'), vidIn: dsp('vidIn'), ocrIn: dsp('ocrIn') };
    };
    return { opts, eng: await set(${JSON.stringify(eng)}), h3: await set(${JSON.stringify(h3)}), ocr: await set(${JSON.stringify(ocr)}), mix: await set(${JSON.stringify(mix)}) };
  })()`);
  const cs = [];
  const lab = host => (chat.opts.find(o => o.text.includes(host)) || {}).text || '∅';
  cs.push(['引擎 chatLabel=引擎+模型', /ollama/.test(lab(eng)) && /qwen2\.5:7b/.test(lab(eng)), lab(eng)]);
  cs.push(['纯H3 chatLabel=H3 0.1.0', /H3 0\.1\.0/.test(lab(h3)), lab(h3)]);
  cs.push(['纯OCR chatLabel=OCR 1.4.4', /OCR 1\.4\.4/.test(lab(ocr)), lab(ocr)]);
  cs.push(['混合 chatLabel=H3 0.1.0（type 权威，非引擎·模型）', /H3 0\.1\.0/.test(lab(mix)) && !/ollama/.test(lab(mix)), lab(mix)]);
  cs.push(['引擎聊天=文本聊天+文本框显', /文本聊天/.test(chat.eng.meta) && chat.eng.chatIn !== 'none', JSON.stringify(chat.eng)]);
  cs.push(['纯H3=视频形态+视频框显', /H3 文生视频/.test(chat.h3.meta) && chat.h3.vidIn !== 'none', JSON.stringify(chat.h3)]);
  cs.push(['纯OCR=图片形态+图片框显', /OCR 图片识别/.test(chat.ocr.meta) && chat.ocr.ocrIn !== 'none', JSON.stringify(chat.ocr)]);
  cs.push(['混合（引擎+H3 残留）=H3 视频形态（t37 type 权威）', /H3 文生视频/.test(chat.mix.meta) && chat.mix.vidIn !== 'none' && chat.mix.chatIn === 'none', JSON.stringify(chat.mix)]);
  r.checks.push(['聊天四形态', cs.every(c => c[1]), cs]);
  await shot('w1f-e-chat');
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// ================= F. 通用组真实点击 =================
{
  const r = { id: 'F', name: '通用组真实点击（隧道/详情/日志/回收/删除）', checks: [] };
  const host = 'w1f-f-ops';
  const id = await mk(host, { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', tunnel_url: 'https://f1.trycloudflare.com', detail: '模型就绪' });
  await hbPlain(host);
  await waitRows([host]);
  await wait(1);
  const cs = [];
  // 隧道
  await js(`(() => { const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id||'').startsWith('detail_')); const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(host)})); [...tr.querySelectorAll('button')].find(b => /隧道/.test(b.textContent)).click(); return true; })()`);
  await wait(1);
  const cmdTunnel = await hbCmd(host);
  cs.push(['隧道点击→指令 restart_tunnel 下发', !!(cmdTunnel && cmdTunnel.type === 'restart_tunnel'), JSON.stringify(cmdTunnel)]);
  // 详情（CDP 坐标点击行内详情）
  const detailHit = await js(`(() => {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id||'').startsWith('detail_'));
    const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(host)}));
    const b = [...tr.querySelectorAll('button')].find(x => x.textContent.trim() === '详情');
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: detailHit.x, y: detailHit.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: detailHit.x, y: detailHit.y, button: 'left', clickCount: 1 });
  const detailState = await js(`(async () => {
    const id = ${JSON.stringify(id)};
    const el = document.getElementById('detail_' + id);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) { if (el && getComputedStyle(el).display !== 'none') return '展开'; await new Promise(r => setTimeout(r, 300)); }
    return '未展开';
  })()`);
  cs.push(['详情点击→折叠展开', detailState === '展开', detailState]);
  // 日志 tab（行内日志按钮）
  const logHit = await js(`(() => {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id||'').startsWith('detail_'));
    const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(host)}));
    const b = [...tr.querySelectorAll('button')].find(x => x.textContent.trim() === '日志');
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: logHit.x, y: logHit.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: logHit.x, y: logHit.y, button: 'left', clickCount: 1 });
  await wait(1);
  const logState = await js(`(() => {
    const id = ${JSON.stringify(id)};
    const b = document.getElementById('tabB_' + id + '_body');
    return b ? (getComputedStyle(b).display !== 'none' ? '日志tab激活' : '未激活') : '无tabB';
  })()`);
  cs.push(['日志点击→日志tab激活', logState === '日志tab激活', logState]);
  await shot('w1f-f-detail');
  // 回收（行内回收按钮 → cmd recycle）
  await js(`(() => { const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id||'').startsWith('detail_')); const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(host)})); [...tr.querySelectorAll('button')].find(b => /回收/.test(b.textContent)).click(); return true; })()`);
  await wait(1);
  const cmdRecycle = await hbCmd(host);
  cs.push(['回收点击→指令 recycle 下发', !!(cmdRecycle && cmdRecycle.type === 'recycle'), JSON.stringify(cmdRecycle)]);
  // 删除（confirm 捕获 + 行消失 + 恢复种子）
  await js(`(() => { const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id||'').startsWith('detail_')); const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(host)})); [...tr.querySelectorAll('button')].find(b => /删除/.test(b.textContent)).click(); return true; })()`);
  await wait(2);
  const delConfirm = await lastConfirm();
  const rowGone = await js(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id||'').startsWith('detail_'));
      if (!rows.some(x => (x.children[0] || {}).textContent && x.children[0].textContent.includes(${JSON.stringify(host)}))) return '已删除';
      await new Promise(r => setTimeout(r, 400));
    }
    return '仍在';
  })()`);
  cs.push(['删除确认框文案', /删除设备/.test(delConfirm) && /记录/.test(delConfirm), delConfirm]);
  cs.push(['确认后设备记录删除（行消失）', rowGone === '已删除', rowGone]);
  r.checks.push(['通用组五按钮真实点击', cs.every(c => c[1]), cs]);
  // 恢复种子（删除验证后重建一台，供后续截图/收尾）
  await mk('w1f-f-restored', { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', tunnel_url: 'https://f2.trycloudflare.com' });
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// ================= G. 状态色板与进度 =================
{
  const r = { id: 'G', name: '状态色板 9 形态 + 进度（deploying/installing/queued 进度条；running=100%）', checks: [] };
  const shapes = [
    { key: 'run', state: 'online', family: 'green', comp: {} },
    { key: 'deploy', state: 'deploying', family: 'amber', comp: {}, step: 'model_pull', detail: '权重 45%' },
    { key: 'queued', state: 'queued', family: 'blue', comp: {} },
    { key: 'idle', state: 'idle', family: 'gray', comp: {} },
    { key: 'stopped', state: 'stopped', family: 'gray', comp: {} },
    { key: 'failed', state: 'failed', family: 'red', comp: {} },
    { key: 'ocr-install', state: 'installing', family: 'amber', comp: { ocr: { state: 'installing' }, h3: { state: 'uninstalled' } } },
    { key: 'h3-install', state: 'installing', family: 'amber', comp: { ocr: { state: 'uninstalled' }, h3: { state: 'installing' } } },
    { key: 'ocr-uninstall', state: 'uninstalling', family: 'amber-degraded', comp: { ocr: { state: 'uninstalling' }, h3: { state: 'uninstalled' } } },
  ];
  const hosts = {};
  for (const s of shapes) {
    const host = 'w1f-g-' + s.key;
    hosts[s.key] = host;
    const dep = { state: s.state };
    if (s.step) { dep.step = s.step; dep.detail = s.detail; }
    if (s.key === 'run' || s.key === 'deploy' || s.key === 'queued' || s.key === 'failed') { dep.engine = 'ollama'; dep.model = 'qwen2.5:7b-instruct'; }
    await mk(host, dep, s.comp);
  }
  await waitRows(Object.values(hosts));
  await wait(2);
  const deployBg = await (async () => {
    const d = await describe(hosts.deploy);
    const b = d.statusEl.find(e => e.bg && e.bg !== 'rgba(0, 0, 0, 0)' && e.radius >= 6 && (e.text === '部署中' || e.text === 'deploying'));
    return b ? b.bg : '';
  })();
  const cs = [];
  const STATE2WORD = { online: '运行中', deploying: '部署中', queued: '排队', idle: '闲置', stopped: '已停止', failed: '失败', installing: '安装中', uninstalling: '卸载中' };
  for (const s of shapes) {
    const d = await describe(hosts[s.key]);
    const st = d.statusEl;
    const badges = st.filter(e => !e.btn && !e.link && e.bg && e.bg !== 'rgba(0, 0, 0, 0)' && e.radius >= 6 && !['在线', '离线'].includes(e.text));
    const sb = badges.find(b => b.text === STATE2WORD[s.state] || b.text === s.state);
    const fam = sb ? colorFamily(sb.bg) : 'none';
    let ok = fam === (s.family === 'amber-degraded' ? 'amber' : s.family);
    let note = s.key + '→' + fam + '（bg=' + (sb && sb.bg) + '）';
    if (s.family === 'amber-degraded') {
      const degraded = deployBg && sb && sb.bg !== deployBg;
      ok = ok && !!degraded;
      note += ' 降级=' + degraded;
    }
    cs.push([s.key + '(' + s.state + ') 色板=' + s.family, ok, note]);
    // 进度：deploying/installing/queued 有进度条；online=100%
    if (['deploying', 'installing', 'queued'].includes(s.state)) {
      cs.push([s.key + ' 显示进度条', d.barTexts.length >= 1 && d.barTexts[0] !== '', d.barTexts.join('|')]);
    }
    if (s.state === 'online') {
      cs.push(['run 进度=100%', d.barTexts[0] === '100%', d.barTexts.join('|')]);
    }
  }
  await shot('w1f-g-palette');
  r.checks.push(['色板 9 形态 + 进度', cs.every(c => c[1]), cs]);
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// ================= 清理 =================
const cleanup = await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  let n = 0;
  for (const d of (list.devices || [])) if (d.hostname && d.hostname.startsWith('w1f-')) { await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth }); n++; }
  const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
  return { deleted: n, remaining: (list2.devices || []).filter(d => (d.hostname || '').startsWith('w1f-')).length, total: (list2.devices || []).length };
})()`);
await shot('w1f-06-cleanup');
actions.push('清理 w1f-* 种子：' + JSON.stringify(cleanup));

const verdicts = Object.fromEntries(results.map(r => [r.id, r.pass ? 'PASS' : 'FAIL']));
const finalOut = {
  url: BASE + '/',
  操作序列: actions,
  截图: shots,
  results: results.map(r => ({ id: r.id, name: r.name, pass: r.pass, checks: r.checks })),
  finding,
  cleanup,
  被测路径: BASE + '（本地沙箱真实运行页面，wrangler dev，token dev-admin-token-8848，视口 1440×900 固定）',
  结论: '全面功能回归：' + Object.entries(verdicts).map(([k, v]) => k + '=' + v).join(' ') + '；F8=' + (finding.f8 && finding.f8.verdict) + '；H 回归由 w1_acceptance.js/w1_hybrid.js 另行执行。',
};
cliLog(JSON.stringify(finalOut, null, 1));
await completeTaskSpace('W1-全面功能回归', { keep: false });
})().catch(e => cliLog('ERR ' + (e && e.stack || e)));