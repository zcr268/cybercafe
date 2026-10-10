// W1-1 现状录制（red phase 基线证据）
// 打开真实页面 → 登录 → 种子设备（运行中引擎 / OCR 安装中）→ 截图 → 状态/操作列 DOM 结构摘录
// 输出：{ url, 操作序列, 截图, 被测路径, 现状结论 }（cliLog）
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

// 种子：清 w1-* 残留 → 建「运行中引擎」「OCR 安装中」两设备，key 存页面 window.__w1keys 供心跳刷新
const seed = await js(`(async () => {
  const ADMIN = ${JSON.stringify(ADMIN)};
  const auth = { 'Authorization': 'Bearer ' + ADMIN };
  const list = await (await fetch('/api/admin/devices', { headers: auth })).json();
  for (const d of (list.devices || [])) {
    if (d.hostname && d.hostname.startsWith('w1-')) await fetch('/api/admin/device/' + d.device_id, { method: 'DELETE', headers: auth });
  }
  window.__w1keys = window.__w1keys || {};
  const mk = async (device) => {
    const j = await (await fetch('/api/admin/devices/new', { method: 'POST', headers: auth })).json();
    window.__w1keys[device.hostname] = j.device_key;
    const r = await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': j.device_key, 'content-type': 'application/json' }, body: JSON.stringify({ device }) });
    return { host: device.hostname, hb: r.status };
  };
  const out = [];
  out.push(await mk({ hostname: 'w1-运行中', cpu: 'x86 8c', gpu: 'RTX 4090', gpu_mem_mb: 24576, mem_total_gb: 64, agent_version: '9.9.9',
    components: { ocr: { state: 'uninstalled' }, h3: { state: 'uninstalled' } },
    deploy: { state: 'online', engine: 'ollama', model: 'qwen2.5:7b-instruct', version: '0.5.3', step: 'verify', step_state: 'ok', detail: '', tunnel_url: 'https://seed.trycloudflare.com' } }));
  out.push(await mk({ hostname: 'w1-OCR安装中', cpu: 'x86 8c', gpu: 'RTX 4090', gpu_mem_mb: 24576, mem_total_gb: 64, agent_version: '9.9.9',
    components: { ocr: { state: 'installing' }, h3: { state: 'uninstalled' } },
    deploy: { state: 'deploying', step: 'model_pull', step_state: 'ok', detail: '组件安装 60%' } }));
  return out;
})()`);
actions.push('种子设备（w1-运行中 / w1-OCR安装中）：' + JSON.stringify(seed));

await waitForElement('#devRows tr');
await wait(2);
await shot('w1-record-main');

// 心跳刷新在线
await js(`(async () => {
  const keys = window.__w1keys || {};
  for (const h of Object.keys(keys)) {
    await fetch('/api/device/heartbeat', { method: 'POST', headers: { 'X-Device-Key': keys[h], 'content-type': 'application/json' }, body: JSON.stringify({ device: {} }) });
  }
  return Object.keys(keys).length;
})()`);
actions.push('心跳刷新在线状态');
await wait(1);

// 结构摘录（同验收套件 describe）
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
    return { host, found: true, statusText: txt(tdS), opsText: txt(tdO),
      statusEl: walk(tdS),
      buttons: [...tdO.querySelectorAll('button')].map(b => ({ id: b.id || '', cls: b.className, text: txt(b) })),
      selects: [...tdO.querySelectorAll('select')].map(s => ({ id: s.id || '', value: s.value, options: [...s.options].map(o => ({ value: o.value, text: o.textContent.trim(), selected: o.selected })) })) };
  };
  return { run: describeRow('w1-运行中'), ocr: describeRow('w1-OCR安装中') };
})()`);

const badgeSummary = (d) => (d && d.statusEl ? d.statusEl.filter(e => e.bg && e.bg !== 'rgba(0, 0, 0, 0)' && e.radius >= 6).map(e => e.text + '[' + e.bg + ']') : []);
const progSummary = (d) => (d && d.statusEl ? d.statusEl.filter(e => e.bar || e.pct).map(e => e.tag + ':' + e.text) : []);

const summary = {
  url: BASE + '/',
  操作序列: actions,
  截图: shots,
  被测路径: BASE + '（本地沙箱真实运行页面，wrangler dev，token dev-admin-token-8848）',
  现状结论: {
    状态列: {
      'w1-运行中': { text: describe.run.statusText, badges: badgeSummary(describe.run), progress: progSummary(describe.run) },
      'w1-OCR安装中': { text: describe.ocr.statusText, badges: badgeSummary(describe.ocr), progress: progSummary(describe.ocr), bareText: /安装中…/.test(describe.ocr.statusText + describe.ocr.opsText) },
    },
    操作列: { 'w1-运行中': { buttons: describe.run.buttons.map(b => b.text), selects: describe.run.selects.map(s => s.options.length + '项') } },
    结构观察: [
      '状态列现状：在线徽章 + 英文状态词(state)+ 进度条 + 裸文本(engine/model/step) + 「当前部署: …」标签 + 驱动徽章，非「名称徽章→状态徽章→进度→一句话」四要素卡',
      '操作列现状：级联三 select + 部署引擎 + 按钮[重建隧道/停止/详情/日志/删除/回收磁盘] + 「组件: OCR … · H3 …」行，非固定三段（含停止、删除在回收前、组件行）',
      'OCR 安装中现状：仅「组件: OCR installing · H3 uninstalled」裸文本，无任何进度条/百分比',
      '渲染文案现状：状态列含「当前部署:」自证式标签',
    ],
  },
};
cliLog(JSON.stringify(summary, null, 1));
await completeTaskSpace('W1-部署状态操作列统一验收', { keep: false });
})().catch(e => cliLog('ERR ' + (e && e.stack || e)));
