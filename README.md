# CyberCafe 云网咖模型管控

「云端管 + 本地跑」的远程模型部署管控系统，三部分组成：
```
┌──────────────────────────────┐
│ ① 云管理端 cloud/             │   真实 HTTP 服务（node server.js）
│   设备列表 / 下发部署指令 /     │   + 本地文件 KV（DATA_DIR/kv.json）
│   聊天 UI 经 CF 隧道直连机器    │
└──────▲────────────────▲──────┘
       │ 拉取脚本/指令      │ 聊天流量(带 Key)
       │ 上报状态           │
┌──────┴─────────────────┐   ┌──┴───────────────┐
│ ③ 本地控制脚本 agent/    │   │ cloudflared 隧道   │
│  注册/心跳/部署/自更新    │──▶│ (机器模型API公网出口)│
└────────────────────────┘   └──────────────────┘
        ▲ 由 ② install.sh 装为 systemd 开机自启服务
```

## 目录

| 路径 | 说明 |
|---|---|
| `cloud/` | ① 云管理端：真实独立 HTTP 服务（`server.js` 入口 + `src/index.js` fetch 处理器）+ 管理/聊天 UI（`public/index.html`） |
| `agent/` | ②③ 本地脚本：`install.sh`（安装/自更新/开机自启）+ `cybercafe-agent.py`（控制脚本，仅依赖 Python3 标准库） |

## 部署云管理端

W0 服务化后云管理端为**真实独立 HTTP 服务**，不再依赖 wrangler dev / CF Workers 平台绑定：
`node cloud/server.js` 自托管静态 UI 与全部 API，KV 状态持久化到本地文件 `DATA_DIR/kv.json`
（重启同 DATA_DIR 数据不丢）；`cloud/wrangler.toml` 仅保留 fetch 处理器兼容参考，不作为运行形态。

**本地沙箱**（开发/验收，127.0.0.1:8788）：

```bash
cd cloud
ADMIN_TOKEN=dev-admin-token-8848 node server.js   # 默认 PORT=8788；DATA_DIR 缺省为系统临时目录
```

**生产（aliyun 容器）**：`deploy/aliyun/` 镜像 0.4.0——Dockerfile 构建后 entrypoint 直启
`node server.js`，compose 注入 `PORT=8080`、`DATA_DIR=/data`（`cybercafe-state` 卷持久化 kv.json）、
`ADMIN_TOKEN`，cloudflared 隧道（`CF_TUNNEL_TOKEN`）把 `127.0.0.1:8080` 出公网到固定域名：

```bash
cd deploy/aliyun
ADMIN_TOKEN=<口令> CF_TUNNEL_TOKEN=<隧道token> docker compose up -d --build
```

> **服务化升级后首次启动如设备/批次缺失**（旧 wrangler sqlite → kv.json 未迁移），执行
> `docker exec aliyun-cloud-1 sh /root/work/cybercafe/deploy/aliyun/migrate-kv.sh /data`
> 把 `DATA_DIR/v3/kv/` 旧库（`_mf_entries` + `blobs/`）还原合并进 `DATA_DIR/kv.json`（旧库优先、备份后原子写回、输出统计）。

- 环境变量契约（本地与生产同名读取，详见 `cloud/server.js` 头注释与 `cloud/tests/w0-service/README.md`）：
  `PORT`、`ADMIN_TOKEN`、`DATA_DIR`、`GITHUB_RAW_BASE` / `JSDELIVR_RAW_BASE`、`AGENT_LOCAL_BASE` / `AGENT_LOCAL_ROOT_BASE`。
- 代码全部使用请求来源地址下发配置，绑固定域名后零改动；生产固定域名 `cybercafe.akkak.kdns.fr`。

## 使用流程

