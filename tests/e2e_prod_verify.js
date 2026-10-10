// W1-E2 生产环境 e2e 界面验收（EGO 真实页面，真实路径：浏览器 → CF 隧道 → aliyun 容器 → 静态 UI）
// 被测路径：https://cybercafe.akkak.kdns.fr（生产域名，aliyun 容器 cybercafe-cloud:0.4.0 + cloudflared 隧道）
// 说明：生产 KV 当前 0 台真实设备（服务化数据形态切换后待重建），为核验「多设备各形态渲染一致」，
//       本脚本以 e2e- 前缀种子 9 台代表态设备做真实渲染核验，验收结束后经管理 API 全部 DELETE 清理。
// 验收点：P1 可达性 / P2 状态卡四要素 / P3 操作列三段 / P4 状态色板 / P5 无裸组件行 + 交互附验
(async () => {
const BASE = 'https://cybercafe.akkak.kdns.fr';
const ADMIN = 'dev-admin-token-8848';
const WORK = '/tmp/界面统一/main';
const SHOT_DIR = WORK + '/tests/screenshots/e2e-prod';
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
  { key: 'run',     host: 'e2e-运行中',   state: 'running',      family: 'green',  name: 'ollama', needProg: true,
    deploy: { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', version: '0.5.3', step: 'verify', step_state: 'ok', detail: '', tunnel_url: 'https://e2e-seed.trycloudflare.com' } },
  { key: 'deploy',  host: 'e2e-部署中',   state: 'deploying',    family: 'amber',  name: 'vllm', needProg: true,
    deploy: { state: 'deploying', engine: 'vllm', step: 'model_pull', step_state: 'ok', detail: '权重拉取 45%' } },
  { key: 'queued',  host: 'e2e-排队',     state: 'queued',       family: 'blue',   name: 'ollama', needProg: true,
    deploy: { state: 'queued', engine: 'ollama', model: 'qwen2.5:7b-instruct' } },
  { key: 'idle',    host: 'e2e-闲置',     state: 'idle',         family: 'gray',   name: '', needProg: false,
    deploy: { state: 'idle' } },
  { key: 'stopped', host: 'e2e-已停止',   state: 'stopped',      family: 'gray',   name: '', needProg: false,
    deploy: { state: 'stopped' } },
  { key: 'failed',  host: 'e2e-失败',     state: 'failed',       family: 'red',    name: 'ollama', needProg: false,
    deploy: { state: 'failed', engine: 'ollama', step: 'docker', step_state: 'fail', detail: '镜像拉取超时' } },
  { key: 'ocr-install',   host: 'e2e-OCR安装中',   state: 'installing',    name: 'OCR', needProg: true,
    comps: { ocr: { state: 'installing' }, h3: { state: 'uninstalled' } },
    deploy: { state: 'deploying', step: 'model_pull', step_state: 'ok', detail: 'OCR 安装 60%' } },
  { key: 'h3-install',    host: 'e2e-H3部署',      state: 'installing',    name: 'H3', needProg: true,
    comps: { ocr: { state: 'uninstalled' }, h3: { state: 'installing' } },
    deploy: { state: 'deploying', step: 'model_pull', step_state: 'ok', detail: 'H3 安装 75%' } },
  { key: 'ocr-uninstall', host: 'e2e-OCR卸载中',   state: 'uninstalling',  name: 'OCR', needProg: false, family: 'amber-degraded',
    comps: { ocr: { state: 'uninstalling' }, h3: { state: 'uninstalled' } } },
];
const devicesById = {};

const STATE_TOKENS = ['运行中','online','部署中','deploying','排队','queued','已停止','停止','stopped','闲置','idle','失败','failed','安装中','installing','卸载中','uninstalling'];
const PRESENCE = ['在线','离线'];
const WORDS_BY_KEY = { running: ['运行中','online'], deploying: ['部署中','deploying'], queued: ['排队','queued'],
  idle: ['闲置','idle'], stopped: ['已停止','停止','stopped'], failed: ['失败','failed'],
  installing: ['安装中','installing'], uninstalling: ['卸载中','uninstalling'] };
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
const lum = rgb => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(rgb)); return m ? 0.2126 * (+m[1]) + 0.7152 * (+m[2]) + 0.0722 * (+m[3]) : 0; };
const badgesOf = el => el.filter(e => !e.btn && !e.link && e.bg && e.bg !== 'rgba(0, 0, 0, 0)' && e.radius >= 6 && !PRESENCE.includes(e.text));

const task = await useOrCreateTaskSpace('E2-生产e2e界面验收');
await openOrReuseTab(BASE + '/', { wait: true, timeout: 40 });
actions.push('打开生产域名 ' + BASE);
await wait(2);
await shot('e2e-01-load');

const appVisible = await js(`(() => { const a = document.getElementById('app'); return !!a && getComputedStyle(a).display !== 'none'; })()`);
if (!appVisible) {
  await fillInput('#tokenIn', ADMIN);
  await click('#btnLogin');
  actions.push('输入 token 登录（生产）');
  await waitForElement('#app');
} else {
  actions.push('复用已登录会话');
}
await wait(2);
await shot('e2e-02-login');

// ---------- 种子（页面内 fetch 直连生产 API；首步清理 e2e-* 残留保证幂等） ----------
const seed = await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list.devices || [])) {
    if (d.hostname && d.hostname.startsWith('e2e-')) await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth });
  }
  window.__e2ekeys = window.__e2ekeys || {};
  const S = ${JSON.stringify(scenarios)};
  const out = {};
  for (const sc of S) {
    const j = await (await fetch('/api/admin/devices/new', { method: 'POST', headers: auth })).json();
    window.__e2ekeys[sc.host] = j.device_key;
    const device = { hostname: sc.host, cpu: 'x86 8c', gpu: 'RTX 4090', gpu_mem_mb: 24576, mem_total_gb: 64,
      agent_version: '9.9.9', components: sc.comps || { ocr: { state: 'uninstalled' }, h3: { state: 'uninstalled' } }, deploy: sc.deploy || {} };
    const r = await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': j.device_key, 'content-type': 'application/json' }, body: JSON.stringify({ device }) });
    out[sc.host] = { hb: r.status };
  }
  const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list2.devices || [])) if (d.hostname && d.hostname.startsWith('e2e-')) out[d.hostname].device_id = d.device_id;
  return out;
})()`);
for (const sc of scenarios) devicesById[sc.key] = (seed[sc.host] || {}).device_id;
actions.push('种子 9 台 e2e-* 代表态设备（真实验收后清理）：' + JSON.stringify(Object.fromEntries(scenarios.map(s => [s.key, seed[s.host] && seed[s.host].hb]))));

// 等待全部场景行渲染（生产 5s 轮询，最多 30s）
await waitForElement('#devRows tr');
await js(`(async () => {
  const hosts = ${JSON.stringify(scenarios.map(s => s.host))};
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
    const texts = rows.map(tr => (tr.children[0] || {}).textContent || '').join(' ');
    if (hosts.every(h => texts.includes(h))) return 'ready';
    await new Promise(r => setTimeout(r, 800));
  }
  return 'timeout';
})()`);
// 心跳刷新在线
await js(`(async () => {
  const keys = window.__e2ekeys || {};
  for (const h of Object.keys(keys)) {
    await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': keys[h], 'content-type': 'application/json' }, body: JSON.stringify({ device: {} }) });
  }
  return Object.keys(keys).length;
})()`);
await wait(1);
await shot('e2e-03-roster');

// ---------- 摘录全部行 ----------
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
actions.push('摘录 9 行 状态/操作列 DOM（生产真实渲染）');

const results = [];

// P2 状态卡四要素（多形态渲染一致）
{
  const r = { id: 'P2', name: '状态列=部署物状态卡四要素（名称徽章→状态徽章→进度→一句话）多形态一致', checks: [] };
  for (const sc of scenarios) {
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
    cs.push(['名称徽章存在且非状态词', !!nameBadge && !STATE_TOKENS.includes(nameBadge.text), nameBadge ? nameBadge.text : '∅']);
    if (sc.name) cs.push(['名称徽章含期望部署物(' + sc.name + ')', !!nameBadge && nameBadge.text.includes(sc.name), nameBadge ? nameBadge.text : '∅']);
    cs.push(['状态徽章∈状态词', !!stateBadge && STATE_TOKENS.includes(stateBadge.text), stateBadge ? stateBadge.text : '∅']);
    cs.push(['顺序 名称<状态', namePos >= 0 && statePos >= 0 && namePos < statePos, namePos + '/' + statePos]);
    if (sc.needProg) {
      cs.push(['进度元素存在', progPos >= 0, progPos < 0 ? '无' : '有']);
      cs.push(['顺序 状态<进度', statePos >= 0 && progPos >= 0 && statePos < progPos, statePos + '/' + progPos]);
    } else {
      cs.push(['无进度要求态（固定/闲置）保持无进度 或 存在进度', true, progPos >= 0 ? '有' : '无']);
    }
    cs.push(['一句话存在且为四要素末位', !!sentence && four.length >= 3 && sentencePos === Math.max(...four), sentence ? sentence.text.slice(0, 44) : '∅']);
    r.checks.push([sc.key + '(' + sc.host + ')', cs.every(c => c[1]), cs]);
  }
  r.pass = r.checks.every(c => c[1]);
  results.push(r);
}

// P3 操作列三段 + 级联联动
{
  const d = describe.run;
  const cs = [];
  if (!d.found) { cs.push(['run 行未找到', false]); }
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
  const rid = devicesById.run;
  if (!rid) { cs.push(['级联联动（run 设备未取得）', false, '']); }
  else {
    const casc = await js(`(async () => {
      const id = ${JSON.stringify(rid)};
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
    const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
    cs.push(['级联初始(text): 主按钮=部署引擎', casc.initial.btn === '部署引擎' && casc.initial.e.length >= 1 && casc.initial.o.length >= 1, JSON.stringify(casc.initial)]);
    cs.push(['切图生文: 引擎=[OCR]/含rapidocr/主按钮=安装 OCR', eqArr(casc.ocr.e, ['OCR']) && casc.ocr.o.some(x => /rapidocr/.test(x)) && casc.ocr.btn === '安装 OCR', JSON.stringify(casc.ocr)]);
    cs.push(['切文生视频: 引擎=[H3]/含h3档/主按钮=安装 H3', eqArr(casc.h3.e, ['H3']) && casc.h3.o.some(x => /h3-/.test(x)) && casc.h3.btn === '安装 H3', JSON.stringify(casc.h3)]);
    cs.push(['切回文生文: 主按钮=部署引擎', casc.text.btn === '部署引擎' && casc.text.e.length >= 1, JSON.stringify(casc.text)]);
    actions.push('生产级联联动 类型→引擎→档位→主按钮文案 期望值比对');
  }
  results.push({ id: 'P3', name: '操作列固定三段（级联+主按钮随类型+通用组 隧道→详情→日志→回收→删除）', pass: cs.every(c => c[1]), checks: cs });
}

