# W0 云项目真实服务化 · 验证用例（test: W0-1）

测试先行（red phase）：本套件定义 W0「云项目真实服务化」的验收契约，对**真实路径**断言：
真实服务进程 + 真实 HTTP 端点（curl 直连）+ 真实本地持久化文件 + 真实静态挂载通道 +
真实 raw/jsDelivr 网络回退 + ego 浏览器打开真实页面。**拒绝一切 mock**：进程内共享通道、
内存模拟传输、未连真实存储的假绿一律不算通过。

## 验收点 ↔ 用例映射

| 验收点 | 用例 |
|---|---|
| 1) 服务以真实进程直接运行，不依赖 wrangler dev 模拟 | `cases/70-form.sh`（service 强断言；baseline 记录预期红）+ `lifecycle/start.sh` |
| 2) 静态 UI（/ 非 api 路径，含 index.html、install.sh 路由等）由服务自身提供且可访问 | `cases/10-static-ui.sh` + `cases/60-script-channel.sh`（install.sh 路由） |
| 3) 全部 API 路由等价 + 鉴权不变（Admin Bearer ADMIN_TOKEN、设备 X-Device-Key、批次码） | `cases/20-route-contract.sh` / `30-device-api.sh` / `40-admin-api.sh` |
| 4) KV 状态持久化到本地文件：写入设备/批次后重启服务数据不丢 | `cases/50-persistence.sh`（a=快照 / b=重启后）+ `lifecycle/stop.sh|start.sh`（同 DATA_DIR 重启） |
| 5) 脚本分发通道真实可用（AGENT_LOCAL_BASE 本地挂载 + raw/jsDelivr 回退） | `cases/60-script-channel.sh` + `lifecycle/static-server.mjs` |
| 附加 | `ego/ui-check.mjs`：ego 浏览器打开真实页面验证 UI（登录→渲染→截图） |

## 运行

```bash
# 基线（现状 wrangler dev 形态）：对常驻本地沙箱录制契约（attach，不重启）
./run.sh --mode baseline --attach --base-url http://127.0.0.1:8788

# 新服务形态全量验收（生命周期 + 持久化重启 + 形态门禁）
# 注：SERVICE_CMD 的工作目录是 cloud/tests/w0-service/，server.js 位于其 ../../ 处；
#     端口经 --port（默认 8788）导出给服务进程，与沙箱/容器端口冲突时改用空闲端口。
./run.sh --mode service --cmd "node ../../server.js" --port 8788 --data-dir /tmp/w0-kv

# 新服务形态 attach（对已运行端点做契约冒烟）
./run.sh --mode service --attach --base-url http://127.0.0.1:8080

# 追加 ego 浏览器真实页面 UI 验证
./run.sh --mode service --cmd "..." --with-ego
```

- 默认 `BASE_URL=http://127.0.0.1:8788`、`ADMIN_TOKEN=dev-admin-token-8848`（本地沙箱约定，见仓库 README）。
- 全量验收（lifecycle 模式）请使用**全新 `--data-dir`**（40 用例对初始 settings 断言白名单成员、50 用例做写入→重启，干净目录保证可重复）。
- **并发隔离**：每次运行产物落 `.out/run-<pid>/`（service.log / state.json / service.pid / 截图），多执行者共享 worktree 并发跑互不覆盖（实测并发实例曾覆盖 service.pid/state.json 造成假绿，已修复）。
- 生产容器等价：容器内对 `http://127.0.0.1:8080` 跑 `--mode service --attach --with-ego`（或 `--port 8080`）。
- 输出：`.out/run-<pid>/service.log`、TAP 汇总（stdout）、`.out/run-<pid>/state.json`（跨用例状态）、`.out/run-<pid>/w0-ui-logged-in.png`（ego 截图）。`.out/` 已 gitignore。
- 退出码：0=全绿；1=有失败；77=预期红已记录（baseline 形态门禁，不判 FAIL）。