1. 打开云管理端 → 输入 ADMIN_TOKEN 登录
2. 右上角「+ 添加设备」→ 复制生成的安装命令
3. 在目标 Ubuntu 机器上以 root 执行该命令（形如 `curl -fsSL "https://<域名>/install.sh?key=cck-xxx" | bash`）
4. 设备出现在列表后，在操作列依次选择**任务类型**（文生文/图生文/文生视频）→**引擎或组件**（ollama/vLLM/SGLang/Strata 或 OCR/H3）→**模型/档位**，点随类型联动的主按钮（部署引擎/安装 OCR/安装 H3）下发部署 → 进度实时显示在设备状态卡进度条，点「日志」（或展开「详情」的日志 tab）可看节点明细（检测GPU→装Docker→镜像加速→GPU容器支持→拉镜像→启动引擎→[Ollama:拉模型]→鉴权网关→建隧道→公网验证）
5. 部署完成后在右侧聊天面板直接对话（浏览器 → CF 隧道 → 机器模型，带 Key 鉴权）

## 基础镜像批量装机（批次码，v0.3.2 起）

面向「同一基础镜像批量开实例」场景：镜像内预置 **provision 首启服务 + 批次码**，实例首次开机自动注册设备，无需逐台执行安装命令；镜像内不写死单一设备密钥（每台领取独立 `cck-` key）。

1. 云管理端点「批次安装码」→ 生成批次码（`ccb-`，**配额不填=无限**，或显式填数量限台数；备注/可选有效期）
2. 制作镜像时预置（v0.3.3 起推荐一条命令）：
   ```bash
   # 在仓库 agent/ 目录（install.sh/provision.sh/cybercafe-provision.service 同目录）执行：
   bash install.sh --image-prep --batch <批次码> --api-base https://<云管理域名>
   # 等价手工步骤：写 /etc/cybercafe/batch.code + /etc/cybercafe/api_base → 拷贝
   # provision.sh 到 /opt/cybercafe/ + cybercafe-provision.service 到 /etc/systemd/system/ 并 enable
   # --root <目录> 可指定目标根（构建器/临时目录 dry-run 验证用）
   ```
3. 实例开机 → systemd oneshot 跑 `provision.sh`：
   - 采集硬件指纹（物理网卡 MAC 排序 sha256 前 12 位，见下节）与 `/etc/machine-id` → POST `/api/device/provision`（批次码为装机凭证，携带 `hardware_id`）
   - 云端校验批次有效：同一指纹（`prov:hw`）/同 machine-id（兼容路径）复用原 key（不耗配额）；显式限量的批次配额满时拒绝新机，无限批次（quota=null）不受限
   - 返回 key+API 写入 `/opt/cybercafe/config.env` → 调用 `install.sh --batch` 装 agent → 写 `/opt/cybercafe/.provisioned`（含 `fp=<指纹>`）防重复
4. 设备列表自动出现该实例（带「批次」来源标签），批次卡实时展示用量（used/quota，无限显示 ∞，满/过期自动标红）

- 单机直装也可用批次模式：`PROVISION_API_BASE=<域名> bash install.sh --batch <批次码>`（或 `PROVISION_CODE` 环境变量）；现有单机模式（`?key=` 注入）完全不受影响。
- **批次一键安装命令（v0.3.9 起，批次卡自带「复制命令」）**：目标机（裸机、无 install.sh）直贴执行——
  ```bash
  curl -fsSL 'https://cybercafe.akkak.kdns.fr/install.sh?batch=<批次码>' | bash -s -- --batch <批次码> --api-base https://cybercafe.akkak.kdns.fr
  ```
  语义：`?batch=` 下发**原始** install.sh（不注入参数）→ `--batch` 进入批次模式 → 云端
  `/api/device/provision` 按 machine-id 颁发 cck- 设备密钥并安装 agent。命令中 API 地址取当前
  访问域名（生产=固定域名，本地沙箱=当前 origin）。`--image-prep` 仍用于**镜像构建期**预置（见上）。
- 批次配额：`POST /api/admin/batches` 的 `quota` 字段可选——不填/空 = 无限（KV `quota:null`，provision 跳过配额检查）；显式填数量才限（>=1 整数）。已建批次（明确 quota）语义不变。
- KV key 约定：`batch:<code>`（label/quota/used/created/expires）、`prov:machine:<machine_id>`（兼容旧路径）、`prov:hw:<hardware_id>`（t33 主去重键）、`devicekey:<hash>`（沿用，新增 batch/machine_id/hw_id 字段）。

