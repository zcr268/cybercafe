// W0 云项目真实服务化 · UI 真实页面验证（ego 浏览器）
// 打开真实 URL → 真实登录（填 ADMIN_TOKEN）→ 等待管理台渲染 → 截图留证 → 输出结论
// 运行参数经绝对路径配置文件注入（ego-browser-dsh nodejs 子进程 process.env 为空，实测不传播）；
// 配置文件路径由 run-ui-check.sh 以 __UI_ENV_CFG__ 占位符注入，失败时回落环境变量/默认值。
// 输出: JSON { url, actions[], screenshot, tableState, conclusion }
const env = { base: "http://127.0.0.1:8788", token: "dev-admin-token-8848", shotDir: ".out" };
try {
  const fs = await import("node:fs");
  const cfg = JSON.parse(fs.readFileSync("__UI_ENV_CFG__", "utf8"));
  env.base = cfg.base; env.token = cfg.token; env.shotDir = cfg.shotDir;
} catch (e) {
  env.base = process.env.BASE_URL || env.base;
  env.token = process.env.ADMIN_TOKEN || env.token;
  env.shotDir = process.env.SHOT_DIR || env.shotDir;
}
const base = env.base, token = env.token, shotDir = env.shotDir;
const out = { url: base + "/", actions: [], screenshot: null, tableState: null, conclusion: "FAIL" };

const task = await useOrCreateTaskSpace("w0-service-ui");
out.actions.push("open " + base + "/");
await openOrReuseTab(base + "/", { wait: true, timeout: 20 });
await wait(2);

// 初始态三态判定（w2r 审查 w2-t-3：不得假设未登录态）：
//   A) #app 已可见（浏览器带 cc_admin_token 登录态）→ 跳过登录直接验证；
//   B) #login 可见（未登录）→ 填 ADMIN_TOKEN 真实登录；
//   C) 两者都不可见（页面未渲染/网络失败）→ FAIL。
let state = { appVisible: false, loginVisible: false };
for (let i = 0; i < 10; i++) {
  state = await js(`(() => {
    const app = document.querySelector('#app');
    const login = document.querySelector('#login');
    return {
      appVisible: !!app && getComputedStyle(app).display !== 'none',
      loginVisible: !!login && getComputedStyle(login).display !== 'none'
    };
  })()`);
  if (state.appVisible || state.loginVisible) break;
  await wait(1);
}
out.actions.push("initial state: appVisible=" + state.appVisible + " loginVisible=" + state.loginVisible);

if (state.appVisible) {
  out.actions.push("已登录态（#app 直显），跳过登录步骤");
} else if (state.loginVisible) {
  await fillInput("#tokenIn", token);
  out.actions.push("fill ADMIN_TOKEN into #tokenIn");
  await click("#btnLogin");
  out.actions.push("click #btnLogin");
} else {
  out.conclusion = "FAIL: neither #app nor #login visible (page not rendered)";
  cliLog(JSON.stringify(out));
  await completeTaskSpace("w0-service-ui", { keep: false });
  process.exit(1);
}

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