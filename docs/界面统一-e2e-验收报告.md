# cybercafe 云管理端「部署状态/操作」两列统一 —— E2 生产环境 e2e 界面验收报告

- **执行**：测试 1（团队 界面统一工作组）
- **日期**：2026-10-10
- **验收对象**：部署状态列=部署物状态卡（名称徽章→状态徽章→进度→一句话）+ 操作列固定三段（级联选择→主按钮→通用操作组）+ 统一状态色板 + OCR/H3 显进度 + 无「组件:」裸状态行
- **验收方式**：ego 浏览器驱动**真实部署环境**（生产域名）真实页面，真实打开/登录/点击/交互，截图留证 + DOM/样式机器断言

## 1. 真实路径拓扑（被测路径声明与验证）

```
ego 浏览器（本机 Chromium）
  → https://cybercafe.akkak.kdns.fr         （生产域名，cloudflared 隧道出公网，可达性: HTTP 200，时延 2.4s）
  → aliyun 容器 cybercafe-cloud:0.4.0        （Dockerfile 无 wrangler，entrypoint exec node server.js，PORT=8080，DATA_DIR=/data，KV 落盘 /data/kv.json）
  → 静态 UI cloud/public/index.html          （sha256 f8f4423a584a6b27d7263088a28415a0ca929cf28a16fe60ee2e46aaa80dcd59，与 main a091a10 逐字节一致）
```

可达性验证（无静默跳过）：
- `GET /` → HTTP 200（2.4s，经 CF 隧道）
- `GET /api/admin/devices` 无 token → 401；带 `Bearer dev-admin-token-8848` → 200（登录凭据确认可用）
- 生产 index.html sha256 == main a091a10 的 cloud/public/index.html —— 证明生产运行即本里程碑验收产物

## 2. 数据说明（真实设备形态覆盖方式）

生产 KV 经服务化数据形态切换后当前 **真实设备 0 台**（设备记录待 agent 注册/心跳重建）。
为核验「多设备各形态（有引擎部署/OCR/H3/无部署）渲染一致」，验收以 `e2e-` 前缀种子 **9 台代表态设备**经真实 API（管理端 + 设备心跳）走真实渲染路径，**验收结束后全部经管理 API DELETE 清理**：
- 清理证据：`cleanup = { deleted: 9, remainingE2e: 0, total: 0 }`（验收后生产设备数回到 0，零残留、零污染）
- 种子形态：运行中(引擎 ollama) / 部署中(vllm) / 排队 / 闲置 / 已停止 / 失败 / OCR 安装中 / H3 部署(安装中) / OCR 卸载中

## 3. 验收点结果

| 验收点 | 结果 | 关键断言与证据 |
|---|---|---|
| P1 可达性 | **PASS** | HTTP 200、鉴权 200/401、index.html sha 与 a091a10 一致（见 §1） |
| P2 状态卡四要素 | **PASS** | 9/9 行：名称徽章→状态徽章→进度(运行/部署中/排队/安装中)→一句话 四要素文档序一致；引擎(ollama/vllm)/OCR/H3/未部署 各形态名称徽章与期望部署物匹配；「无部署」行（闲置/已停止）名称徽章=未部署、无进度要求 |
| P3 操作列三段 | **PASS** | 级联≥3 select（类型 文生文/图生文/文生视频 + 引擎 + 档位/模型）；主按钮唯一且文案∈{部署引擎,安装 OCR,安装 H3}；通用组恰 5 个固定顺序 **隧道→详情→日志→回收→删除**；无「停止」按钮；段序 级联<通用组；级联联动期望值比对 4/4（切图生文→[OCR]/rapidocr/安装 OCR；切文生视频→[H3]/h3档/安装 H3；切回→部署引擎） |
| P4 状态色板 | **PASS** | 7/7 computed background 色族：运行中→green、部署中→amber、排队→blue、已停止/闲置→gray、失败→red、卸载中→amber+降级（bg 与部署中相异且亮度≤部署中） |
| P5 无裸组件行 | **PASS** | 全部行操作列无「组件: OCR xx · H3 xx」行；无「安装中…/卸载中…」裸文本（OCR/H3 安装态走进度条） |

### 交互附验（真实点击）
- 级联联动：真实 change 事件驱动类型切换，引擎/档位/主按钮文案按期望逐项刷新（P3 内 4/4）。
- 通用组可点：CDP 真实坐标鼠标点击 run 行「详情」→ 折叠展开；点击「日志」→ 日志 tab 激活（`cdp点击:详情` → 展开；`cdp点击:日志` → 日志tab激活）。

## 4. 结论

**生产环境 e2e 界面验收 PASS，未发现问题，无需回传开发 1 修复。**
「部署状态/操作」两列统一（状态卡四要素 + 操作列三段 + 统一色板 + OCR/H3 显进度 + 无裸组件行）已在真实生产链路（浏览器→CF 隧道→aliyun 容器→静态 UI）验证一致。

## 5. 截图留证（最终运行 2026-10-10T11-14-41）

| 阶段 | 截图路径 |
|---|---|
| 01 页面加载 | `tests/screenshots/e2e-prod/e2e-01-load-2026-10-10T11-14-41.png` |
| 02 登录 | `tests/screenshots/e2e-prod/e2e-02-login-2026-10-10T11-14-41.png` |
| 03 设备列表全貌（9 形态） | `tests/screenshots/e2e-prod/e2e-03-roster-2026-10-10T11-14-41.png` |
| 04 通用组点击展开 | `tests/screenshots/e2e-prod/e2e-04-ops-click-2026-10-10T11-14-41.png` |
| 05 判决汇总 | `tests/screenshots/e2e-prod/e2e-05-verdict-2026-10-10T11-14-41.png` |
| 06 清理后 | `tests/screenshots/e2e-prod/e2e-06-cleanup-2026-10-10T11-14-41.png` |

（运行日志：`tests/screenshots/e2e-prod/run-<时间戳>.log`；上表截图视觉复核：状态卡四要素结构、进度条（74%/88%）、色调板、按钮序与机器断言逐项一致。）

## 6. 复跑方式

```bash
cd /tmp/界面统一/main
ego-browser nodejs < tests/e2e_prod_verify.js
```
脚本自负登录（token `dev-admin-token-8848`）、种子清理与回收；生产无真实设备时以 e2e-* 种子行完成渲染核验并清理。