## 服务形态契约（实现方 w2 必须对齐）

新服务（MODE=service）须满足：

1. **真实进程直接运行**：`SERVICE_CMD` 启动独立 HTTP 服务进程，监听 `PORT`（本地沙箱 8788 / 生产容器 8080）；**不得调用 wrangler dev**（70-form 检查进程命令）。
2. **静态 UI 自托管**：`/` 及非 api 路径（index.html）由服务自身读取本地 `public/` 提供；`/install.sh`、`/install-extra` 为服务自身路由（注入/白名单语义与现 worker 等价）。
3. **API 路由等价**：与 `cloud/src/index.js` 路由表逐条等价（20/30/40 用例为契约）；鉴权行为不变（Admin `Bearer ADMIN_TOKEN`、设备 `X-Device-Key`、批次码即凭证）。
4. **KV 持久化到本地文件**：全部 `get/put/delete/list(prefix)` 状态（`device:` / `batch:` / `devicekey:` / `prov:*` / `cmd:` / `log:` / `settings:*` / `meta:*`）持久化为 **`DATA_DIR/kv.json`**（JSON 对象 key→value，value 为 JSON 字符串；支持原子读改写）。重启（同 DATA_DIR）后数据不丢。
5. **环境变量读取**：`ADMIN_TOKEN`、`GITHUB_RAW_BASE`、`JSDELIVR_RAW_BASE`、`AGENT_LOCAL_BASE`、`AGENT_LOCAL_ROOT_BASE`（与现 `.dev.vars`/容器注入同名契约）。
6. **脚本分发通道**：通道 0 = `AGENT_LOCAL_BASE`（本地静态 HTTP，loopback）；回退 = raw/jsDelivr 真实网络（`GITHUB_RAW_BASE`/`JSDELIVR_RAW_BASE`）。

## 真实路径声明（强制）

- 服务进程：`lifecycle/start.sh` nohup 拉起真实进程，`wait-ready.sh` 轮询真实端口。
- HTTP 端点：所有断言 `curl -X ... "${BASE_URL}${path}"` 直连，无 stub。
- 本地静态通道：`lifecycle/static-server.mjs` 起真实 HTTP 文件服务器（等价生产 compose 的 `public/_agent`、`public/_repo` 只读挂载），经 loopback 真实网络传输。
- KV 持久化：service 形态断言 `DATA_DIR/kv.json` 真实文件存在且含写入键；重启（同 DATA_DIR）后 API 数据不丢。
- 回退通道：停掉本地静态服务器后，服务经**真实** raw/jsDelivr 网络请求回退（本环境无外网时记为 skip 并注明，需在有外网验收环境复跑；不是 mock）。
- UI：ego 浏览器打开真实 URL，真实输入/点击/导航，截图留证（`ego/ui-check.mjs`）。

## 红色基线（当前 wrangler dev 形态）

`--mode baseline` 下：
- 契约用例（10/20/30/40/50 语义/60 本地通道）应对现状全绿——它们是新形态必须保持等价的行为基线；
- `70-form.sh` 按验收点 1 记录**预期红**（wrangler dev 形态不满足「真实进程非 wrangler + KV 落盘 kv.json」），退出码 77；
- 回退通道依赖外网，无网环境 skip。

新形态实现后：`--mode service` 全量跑通（含 70 强断言与 ego UI）= W0 验收通过门禁。

## 备注

- 跨用例状态经 `.out/state.json`（save_state/load_state）传递：40 建持久批次 → 30 provision/部署 → 50 快照 → 重启 → 50b 核对。
- baseline 生命周期模式会写 `cloud/.dev.vars`（gitignored，与生产 entrypoint.sh 同款注入），仅用于 wrangler dev 形态。
- 沙箱限制提示：本执行环境 `ps/lsof` 受限时 70-form 相关断言记 skip，须在验收环境（开发机/容器）复跑确认。
