// W1-1 验收断言套件（t2「两列统一」门禁）
// 覆盖验收点：A1 状态卡四要素结构 / A2 操作列三段 / A3 状态色板 / A4 OCR·H3 显进度 / A5 组件行+死代码 / A6 无注释式文案
// red phase（当前基线）运行预期多例失败；t2 实现后应全绿。
// 输出：{ url, 操作序列, 截图, results, 被测路径, 结论 }（cliLog）
(async () => {
const BASE = 'http://127.0.0.1:8788';
const ADMIN = 'dev-admin-token-8848';
const WORK = '/tmp/界面统一/部署状态操作列统一';
const SHOT_DIR = WORK + '/tests/screenshots';
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);   // 每次运行唯一，截图不互相覆盖
const actions = [];
const shots = [];

const fs = await import('node:fs');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = async (name) => {
  const p = SHOT_DIR + '/' + name + '-' + RUN + '.png';
  try { await captureScreenshot(p); shots.push(p); return p; } catch (e) { return 'SHOT_FAIL:' + (e && e.message || e); }
};

// ---------- 种子场景 ----------
const scenarios = [
  { key: 'run',     host: 'w1-运行中',   state: 'running',      family: 'green',  name: 'ollama', needProg: true,
    deploy: { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', version: '0.5.3', step: 'verify', step_state: 'ok', detail: '', tunnel_url: 'https://seed.trycloudflare.com' } },
  { key: 'deploy',  host: 'w1-部署中',   state: 'deploying',    family: 'amber',  name: 'vllm', needProg: true,
    deploy: { state: 'deploying', engine: 'vllm', step: 'model_pull', step_state: 'ok', detail: '模型权重拉取 45%' } },
  { key: 'queued',  host: 'w1-排队',     state: 'queued',       family: 'blue',   name: 'ollama', needProg: true,
    deploy: { state: 'queued', engine: 'ollama', model: 'qwen2.5:7b-instruct' } },
  { key: 'idle',    host: 'w1-闲置',     state: 'idle',         family: 'gray',   name: '', needProg: false,
    deploy: { state: 'idle' } },
  { key: 'stopped', host: 'w1-已停止',   state: 'stopped',      family: 'gray',   name: '', needProg: false,
    deploy: { state: 'stopped' } },
  { key: 'failed',  host: 'w1-失败',     state: 'failed',       family: 'red',    name: 'ollama', needProg: false,
    deploy: { state: 'failed', engine: 'ollama', step: 'docker', step_state: 'fail', detail: '拉取镜像超时' } },
  { key: 'ocr-install',   host: 'w1-OCR安装中',   state: 'installing',    comps: { ocr: { state: 'installing' },  h3: { state: 'uninstalled' } },
    deploy: { state: 'deploying', step: 'model_pull', step_state: 'ok', detail: '组件安装 60%' } },
  { key: 'h3-install',    host: 'w1-H3安装中',    state: 'installing',    comps: { ocr: { state: 'uninstalled' }, h3: { state: 'installing' } },
    deploy: { state: 'deploying', step: 'model_pull', step_state: 'ok', detail: '组件安装 75%' } },
  { key: 'ocr-uninstall', host: 'w1-OCR卸载中',   state: 'uninstalling',  family: 'amber-degraded', comps: { ocr: { state: 'uninstalling' }, h3: { state: 'uninstalled' } } },
];
const devicesById = {};   // key -> device_id

// ---------- 语义表 ----------
const STATE_TOKENS = ['运行中','online','部署中','deploying','排队','queued','已停止','停止','stopped','闲置','idle','失败','failed','卸载中','uninstalling'];
const PRESENCE = ['在线','离线'];
const WORDS_BY_KEY = { running: ['运行中','online'], deploying: ['部署中','deploying'], queued: ['排队','queued'],
  idle: ['闲置','idle'], stopped: ['已停止','停止','stopped'], failed: ['失败','failed'], uninstalling: ['卸载中','uninstalling'] };
const colorFamily = rgb => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(rgb));
  if (!m) return 'none';
  const r = +m[1], g = +m[2], b = +m[3];
  if (Math.max(r, g, b) < 50) return 'dark';
  if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30) return 'gray';
  if (g >= r && g >= b) return 'green';
  if (r > b && g > b) return 'amber';
  if (b > r && b > g) return 'blue';
  if (r > g && r > b) return 'red';
  return 'none';
};
const lum = rgb => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(rgb)); return m ? 0.2126 * (+m[1]) + 0.7152 * (+m[2]) + 0.0722 * (+m[3]) : 0; };
const badgesOf = el => el.filter(e => !e.btn && !e.link && e.bg && e.bg !== 'rgba(0, 0, 0, 0)' && e.radius >= 6 && !PRESENCE.includes(e.text));