### 模板机 → 层镜像 → 换机自动注册（MAC 指纹绑定 + 克隆自愈，v0.4.0 / t33）

用户目标：**一条命令装模板机 → 关机做层镜像 → 换一台机器开机自动「①首启 ②领码 ③装机 ④上线」**。

- 模板机一键命令（t33 起，正常装机路径**末尾**会自动补装首启自检单元，无需 `--image-prep`）：
  ```bash
  curl -fsSL 'https://cybercafe.akkak.kdns.fr/install.sh?batch=<批次码>' | bash -s -- --batch <批次码> --api-base https://cybercafe.akkak.kdns.fr
  ```
  装机完成即：注册（带 `hardware_id=硬件指纹`）+ 写 `.provisioned`（含 `fp=<指纹>`）+ 安装
  `provision.sh` / `cybercafe-provision.service`（每次开机自检）。
- **硬件指纹算法**：枚举 `/sys/class/net/*/address` 物理网卡 MAC（排除 lo/docker*/veth*/br-*/virbr*/tun*/tap*/
  tailscale*/zt*/wg*/bond*/dummy*/sit*/ip6tnl*），排序后 `sha256` 取前 12 位十六进制；
  无物理网卡时回退 `sha256(/etc/machine-id)[:12]`（日志标注来源）。
  - 实测背书（阿里云 ECS 同镜像双实例）：`product_uuid` 相同、MAC 不同 →「MAC 优先、machine-id 兜底」
    是当前唯一可靠顺序；machine-id 与 product_uuid 同源（UUID 去横线），不能绕开克隆问题。
- **开机判定（provision.sh，幂等毫秒级）**：
  - marker 存在且 fp 一致 → 直接 exit 0（不联网、不消耗配额）；
  - marker 存在但 fp 不一致 → **克隆自愈**：按新指纹重新领码（云端 `prov:hw` 去重）→ 重写
    config.env（新 key）→ 重装 agent → 写新 marker，产生**独立第二台设备**，模板记录不受污染；
  - marker legacy（无 fp=）→ 视为同机补写 fp，不重新领码（避免模板机重复消耗配额）；
  - marker 不存在 → 走首启流程。
- 云端去重：`prov:hw:<hardware_id>` 优先（同批次同指纹复用原 key、不消耗配额），`prov:machine:<machine_id>`
  仅当 `hardware_id` 缺失时使用（兼容旧脚本/旧机器）；设备记录带 `hw_id` 字段。
- **自更新通道（批次/镜像机才武装；`/etc/cybercafe/self_update` 内容为 `off` 可全部熄火）**：
  - F：provision.sh 每次开机先拉云端最新版，hash 不同则原子替换并 `exec` 新副本（哨兵
    `CYBERCAFE_PROV_REEXEC=1` 防递归，最多重跑一次）；拉取失败 fail-open 用本地副本；
  - G：首启单元同法自更新 + `daemon-reload`（旧镜像甩掉 `ConditionPathExists` 的唯一途径）；
  - H：装机一律取云端最新 `install.sh?key=`（注入新 key），失败才回退本地副本；
  - ①：agent（v0.4.0）启动时及每 10 分钟低频自检——批次/镜像机上 provision.sh 或单元缺失/未 enable
    时，从云端补齐并**当场触发一次** provision（救「用旧版一键命令做出的镜像」）；单机模式
    （`?key=`，无 BATCH_CODE）通道休眠，不替换任何文件、不 enable 任何单元。
- **⚠️ 已做过的镜像必须重做**：t33 之前的镜像（marker 无 fp / 无首启单元）不具备指纹绑定与克隆自愈；
  旧镜像克隆会出现多台共用同一 device_id 的互相覆盖问题。请用 t33 之后的一键命令重做模板镜像。
- 完整真机验收（打镜像→开实例→首启自动注册→配额/无限）由测试成员按 t9 执行。

## 推理引擎（v0.3.5 起支持四引擎）