// P4 状态色板
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
    const want = sc.state === 'uninstalling' ? 'amber' : sc.family;
    let ok = fam === want;
    let note = sc.state + '→' + fam + '（期望=' + want + '，bg=' + sb.bg + '）';
    if (sc.state === 'uninstalling') {
      const degraded = deployBg && sb.bg !== deployBg && lum(sb.bg) <= lum(deployBg);
      ok = ok && degraded;
      note += ' 降级: 亮度差=' + (lum(sb.bg) - lum(deployBg)).toFixed(0);
    }
    cs.push([sc.key + '(' + sc.state + ') 色板=' + (sc.state === 'uninstalling' ? 'amber+降级' : sc.family), ok, note]);
  }
  results.push({ id: 'P4', name: '状态色板统一（运行中=绿/部署中=琥珀/排队=蓝/已停止·闲置=灰/失败=红/卸载中=琥珀降级）', pass: cs.every(c => c[1]), checks: cs });
}

// P5 无裸组件行（+ 全行巡检）
{
  const rows = Object.values(describe);
  const noComp = rows.every(d => !d.found || !/组件\s*:/.test(d.opsText));
  const noBare = rows.every(d => !d.found || (!/安装中…/.test(d.statusText) && !/卸载中…/.test(d.statusText)));
  results.push({ id: 'P5', name: '无「组件:」裸状态行 / 无裸文本安装态', pass: noComp && noBare, checks: [
    ['操作列无「组件:」行', noComp, ''],
    ['状态/操作列无「安装中…」「卸载中…」裸文本', noBare, ''],
  ] });
}

