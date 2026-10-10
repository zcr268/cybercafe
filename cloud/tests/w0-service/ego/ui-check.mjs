// W0 云项目真实服务化 · UI 真实页面验证（ego 浏览器）
// 打开真实 URL → 真实登录（填 ADMIN_TOKEN）→ 等待管理台渲染 → 截图留证 → 输出结论
// 用法: BASE_URL=... ADMIN_TOKEN=... SHOT_DIR=... ego-browser-dsh nodejs < ego/ui-check.mjs
// 输出: JSON { url, actions[], screenshot, tableState, conclusion }
const base = process.env.BASE_URL || "http://127.0.0.1:8788";
const token = process.env.ADMIN_TOKEN || "dev-admin-token-8848";
const shotDir = process.env.SHOT_DIR || ".out";
const out = { url: base + "/", actions: [], screenshot: null, tableState: null, conclusion: "FAIL" };

const task = await useOrCreateTaskSpace("w0-service-ui");
out.actions.push("open " + base + "/");
await openOrReuseTab(base + "/", { wait: true, timeout: 20 });
await wait(2);

// 等待登录面板出现（无 token 时默认显示 #login）
let loginVisible = false;
for (let i = 0; i < 10; i++) {
  loginVisible = await js(`(() => { const el = document.querySelector('#login'); return !!el && getComputedStyle(el).display !== 'none' })()`);
  if (loginVisible) break;
  await wait(1);
}
out.actions.push("login panel visible: " + loginVisible);
if (!loginVisible) {
  out.conclusion = "FAIL: login panel not visible";
  cliLog(JSON.stringify(out));
  await completeTaskSpace("w0-service-ui", { keep: false });
  process.exit(1);
}

await fillInput("#tokenIn", token);
out.actions.push("fill ADMIN_TOKEN into #tokenIn");
await click("#btnLogin");
out.actions.push("click #btnLogin");

// 等待管理台渲染（#app 显示 + 设备/批次表存在）
let appVisible = false;
for (let i = 0; i < 15; i++) {
  appVisible = await js(`(() => { const el = document.querySelector('#app'); return !!el && getComputedStyle(el).display !== 'none' })()`);
  if (appVisible) break;
  await wait(1);
}
out.actions.push("app visible: " + appVisible);
const tableState = await js(`(() => ({
  title: document.title,
  devRows: (document.querySelector('#devRows') || {}).children ? document.querySelector('#devRows').children.length : -1,
  batchRows: (document.querySelector('#batchRows') || {}).children ? document.querySelector('#batchRows').children.length : -1,
  loginErr: (document.querySelector('#loginErr') || {}).textContent || ''
}))()`);
out.tableState = tableState;

const shot = await captureScreenshot(shotDir + "/w0-ui-logged-in.png");
out.screenshot = shot;
out.actions.push("screenshot -> " + shot);

const ok = appVisible && tableState.devRows >= 0 && tableState.batchRows >= 0 && !tableState.loginErr;
out.conclusion = ok ? "PASS" : "FAIL";
cliLog(JSON.stringify(out));
await completeTaskSpace("w0-service-ui", { keep: false });
process.exit(ok ? 0 : 1);