| 引擎 | 镜像 | 模型（HF id / Ollama tag） | 说明 |
|---|---|---|---|
| `ollama` | `ollama/ollama:latest` | `qwen2.5:7b-instruct`、`qwen2.5:14b-instruct-q4_k_m`、`llama3.1:8b` | 默认引擎，`ollama pull` 拉模型 |
| `vllm` | `vllm/vllm-openai:v0.4.1`（CUDA 12.1 基底） | `Qwen/Qwen2-7B-Instruct-AWQ`、`Qwen/Qwen2-1.5B-Instruct-AWQ` | OpenAI 兼容 API 端口 8000→宿主 11434；HF 权重走 `HF_ENDPOINT=https://hf-mirror.com` |
| `sglang` | `lmsysorg/sglang:v0.4.1.post4-cu121`（CUDA 12.1 基底） | `Qwen/Qwen2.5-7B-Instruct-AWQ`、`Qwen/Qwen2.5-14B-Instruct-AWQ` | OpenAI 兼容 API 端口 30000→宿主 11434；HF 权重走 hf-mirror |
| `strata` | 原生进程（非容器，Niko1221/Strata） | `Qwen3.8-Flash-Next-Coder`（Coder 档 IQ1_M，~66GB） | 专用运行时（125B MoE 压进 16GB 显存），`git clone + setup.sh` 安装，`serve/server.py` 监听 127.0.0.1:11434；驱动≥580 / 内存≥31GB / 磁盘≥80GB 预检，low-RAM resident 模式，单并发 |

- 四引擎统一以 OpenAI 兼容 API 暴露在 `127.0.0.1:11434`（nginx 鉴权网关不变），UI 聊天面板按设备当前引擎/模型发请求。
- 镜像选择兼容该机驱动 535.274.02（nvidia-smi CUDA 12.2）：vLLM v0.4.1 与 SGLang v0.4.1.post4-cu121 均为 CUDA 12.1 基底镜像；Strata 要求驱动 ≥580（CUDA 13.0，t21 调研该机已升 580.178.04）。
- Strata 注意事项：COW 快照机重启丢数据，agent 部署时自动重装/重拉 ~66GB（支持缓存命中跳过下载，HF 权重走 hf-mirror）；模型数据默认放安装目录旁 `Strata-data`。
- `stop` 指令会停止全部引擎（ollama/vllm/sglang 容器 + strata 进程）+ 网关 + 隧道。

## 聊天性能实测（v0.3.5 起）

聊天面板流式聊天时在每条回复块内实时显示：

- **TTFT 首字延迟**：请求发出 → 首个含 content 的 SSE chunk 到达（毫秒）；
- **每秒 tokens**：累计生成 tokens ÷ 生成耗时（首字→末字，流式统计）；
- token 数优先取 SSE 末块 `usage.completion_tokens`（`stream_options.include_usage`，vllm/sglang/ollama 支持、strata 同协议），缺失时按统一口径估算（CJK 每字≈1 token + 其余 4 字符≈1 token）；
- 同时显示「上次」测量与「累计」tokens（跨设备保留）。

四引擎通用（SSE 流解析统一口径）；引擎不支持 SSE 时自动回退一次性 JSON（TTFT 即整体耗时）。

## 安全模型

- 云管理端：`ADMIN_TOKEN`（环境变量注入：本地沙箱启动参数 / 生产 compose，见「部署云管理端」）保护全部管理 API 与 UI
- 设备侧：每台设备一个 `cck-` 设备密钥，安装时由云端注入脚本本地保存；注册/心跳/拉脚本均校验
- 模型 API：每次部署由云端生成独立 `sk-` Key，nginx 网关强制 Bearer 鉴权 + CORS，Key 只保存在云管 KV 与机器本地配置中

## 本地控制脚本说明（agent/）