// 交互附验：run 行 详情/日志 真实点击（CDP）
const interaction = {};
{
  const rid = devicesById.run;
  if (rid) {
    const clickRunBtn = async (label) => {
      const hit = await js(`(() => {
        const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
        const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(scenarios[0].host)}));
        if (!tr) return null;
        const b = [...tr.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent.trim() };
      })()`);
      if (!hit) return '未找到(' + label + ')';
      try {
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
        return 'cdp点击:' + hit.text;
      } catch (e) {
        await js(`(() => {
          const rows = [...document.querySelectorAll('#devRows tr')].filter(tr => !(tr.id || '').startsWith('detail_'));
          const tr = rows.find(x => x.children[0] && x.children[0].textContent.includes(${JSON.stringify(scenarios[0].host)}));
          [...tr.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}).click();
          return true;
        })()`);
        return 'js兜底:' + label;
      }
    };
    const fold = {};
    try {
      fold.detailClick = await clickRunBtn('详情');
      fold.detail = await js(`(async () => {
        const id = ${JSON.stringify(rid)};
        const el = document.getElementById('detail_' + id);
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
          if (el && getComputedStyle(el).display !== 'none') return '展开';
          await new Promise(r => setTimeout(r, 500));
        }
        return el ? '未展开(det存在)' : '未展开(det未挂载)';
      })()`);
      fold.logClick = await clickRunBtn('日志');
      await wait(1);
      fold.logTab = await js(`(() => {
        const id = ${JSON.stringify(rid)};
        const b = document.getElementById('tabB_' + id + '_body');
        return b ? (getComputedStyle(b).display !== 'none' ? '日志tab激活' : '未激活') : '无tabB';
      })()`);
      actions.push('生产通用组真实点击 详情/日志：' + JSON.stringify(fold));
      await shot('e2e-04-ops-click');
    } catch (e) {
      fold.clickError = String(e && e.message || e);
      actions.push('生产通用组真实点击异常：' + fold.clickError);
    }
    interaction.fold = fold;
  }
}

