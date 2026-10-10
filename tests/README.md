# W1-1 界面验证用例：部署状态 / 操作 两列统一（EGO 浏览器）

测试先行（red phase）用例，服务工作项「t2 实现两列统一」。

- 被测路径（真实运行页面）：本地沙箱 `http://127.0.0.1:8788`（wrangler dev，登录 token `dev-admin-token-8848`）
- 生产 e2e：`https://cybercafe.akkak.kdns.fr`（后续工作项执行；用例以 `BASE` 常量为入口，切换域名即可复用）
- 验证手段：ego 浏览器驱动真实页面 → 真实打开/输入/点击 → 截图留证 → DOM/样式/交互核验

## 前置：拉起沙箱（ADMIN_TOKEN 必须用 --var 注入！）

```bash
cd cloud && HOME=/tmp/cc-wrangler-home npm_config_cache=/tmp/npm-cache-cc \
  npx --yes wrangler dev --port 8788 --var "ADMIN_TOKEN:dev-admin-token-8848"
```

实测注意（wrangler 4.149）：`ADMIN_TOKEN=xxx npx wrangler dev` 的 shell 前缀**不会**传入
worker —— `/api/admin/*` 全部 500「ADMIN_TOKEN 未配置」。必须 `--var` 或 `.dev.vars`。
沙箱由部署 D1 负责常驻；若不可达，先按上述命令拉起，失败再等待 D1。

## 运行

```bash
cd /tmp/界面统一/部署状态操作列统一
# 1) 现状录制（基线证据，red phase 必跑）
ego-browser nodejs < tests/w1_baseline_record.js
# 2) 验收断言（当前基线跑=红，预期多例失败；t2 实现后应全绿）
ego-browser nodejs < tests/w1_acceptance.js
```

- 截图：`tests/screenshots/<name>-<时间戳>.png`（每次运行唯一、不互相覆盖；不入库，见 tests/.gitignore）
- 每个脚本最后输出 JSON：`{ url, 操作序列, 截图, results, 被测路径, 结论 }`

## 验收契约（断言规范，t2 实现须对齐）

种子数据：脚本自建设备（hostname 前缀 `w1-`，首步清理残留保证幂等，结束 DELETE 清理），
覆盖状态：运行中/部署中/排队/闲置/已停止/失败/OCR安装中/H3安装中/OCR卸载中。

### A1｜部署状态列 = 部署物状态卡（名称徽章→状态徽章→进度→一句话）
状态单元格（第 3 列）内按文档序存在且有序：
1. **名称徽章**：带背景色 + 圆角(≥6px) 的徽章元素，文本非空、非状态词、非「在线/离线」（引擎部署=引擎键如 ollama/vllm；OCR/H3=「OCR」「H3」）；
2. **状态徽章**：徽章文本 ∈ {运行中,online,部署中,deploying,排队,queued,已停止,停止,stopped,闲置,idle,失败,failed,卸载中,uninstalling}；
3. **进度**：`.bar` 进度条元素或含 `NN%` 的文本；对 运行中/部署中/排队 必须存在，位置在状态徽章之后；
4. **一句话**：无背景纯文本元素（≥2 字、非链接、非按钮），是卡内最后一个要素（位置在进度之后）；
- 顺序断言：名称徽章 < 状态徽章 < 进度 < 一句话（文档位置）。
- 宽容：允许「在线/离线」「隧道链接」等附加元素存在，不参与四要素。

### A2｜操作列固定三段
- 段 1 级联选择（类型→引擎→档位）：操作单元格（第 4 列）DOM 序前 3 个 `<select>` 依次为 类型（选项含 文生文/图生文/文生视频）、引擎（≥1 项）、档位/模型（≥1 项）；
- 段 2 主按钮：级联组内唯一非通用组按钮，文案随类型联动（文生文→部署引擎 / 图生文→安装 OCR / 文生视频→安装 H3），交互断言：切类型后引擎/档位选项与按钮文案同步刷新；
- 段 3 通用操作组：主按钮之后的按钮按固定顺序 **隧道→详情→日志→回收→删除** 恰 5 个；不得出现「停止」按钮；主按钮须在通用组首按钮之前。
- 附验：点击「详情」展开折叠、「日志」切到日志 tab（真实点击可用性）。

### A3｜状态色板统一
状态徽章 computed background 按语义映射色族：
运行中→绿、部署中→琥珀、排队→蓝、已停止/闲置→灰、失败→红；
卸载中→琥珀**降级**（琥珀色族，且与「部署中」琥珀*不同*：背景色相异、亮度不高于部署中）。
色族判定：绿 g≥r且g≥b；琥珀 r>g>b；蓝 b>r且b>g；灰 |r-g|<30且|g-b|<30；红 r>g>b 且 r-g>40。

### A4｜OCR/H3 部署过程显进度
OCR/H3 处于 installing 时，该行状态列（或操作列）必须出现进度条或 `NN%` 进度文本——
不得再是「OCR 安装中…」类裸文本。种子同时提供 `components.ocr/h3.state=installing` 与
`deploy.detail` 含百分比信号，实现可任选其一驱动进度渲染。

### A5｜组件状态行与死代码移除
- 操作单元格文本不得再含「组件: OCR … · H3 …」行；
- 页面源码（`fetch('/')`）不得再含标识符 `ocrBtns` / `h3Btns`。

### A6｜UI 文案无注释式/自证式
渲染文本（状态/操作列）不得含 `t\d{2,3}` 注释令牌、不得含「当前部署:」等自证式标签前缀。

## 已知约束
- ego 的 Node 侧 fetch 到 127.0.0.1 不可达（挂起）→ 种子与页面内请求一律在页面上下文 `js()` 内执行；
- 设备行定位：`#devRows tr` 过滤 `detail_` 折叠行，按 `tr.children[0]` 文本含 hostname 匹配；
- 脚本复用任务空间 `W1-部署状态操作列统一验收`；脚本结束 `completeTaskSpace({keep:false})`。

## red phase 实测发现的基线缺陷（供 t2 参考，非本套件门禁项）
1. **详情折叠行未挂载**：renderDevices 创建行时 `tr.after(det)` 先于 `tbody.appendChild(tr)`，
   无父节点时 `after()` 为 no-op → `detail_<id>` 行不存在，「详情/日志」按钮点击无效
   （toggleDetail 对 null 提前返回）。通用组真实点击附验已暴露该问题（knownIssues）。
2. **「暂无设备」空态行不回收**：设备从 0→N 时，空态行残留不删，与设备行并存。
两者均位于 t2 将改写的渲染层（renderDevices/buildRowCells），建议一并修复。