- `install.sh`：安装 python3/curl 依赖 → 从云管理端实时拉取最新控制脚本（含设备Key注入）→ 写入 systemd 服务（开机自启、崩溃重启）
- `cybercafe-agent.py`：启动采集设备信息注册；每 10s 心跳上报状态并拉取指令；部署流水线逐节点上报进度；云端脚本版本变化时自动下载替换并重启（自更新）
- 支持的指令：`deploy`（部署模型）、`stop`（停止容器）、`restart_tunnel`（重建隧道并上报新域名）
- 设备信息字段（v0.3.9 起）：`ips`（IPv4 列表，沿用）+ `net`（物理网卡数组 `[{"iface","mac","ip"}]`，排除 lo/docker*/veth*/br-* 等虚拟口，无 IPv4 的物理口保留 mac）；云端按心跳请求来源记录 `remote_ip`（云侧外网 IP，`CF-Connecting-IP` 优先、`X-Forwarded-For` 兜底，为空不覆盖旧值），UI 设备表展示网卡 · IP · MAC 与外网 IP。

## 统一一键卸载（uninstall-all.sh，v0.3.7+）

用户明确：**所有清理 = 所有引擎 + 所有模型**。`uninstall-all.sh`（仓库根目录）是统一入口，一键清掉全部部署内容，只保留脚本本身。

```bash
# 先看将被删什么（只读，推荐先执行）：
bash uninstall-all.sh --dry-run
# 交互确认后执行（或 --yes 跳过确认）：
bash uninstall-all.sh
# 也清 NVIDIA 驱动/容器 toolkit 的说明（默认不执行）：
bash uninstall-all.sh --purge-all
```

**在目标机/裸机获取脚本**（仓库根目录文件，走云管统一下发通道，无需克隆仓库）：

```bash
# 下载到 /root（脚本必须存放在清理目录之外，自带自删防护检查）
curl -fsSL 'https://cybercafe.akkak.kdns.fr/install-extra?name=uninstall-all.sh' -o /root/uninstall-all.sh
chmod +x /root/uninstall-all.sh
# 或 wget：wget -qO /root/uninstall-all.sh 'https://cybercafe.akkak.kdns.fr/install-extra?name=uninstall-all.sh'
```

覆盖范围：
- **引擎**：ollama / vLLM / SGLang / Strata / OCR（t24）/ MiniMax H3（t25）及未来接入的引擎——停进程（`serve/server.py`/`sglang`/`vllm`/`ollama`）、删容器（`ollama vllm sglang chatgw cloudflared`）、删镜像（引擎+网关+隧道仓库与悬空镜像）、删数据卷（`ollama vllm-hf sglang-hf`）、清宿主二进制与 pip 依赖（best-effort）、删目录；
- **模型内容**：Ollama models（卷内）、HF 缓存（`/root/.cache/huggingface|modelscope|torch|rapidocr|onnxruntime|onnx`）、Strata 数据（`/opt/strata` + `Strata-data`，~66GB）、OCR 模型、MiniMax H3 权重（`/opt/minimax-h3`）、原生 sglang 残留（`/models`）；
- **默认保留（系统级留白）**：NVIDIA 驱动、nvidia-container-toolkit、docker、containerd、cybercafe agent（`/opt/cybercafe`）与 systemd 服务；`--purge-all` 仅给出清驱动的手动步骤说明（需先 unhold nvidia-* 再 purge，且需重装驱动，默认不执行）；
- 执行后自动输出**核对清单**（进程/容器/镜像/卷/目录/端口/驱动/agent），残留即报错退出（非零）。

⚠️ **警告**：此操作删除**全部模型与引擎数据，不可恢复**，需用户确认后执行。脚本必须存放在清理目录之外（如 `/root/uninstall-all.sh`，脚本自带自删防护检查）。新增引擎请在脚本配置区登记（容器/镜像仓库/卷/目录/进程模式），t24/t25 若提供各自 `uninstall.sh` 会被自动聚合调用。

## 脚本分发通道（raw / jsDelivr / 本地挂载，v0.3.3 云管理端加固）

云管理端下发 `install.sh` / `cybercafe-agent.py` 走三通道（见 `cloud/src/index.js`「脚本/文件分发通道」）：

1. **`AGENT_LOCAL_BASE`（首选，aliyun 生产用）**：compose 把仓库 `agent/` 只读挂载进静态资源目录 `cloud/public/_agent`，服务经 loopback HTTP 取自身静态资源——`git pull` 后**即时生效**（server.js 每请求读盘），不受任何 CDN 缓存影响，零外部依赖；
2. **`GITHUB_RAW_BASE`（主网络通道，默认 raw.githubusercontent.com）**：Fastly 边缘缓存 ≤5min，新版本最快分钟级生效；
3. **jsDelivr（内置自动回退）**：aliyun 出口访问 raw 超时/任何环境主通道失败时自动兜底；`@main` 路径缓存 12h，时效最差，仅作韧性保障。