// ---------- 打开页面 + 登录 ----------
const task = await useOrCreateTaskSpace('W1-部署状态操作列统一验收');
await openOrReuseTab(BASE + '/', { wait: true, timeout: 20 });
actions.push('打开真实页面 ' + BASE);
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

// ---------- 种子（页面内 fetch） ----------
const seed = await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list.devices || [])) {
    if (d.hostname && d.hostname.startsWith('w1-')) await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth });
  }
  window.__w1keys = window.__w1keys || {};
  const S = ${JSON.stringify(scenarios)};
  const out = {};
  for (const sc of S) {
    const j = await (await fetch('/api/admin/devices/new', { method: 'POST', headers: auth })).json();
    window.__w1keys[sc.host] = j.device_key;
    const device = { hostname: sc.host, cpu: 'x86 8c', gpu: 'RTX 4090', gpu_mem_mb: 24576, mem_total_gb: 64,
      agent_version: '9.9.9', components: sc.comps || { ocr: { state: 'uninstalled' }, h3: { state: 'uninstalled' } }, deploy: sc.deploy || {} };
    const r = await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': j.device_key, 'content-type': 'application/json' }, body: JSON.stringify({ device }) });
    out[sc.host] = { hb: r.status, key: j.device_key };
  }
  const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list2.devices || [])) if (d.hostname && d.hostname.startsWith('w1-')) out[d.hostname].device_id = d.device_id;
  return out;
})()`);
for (const sc of scenarios) devicesById[sc.key] = (seed[sc.host] || {}).device_id;
actions.push('种子 9 场景设备：' + JSON.stringify(Object.fromEntries(scenarios.map(s => [s.key, seed[s.host] && seed[s.host].hb]))));

await waitForElement('#devRows tr');
// 等待全部场景行渲染（页面 5s 轮询，最多 20s）
await js(`(async () => {
  const hosts = ${JSON.stringify(scenarios.map(s => s.host))};
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
    const texts = rows.map(tr => (tr.children[0] || {}).textContent || '').join(' ');
    if (hosts.every(h => texts.includes(h))) return 'ready';
    await new Promise(r => setTimeout(r, 500));
  }
  return 'timeout';
})()`);
await wait(1);
await shot('w1-accept-main');

// ---------- 心跳刷新 + 摘录全部行 ----------
await js(`(async () => {
  const keys = window.__w1keys || {};
  for (const h of Object.keys(keys)) {
    await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': keys[h], 'content-type': 'application/json' }, body: JSON.stringify({ device: {} }) });
  }
  return Object.keys(keys).length;
})()`);
actions.push('心跳刷新在线状态');

const describe = await js(`(async () => {
  const describeRow = (host) => {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
    const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(host));
    if (!tr) return { host, found: false };
    const tdS = tr.children[2], tdO = tr.children[3];
    if (!tdS || !tdO) return { host, found: true, malformed: true, statusText: '', opsText: '', statusEl: [], buttons: [], selects: [] };
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
actions.push('摘录 9 行 状态/操作列 DOM');

// ---------- 断言 ----------
const results = [];

// A1 状态卡四要素
{
  const r = { id: 'A1', name: '部署状态列=部署物状态卡（名称徽章→状态徽章→进度→一句话）', checks: [] };
  for (const sc of scenarios) {
    if (sc.state === 'installing' || sc.state === 'uninstalling') continue;   // 组件态在 A4/A3 覆盖
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
    const sentencePos = sentence ? pos(sentence) : -1;
    const four = [namePos, statePos, progPos, sentencePos].filter(p => p >= 0);
    const cs = [];
    cs.push([sc.key + ' 名称徽章存在且非状态词', !!nameBadge && nameBadge.text.trim() !== '' && !STATE_TOKENS.includes(nameBadge.text), nameBadge ? nameBadge.text : '∅']);
    if (sc.name) cs.push([sc.key + ' 名称徽章含期望部署物(' + sc.name + ')', !!nameBadge && nameBadge.text.includes(sc.name), nameBadge ? nameBadge.text : '∅']);
    cs.push([sc.key + ' 状态徽章∈状态词', !!stateBadge && STATE_TOKENS.includes(stateBadge.text), stateBadge ? stateBadge.text : '∅']);
    cs.push([sc.key + ' 顺序 名称<状态', namePos >= 0 && statePos >= 0 && namePos < statePos, namePos + '/' + statePos]);
    if (sc.needProg) {
      cs.push([sc.key + ' 进度元素存在', progPos >= 0, progPos < 0 ? '无' : '有']);
      cs.push([sc.key + ' 顺序 状态<进度', statePos >= 0 && progPos >= 0 && statePos < progPos, statePos + '/' + progPos]);
    }
    cs.push([sc.key + ' 一句话存在且为四要素末位', !!sentence && four.length >= 3 && sentencePos === Math.max(...four), sentence ? sentence.text.slice(0, 40) : '∅']);
    r.checks.push([sc.key, cs.every(c => c[1]), cs]);
  }
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// A2 操作列三段
{
  const d = describe.run;
  const cs = [];
  if (!d.found) { cs.push(['行未找到', false]); }
  else {
    const sels = d.selects;
    cs.push(['级联≥3 select', sels.length >= 3, sels.length]);
    if (sels[0]) cs.push(['类型 select 含 文生文/图生文/文生视频', ['文生文', '图生文', '文生视频'].every(x => sels[0].options.some(o => o.text.includes(x))), sels[0].options.map(o => o.text).join('|')]);
    cs.push(['引擎 select ≥1 项', sels.length >= 2 && sels[1].options.length >= 1, sels.length >= 2 ? sels[1].options.length : '∅']);
    cs.push(['档位/模型 select ≥1 项', sels.length >= 3 && sels[2].options.length >= 1, sels.length >= 3 ? sels[2].options.length : '∅']);
    const groupPat = [/隧道/, /详情/, /日志/, /回收/, /删除/];
    const isGroup = b => groupPat.some(p => p.test(b.text));
    const nonGroup = d.buttons.filter(b => !isGroup(b));
    const group = d.buttons.filter(isGroup);
    cs.push(['主按钮唯一（非通用组按钮恰 1 个）', nonGroup.length === 1, nonGroup.map(b => b.text).join('|') || '∅']);
    const depBtn = nonGroup[0];
    cs.push(['主按钮文案∈{部署引擎,安装 OCR,安装 H3}', !!depBtn && /部署引擎|安装 OCR|安装 H3/.test(depBtn.text), depBtn ? depBtn.text : '∅']);
    const exp = ['隧道', '详情', '日志', '回收', '删除'];
    cs.push(['通用组恰 5 个且顺序 隧道→详情→日志→回收→删除', group.length === 5 && group.every((b, i) => new RegExp(exp[i]).test(b.text)), group.map(b => b.text).join('→') || '∅']);
    cs.push(['无「停止」按钮', !d.buttons.some(b => /停止/.test(b.text)), d.buttons.map(b => b.text).join('|')]);
    const depIdx = depBtn ? d.buttons.indexOf(depBtn) : -1;
    const grpIdx = group[0] ? d.buttons.indexOf(group[0]) : -1;
    cs.push(['段序 级联主按钮<通用组', depIdx >= 0 && grpIdx >= 0 && depIdx < grpIdx, depIdx + '/' + grpIdx]);
  }
  results.push({ id: 'A2', name: '操作列固定三段（级联类型→引擎→档位 + 主按钮随类型 + 通用组 隧道→详情→日志→回收→删除）',
    pass: cs.every(c => c[1]), checks: cs });
}

// A3 状态色板（含 卸载中=琥珀降级）
{
  const dDeploy = describe.deploy;
  const deployBadge = dDeploy && dDeploy.found ? badgesOf(dDeploy.statusEl).find(b => WORDS_BY_KEY.deploying.includes(b.text)) : undefined;
  const deployBg = deployBadge ? deployBadge.bg : '';
  const cs = [];
  for (const sc of scenarios) {
    if (!sc.family) continue;
    const d = describe[sc.key];
    if (!d.found) { cs.push([sc.key + ': 行未找到', false]); continue; }
    const sb = badgesOf(d.statusEl).find(b => WORDS_BY_KEY[sc.state].includes(b.text));
    if (!sb) { cs.push([sc.key + '(' + sc.state + ') 状态徽章未找到', false, 'badges=' + badgesOf(d.statusEl).map(b => b.text).join('|')]); continue; }
    const fam = colorFamily(sb.bg);
    let ok = fam === sc.family;
    let note = sc.state + '→' + fam + '（bg=' + sb.bg + '）';
    if (sc.state === 'uninstalling') {
      const degraded = deployBg && sb.bg !== deployBg && lum(sb.bg) <= lum(deployBg);
      ok = ok && degraded;
      note += ' 部署中bg=' + deployBg + ' 亮度差=' + (lum(sb.bg) - lum(deployBg)).toFixed(0);
    }
    cs.push([sc.key + '(' + sc.state + ') 色板=' + sc.family, ok, note]);
  }
  results.push({ id: 'A3', name: '状态色板统一（运行中=绿/部署中=琥珀/排队=蓝/已停止或闲置=灰/失败=红/卸载中=琥珀降级）',
    pass: cs.every(c => c[1]), checks: cs });
}

// A4 OCR/H3 部署过程显进度
{
  const cs = [];
  for (const k of ['ocr-install', 'h3-install']) {
    const d = describe[k];
    if (!d.found) { cs.push([k + ': 行未找到', false]); continue; }
    const hasProg = d.statusEl.some(e => e.bar || e.pct) || /\d+%/.test(d.opsText);
    const bare = /安装中…/.test(d.statusText + d.opsText);
    cs.push([k + ' 显进度（非裸文本）', !!hasProg, 'hasProgress=' + !!hasProg + ' bareText=' + bare + ' statusText=' + d.statusText.slice(0, 80) + ' opsText=' + d.opsText.slice(0, 100)]);
  }
  results.push({ id: 'A4', name: 'OCR/H3 部署过程显进度（不再裸文本）', pass: cs.every(c => c[1]), checks: cs });
}

// A5 组件状态行 + 死代码 ocrBtns/h3Btns
{
  const domClean = Object.values(describe).every(d => !d.found || !/组件\s*:/.test(d.opsText));
  const html = await js(`(async () => (await (await fetch('/')).text()))()`);
  const srcClean = !/\bocrBtns\b|\bh3Btns\b/.test(html);
  results.push({ id: 'A5', name: '组件状态行与死代码 ocrBtns/h3Btns 移除',
    pass: domClean && srcClean, checks: [
      ['操作列无「组件:」行', domClean, ''],
      ['源码无 ocrBtns/h3Btns', srcClean, 'ocrBtns=' + /\bocrBtns\b/.test(html) + ' h3Btns=' + /\bh3Btns\b/.test(html)],
    ] });
}

// A6 UI 文案无注释式/自证式
{
  const texts = Object.values(describe).map(d => (d.statusText || '') + ' ' + (d.opsText || '')).join(' || ');
  const noTok = !/\bt\d{2,3}\b/.test(texts) && !/（\s*t\d/.test(texts);
  const noSelf = !texts.includes('当前部署:');
  results.push({ id: 'A6', name: 'UI 文案无注释式/自证式描述',
    pass: noTok && noSelf, checks: [
      ['无 t<编号> 注释令牌', noTok, ''],
      ['无「当前部署:」自证式标签', noSelf, ''],
    ] });
}

// ---------- A2 交互附验：级联联动 + 真实点击通用组 ----------
const interaction = {};
{
  const id = devicesById.run;
  if (id) {
    interaction.cascade = await js(`(async () => {
      const id = ${JSON.stringify(id)};
      const t = document.getElementById('t_' + id);
      const read = () => ({
        e: [...document.getElementById('e_' + id).options].map(o => o.value || o.textContent.trim()),
        o: [...document.getElementById('o_' + id).options].map(o => o.textContent.trim()),
        btn: document.getElementById(id + '_dep_btn').textContent.trim()
      });
      const out = { initial: read() };
      t.value = 'ocr'; t.dispatchEvent(new Event('change', { bubbles: true }));
      out.ocr = read();
      t.value = 'h3'; t.dispatchEvent(new Event('change', { bubbles: true }));
      out.h3 = read();
      t.value = 'text'; t.dispatchEvent(new Event('change', { bubbles: true }));
      out.text = read();
      return out;
    })()`);
    actions.push('级联交互：类型 文生文→图生文→文生视频→文生文，断言引擎/档位/主按钮联动');
    await shot('w1-cascade');

    // 真实点击：详情 → 折叠展开；日志 → tabB（附验：不改 A2 门禁，结果进 knownIssues）
    const fold = {};
    try {
      await click('text=详情 >> nth=0', { label: '点击详情' });
      fold.detail = await js(`(async () => {
        const id = ${JSON.stringify(id)};
        const el = document.getElementById('detail_' + id);
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          if (el && el.style.display === '') return '展开';
          await new Promise(r => setTimeout(r, 300));
        }
        return el ? '未展开(det存在)' : '未展开(det未挂载)';
      })()`);
      await click('text=日志 >> nth=0', { label: '点击日志' });
      await wait(1);
      fold.logTab = await js(`(() => {
        const id = ${JSON.stringify(id)};
        const b = document.getElementById('tabB_' + id + '_body');
        return b ? (b.style.display === '' ? '日志tab激活' : '未激活') : '无tabB';
      })()`);
      actions.push('真实点击 通用组 详情/日志：' + JSON.stringify(fold));
    } catch (e) {
      fold.clickError = String(e && e.message || e);
      actions.push('通用组真实点击失败：' + fold.clickError);
    }
    interaction.fold = fold;
    await shot('w1-ops-detail');
    // 收起折叠，避免遮挡后续截图
    await js(`(() => { const id = ${JSON.stringify(id)}; const el = document.getElementById('detail_' + id); if (el && el.style.display === '') el.style.display = 'none'; return true; })()`);
  } else {
    actions.push('未取得 run 设备 device_id，跳过级联/点击附验');
  }
}

// ---------- 清理种子设备 ----------
await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  let n = 0;
  for (const d of (list.devices || [])) {
    if (d.hostname && d.hostname.startsWith('w1-')) { await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth }); n++; }
  }
  return n;
})()`);
actions.push('清理 w1-* 种子设备');

// ---------- 汇总输出 ----------
const verdicts = Object.fromEntries(results.map(r => [r.id, r.pass ? 'PASS' : 'FAIL']));
const knownIssues = [];
{
  const f = interaction.fold || {};
  if (f.detail && f.detail !== '展开') {
    knownIssues.push('通用组「详情」真实点击未展开折叠（' + f.detail + '，日志tab=' + (f.logTab || 'n/a') + '）——基线 renderDevices 存在缺陷：创建行时 tr.after(det) 先于 tbody.appendChild(tr)，det 行未挂载（无父节点 after() 为 no-op），toggleDetail 对 null 直接 return；t2 改渲染层时应一并修复');
  }
  if (f.clickError) knownIssues.push('通用组真实点击投递失败：' + f.clickError);
}
const finalOut = {
  url: BASE + '/',
  操作序列: actions,
  截图: shots,
  results: results.map(r => ({ id: r.id, name: r.name, pass: r.pass, checks: r.checks })),
  interaction,
  knownIssues,
  被测路径: BASE + '（本地沙箱真实运行页面，wrangler dev，token dev-admin-token-8848）',
  结论: 'red phase（基线）运行：' + Object.entries(verdicts).map(([k, v]) => k + '=' + v).join(' ') +
        '；t2 实现后应 A1–A6 全 PASS。',
};
cliLog(JSON.stringify(finalOut, null, 1));
await completeTaskSpace('W1-部署状态操作列统一验收', { keep: false });
})().catch(e => cliLog('ERR ' + (e && e.stack || e)));
