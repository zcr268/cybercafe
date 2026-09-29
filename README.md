# CyberCafe 云网咖模型管控

「云端管 + 本地跑」的远程模型部署管控系统，三部分组成：
```
┌──────────────────────────────┐
│ ① 云管理端 cloud/             │   Cloudflare Worker + KV + 静态UI
│   设备列表 / 下发部署指令 /     │   （本仓库直接部署，支持绑定固定域名）
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
| `cloud/` | ① 云管理端：CF Worker（`src/index.js`）+ 管理/聊天 UI（`public/index.html`） |
| `agent/` | ②③ 本地脚本：`install.sh`（安装/自更新/开机自启）+ `cybercafe-agent.py`（控制脚本，仅依赖 Python3 标准库） |

## 部署云管理端（Cloudflare）

前置：Cloudflare 账号。KV 命名空间必须在账号内创建一次：

```bash
cd cloud
npx wrangler kv namespace create CYBERCAFE_KV   # 记下返回的 id
# 把 id 填入 wrangler.toml 的 [[kv_namespaces]] id 字段
npx wrangler secret put ADMIN_TOKEN              # 设置管理端登录口令
npx wrangler deploy                              # 或在 CF 后台用 Workers Builds 连接本 GitHub 仓库自动部署
```

- 后续可在 CF 后台给 Worker 绑定**固定自定义域名**——代码全部使用请求来源地址下发配置，绑域名后零改动。
- `workers.dev` 默认域名在中国大陆可能不可达，生产使用请绑自有域名。

## 使用流程

1. 打开云管理端 → 输入 ADMIN_TOKEN 登录
2. 右上角「+ 添加设备」→ 复制生成的安装命令
3. 在目标 Ubuntu 机器上以 root 执行该命令（形如 `curl -fsSL "https://<域名>/install.sh?key=cck-xxx" | bash`）
4. 设备出现在列表后，选择模型点「部署」→ 日志区实时看节点进度（检测GPU→装Docker→镜像加速→GPU容器支持→拉镜像→启Ollama→拉模型→鉴权网关→建隧道→公网验证）
5. 部署完成后在右侧聊天面板直接对话（浏览器 → CF 隧道 → 机器模型，带 Key 鉴权）

## 安全模型

- 云管理端：`ADMIN_TOKEN`（CF secret）保护全部管理 API 与 UI
- 设备侧：每台设备一个 `cck-` 设备密钥，安装时由云端注入脚本本地保存；注册/心跳/拉脚本均校验
- 模型 API：每次部署由云端生成独立 `sk-` Key，nginx 网关强制 Bearer 鉴权 + CORS，Key 只保存在云管 KV 与机器本地配置中

## 本地控制脚本说明（agent/）

- `install.sh`：安装 python3/curl 依赖 → 从云管理端实时拉取最新控制脚本（含设备Key注入）→ 写入 systemd 服务（开机自启、崩溃重启）
- `cybercafe-agent.py`：启动采集设备信息注册；每 10s 心跳上报状态并拉取指令；部署流水线逐节点上报进度；云端脚本版本变化时自动下载替换并重启（自更新）
- 支持的指令：`deploy`（部署模型）、`stop`（停止容器）、`restart_tunnel`（重建隧道并上报新域名）

## 注意

- 目标机器需要 NVIDIA GPU + Ubuntu（脚本会自动安装 docker / nvidia-container-toolkit / 配置国内镜像加速）
- 隧道使用 cloudflared 快速隧道，容器重建后域名会变——agent 会自动把新域名随心跳上报，云管端聊天页永远使用最新地址

## 项目工作规矩（用户 2026-09-29 明确，每次开发必须执行）

1. **生产验收前的本地并行开发**：t3 生产云管端全链路验收完成之前，所有开发与验收（云管理端开发、引擎支持开发、以及后续一切开发）都可在**本地环境并行推进**——本地 wrangler dev（127.0.0.1:8788，ADMIN_TOKEN=dev-admin-token-8848）或临时隧道沙箱，不等待生产链路就绪。
2. **最终收敛**：每轮改动的最终产物必须收敛到 **GitHub 仓库（zcr268/cybercafe）** 与 **aliyun**（`ssh aliyun`，`~/work/cybercafe`，deploy/aliyun 可部署形态）。本地修改推回前先 `git pull --rebase` 防冲突，并同步部署到 aliyun。
3. **真实路径红线**：开发与验收的端到端验证必须走真实路径（真实机器 / 真实容器 / 真实网络传输），禁止 mock 冒充。
4. **本地仓库目录纪律**：不随手改动本地已有目录文件；涉及阿里云侧修复直接在 aliyun 上改并提交，开发用独立克隆（如 /tmp/cybercafe-*）。