要点：
- **实测结论**：jsDelivr 与 raw.githubusercontent 都忽略 URL query 参与缓存键（已实测验证 `?t=` 破缓存无效），旧代码的 60s 窗口 query bust 已移除，改为「自适应双通道 + 5s 超时自动回退 + 本地挂载」。
- **默认值即生产可用**：`DEFAULT_RAW_BASE` 未改变的部署环境即使漏注入 `GITHUB_RAW_BASE`，raw 不通时自动回退 jsDelivr，不会复现 aliyun 出口超时故障；aliyun 容器配置见 `deploy/aliyun/docker-compose.yml`（挂载 `../../agent:/app/cloud/public/_agent:ro` + `AGENT_LOCAL_BASE=http://127.0.0.1:8080/_agent`，根级文件另挂 `../../:/app/cloud/public/_repo:ro` + `AGENT_LOCAL_ROOT_BASE=http://127.0.0.1:8080/_repo`，相对路径以 compose 文件目录 `deploy/aliyun/` 为基准）。W0 服务化后（node server.js）静态 UI 由服务直接读盘提供，本地挂载通道不再受 worker 运行时限制。
- 新环境部署建议：容器类部署仿照 `deploy/aliyun/docker-compose.yml` 挂载 `agent/` 到 `public/_agent`（根级文件挂 `_repo`）并设置 `AGENT_LOCAL_BASE` / `AGENT_LOCAL_ROOT_BASE`；未配置本地挂载时走默认 raw/jsDelivr 网络通道即可。

## 注意

- 目标机器需要 NVIDIA GPU + Ubuntu（脚本会自动安装 docker / nvidia-container-toolkit / 配置国内镜像加速）
- 隧道使用 cloudflared 快速隧道，容器重建后域名会变——agent 会自动把新域名随心跳上报，云管端聊天页永远使用最新地址

## 项目工作规矩（用户 2026-09-29 明确，每次开发必须执行）

1. **本地 = 长期快速调试开发沙箱**：本机 `node cloud/server.js`（127.0.0.1:8788，ADMIN_TOKEN=dev-admin-token-8848，KV 落盘 `DATA_DIR/kv.json`）与临时隧道（trycloudflare.com）是**永久保留的快速调试/开发环境，不存在「下线」操作**——生产云管（aliyun）负责正式链路，本地沙箱负责开发与验收并行推进（云管理端开发、引擎支持开发、后续一切开发），两边同时跑、互不替代。
   - **域名约定**：本地验证域名**一直使用临时隧道域名**（trycloudflare.com 快速隧道，每次隧道重建会变成新随机域名，agent 心跳自动上报最新地址）；固定域名 `cybercafe.akkak.kdns.fr` **仅生产（aliyun）使用**。
2. **最终收敛**：每轮改动的最终产物必须收敛到 **GitHub 仓库（zcr268/cybercafe）** 与 **aliyun**（`ssh aliyun`，`~/work/cybercafe`，deploy/aliyun 可部署形态）。本地修改推回前先 `git pull --rebase` 防冲突，并同步部署到 aliyun。
3. **真实路径红线**：开发与验收的端到端验证必须走真实路径（真实机器 / 真实容器 / 真实网络传输），禁止 mock 冒充。
4. **本地仓库目录纪律**：不随手改动本地已有目录文件；涉及阿里云侧修复直接在 aliyun 上改并提交，开发用独立克隆（如 /tmp/cybercafe-*）。

## MiniMax-H3 本地部署（minimax-h3/）

MiniMax-H3（视频+音频生成引擎，非聊天模型）的规格核实、一键安装/卸载脚本与真机运行证据见
[`minimax-h3/README.md`](minimax-h3/README.md)（含 GPU 放置语义说明、档位表与卸载说明）。