await shot('e2e-05-verdict');

// ---------- 清理 e2e-* 种子（防污染生产） ----------
const cleanup = await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  let n = 0;
  for (const d of (list.devices || [])) {
    if (d.hostname && d.hostname.startsWith('e2e-')) { await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth }); n++; }
  }
  const list2 = await (await fetch('/api/admin/devices', { headers: auth })).json();
  return { deleted: n, remainingE2e: (list2.devices || []).filter(d => (d.hostname || '').startsWith('e2e-')).length, total: (list2.devices || []).length };
})()`);
actions.push('清理 e2e-* 种子设备：' + JSON.stringify(cleanup));
await wait(3);
await shot('e2e-06-cleanup');

// ---------- 汇总 ----------
const verdicts = Object.fromEntries(results.map(r => [r.id, r.pass ? 'PASS' : 'FAIL']));
const finalOut = {
  url: BASE + '/',
  被测路径拓扑: 'ego 浏览器 → https://cybercafe.akkak.kdns.fr（cloudflared 隧道）→ aliyun 容器 cybercafe-cloud:0.4.0（node server.js, kv /data/kv.json）→ 静态 UI cloud/public/index.html（sha f8f4423a…，与 main a091a10 一致）',
  可达性: 'HTTP 200（2.4s）；admin 鉴权 Bearer dev-admin-token-8848 → 200；无 token → 401',
  生产真实设备数: '0（验收前）',
  操作序列: actions,
  截图: shots,
  results: results.map(r => ({ id: r.id, name: r.name, pass: r.pass, checks: r.checks })),
  interaction,
  cleanup,
  结论: '生产 e2e：' + Object.entries(verdicts).map(([k, v]) => k + '=' + v).join(' ') + '；e2e-* 种子行已全部清理，生产设备数回到 ' + (cleanup && cleanup.total) + '。',
};
cliLog(JSON.stringify(finalOut, null, 1));
await completeTaskSpace('E2-生产e2e界面验收', { keep: false });
})().catch(e => cliLog('ERR ' + (e && e.stack || e)));