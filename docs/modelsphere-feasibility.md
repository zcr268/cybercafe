# ModelSphere 部署方案可行性调研报告

> 调研人：CyberCafe 团队调研员
> 调研时间：2026-10-02（数据以 2026-09-29 GitHub 快照为准）
> 调研对象：https://github.com/modelsphere/modelsphere 及其生态仓库
> 目标机器：A001-10-003（RTX 4080 SUPER 16GB，驱动 535.274.02 / CUDA 12.2）

---

## 0. 结论先行

**总体结论：部分可行。**

ModelSphere 是一个「Kubernetes 原生」的 LLM 推理平台（sglang / vLLM 引擎 + 路由 / 自动扩缩容 / 可观测），**不是 Docker Compose 或单进程形态**。作为 CyberCafe 的「引擎」：

- ✅ **可行的部分**：OpenAI 兼容 API（`/v1/chat/completions`）、Bearer API Key 网关（与现有 `sk-` Key 模型天然匹配）、支持 vLLM/SGLang（HF safetensors）权重、支持离线/镜像仓库部署、官方支持单节点 kubeadm、GPU operator 支持「预装主机驱动」模式（与目标机 535 驱动兼容路径）。
- ⚠️ **不可行/制约的部分**：① 整栈必须起一个 Kubernetes 集群（每台机器一个控制面），对单卡 16GB 机器过重；② 默认引擎镜像为 CUDA 12.9（cu129），与目标机 535.274.02/CUDA 12.2 驱动的兼容性未经验证，需自建 cu122 镜像或冒烟验证；③ 项目**上线不足两周**（2026-09-27 建仓）、无任何 release/tag、全部组件 0~4 stars，生产成熟度低；④ 不负责「拉模型」，权重需预置到节点本地目录，与 agent 现有 `ollama pull` 流程不兼容；⑤ 不支持 Ollama 模型格式。

**建议接入方式**：不建议当前用整栈替换 Ollama。优先**组件级接入**——把 ModelSphere 的 `llm-openresty` 路由网关（容器化，自带 Bearer Key/会话亲和/健康检查/限流）以 Docker 方式接入现有流水线，替代/增强现有 nginx 鉴权网关，工作量约 1~2 人日；若后续演进到多机集群形态，再评估整栈（单机 PoC 3~5 人日）。

---

## 1. 调研方法与数据来源

- 直接抓取 GitHub 仓库 README、`docs/install.md`、`docs/offline-install.md`、`environments/default.yaml`、`models/examples/sglang-qwen.yaml`、`charts/vllm/values.yaml`、`charts/sglang` 相关文档、`model-catalog`（modelsphere.github.io 站点）；
- 通过 GitHub API 拉取仓库元数据（13 个组件仓库）、tags/releases、helm chart 仓库 index.yaml（chart 版本）；
- 通过 NVIDIA CUDA 兼容性官方文档、vLLM 官方文档、Docker Hub 镜像 label（`NVIDIA_REQUIRE_CUDA`）交叉验证驱动/CUDA 兼容性；
- 结合 CyberCafe 现有架构（README + deploy/aliyun + agent 流水线）做对接分析。

所有无法从公开资料确认的信息均标注 **「待验证」**。

---

## 2. 项目概况、版本与成熟度

### 2.1 项目定位

ModelSphere（modelsphere 组织，主仓库 `modelsphere/modelsphere`）定位为 **open-source LLM inference platform**：在 Kubernetes 上提供生产级模型服务。「Deploy an LLM inference stack on Kubernetes: cache-aware routing, LLM-aware autoscaling, etc.」。License：**Apache 2.0**。

核心卖点（README Highlights）：
- 智能自动扩缩容（KV-cache 压力/队列深度等 LLM 专属信号，而非 CPU/内存）；
- 质量感知动态限流（按 TTFT/输出速度等实时指标削峰）；
- 高级推理架构：Prefill/Decode 分离、统一 L3 KV cache 池；
- 异构加速器支持：NVIDIA GPU、华为昇腾、沐曦/天数智芯等，引擎集成 **SGLang 与 vLLM**；
- Workload-Driven AutoTune（预览）、In-Flight Generation Recovery（coming soon）。

### 2.2 组织与组件仓库（13 个，均为 2026-09 新建）

| 仓库 | 语言 | 创建时间 | Stars | 说明 |
|---|---|---|---|---|
| modelsphere/modelsphere | Shell | 2026-09-27 | 4 | 主仓库（Helmfile/Makefile/文档） |
| modelsphere/helm-charts | Go Template | 2026-09-21 | 1 | sglang/vllm/cart/openresty 等官方 charts |
| modelsphere/llm-openresty | Lua | 2026-09-21 | 0 | OpenResty 会话亲和路由（网关） |
| modelsphere/cache_aware_router | Rust | 2026-09-21 | 0 | CART：前缀缓存感知路由 |
| modelsphere/autoconfig | Go | 2026-09-17 | 1 | Operator：自动同步路由配置 |
| modelsphere/llm-operator | Go | 2026-09-22 | 0 | LLM 自动扩缩容 Operator |
| modelsphere/slo-scaler-decision-gen | Python | 2026-09-21 | 0 | SLO→副本数决策服务 |
| modelsphere/slo-api | Python | 2026-09-28 | 0 | SLO 读写 HTTP API |
| modelsphere/hang-watcher | Go | 2026-09-18 | 0 | 引擎假死检测 sidecar |
| modelsphere/model-catalog | HTML | 2026-09-21 | 0 | 模型目录（站点 + yaml 版本化） |
| modelsphere/llm-bench | Python | 2026-09-23 | 0 | 服务端点基准平台 |
| modelsphere/llm-autotune | Python | 2026-09-23 | 0 | 夜间自动调优 |
| modelsphere/llm-autotune-policies | Python | 2026-09-23 | 0 | 调优策略 |

### 2.3 版本现状（关键事实）

- **主仓库无任何 tag、无任何 release**（GitHub API 返回 `404: Not Found` / 空数组）；
- 版本信息只能来自 **helm chart 仓库**（https://modelsphere.github.io/helm-charts/index.yaml，快照 2026-09-29）：
  - `sglang` chart **0.8.2**（appVersion 1.0.0）
  - `vllm` chart **0.6.2**（appVersion 1.0.0）
  - `openresty` **0.1.20**、`autoconfig` **0.4.0**、`llmscaleoperator` **0.3.0**、`llm-slo-decision-gen` **0.3.2**、`bodylog` **0.1.13**、`bodylog-exporter` **0.3.1**、`cart` **0.2.2**、`rdma-injector` **0.2.3**
- **chart 迭代极快**：sglang 一周内从 0.7.0 → 0.8.2（9/21 → 9/28），说明还在高频演进、接口不稳定；
- 镜像仓库前缀为 **`4pdosc`**（Docker Hub），chart 中 CRD group 早期为 `autoscaling.4pd.io`（与 4Paradigm 强相关）→ **该平台很可能出自 4Paradigm（本团队所在公司）并刚刚开源**。此点可向项目方/内部渠道求证，作为背景信息。

> ⚠️ **成熟度判断**：项目上线 < 2 周、无正式版本、社区（stars/contributors）趋近于零、文档中仍残留旧产品名（ModelPilot/project-modelpilot 链接）、部分 chart（alert-webhook / condition2taint / llm-canary-operator）**尚未公开**。**不建议在缺乏版本锁定策略的情况下用于生产链路。**

---

## 3. 技术栈与部署形态

### 3.1 技术栈

| 层 | 组件 | 技术 |
|---|---|---|
| 路由 | llm-openresty（会话亲和 + Bearer Key + 限流 + bodylog） | OpenResty / Lua |
| 路由 | cache_aware_router (CART) | Rust |
| 路由同步 | autoconfig（Operator，ModelRoute CR → nginx/CART 配置） | Go / Kubernetes Operator |
| 伸缩 | llm-operator + slo-scaler-decision-gen（LLMScaler / LLMSLORequirement CR） | Go / Python |
| 健康 | hang-watcher（引擎假死检测 sidecar） | Go |
| 引擎 | sglang / vllm（官方 chart，引擎二进制为上游） | 上游 lmsysorg/sglang、vllm/vllm-openai |
| 可观测 | bodylog / bodylog-exporter + kube-prometheus-stack（Grafana/Prometheus） | Go/Python + 上游 |
| 编排 | helmfile + helm + helm-diff，Makefile | Shell |

### 3.2 部署形态：仅 Kubernetes

- **前置要求**：一个可用 Kubernetes 集群（≥1.25；关掉监控可降到 1.21）+ `kubectl` + helm ≥3.8 + helmfile ≥1.0 + helm-diff 插件。
- 官方完整安装路径：Ansible 节点准备（Ubuntu 22.04+）→ kubeadm 建集群 → `make helm-apply ENV=<env>` 整栈安装 → `helm install` 引擎 → Gateway 对象暴露。
- **单节点部署官方支持**：install.md 明确给出「one node、无 kube-proxy」的最小 kubeadm init（需去掉 control-plane 污点，否则 GPU POD 无法调度）。
- **没有 docker compose 全线形态**：唯一可脱离 K8s 运行的是 `llm-openresty` 单组件（`docker build` + 挂载 routes/keys 目录即可运行，见其 README「Deploying → Docker」）。
- **离线/内网部署官方支持**：`offline-install.md` 提供离线 bundle（`make offline-tools` ≈400MB 工具集 + charts + 镜像，`registryMode: rewrite|mirror` 二选一）；一个引擎镜像压缩后 **~19GB** 是 bundle 里最大头；模型权重**不在 bundle 内**，需另行预置。
- 默认环境开关（environments/default.yaml）：cilium 默认关（自带 CNI 的集群不装）、rookCeph 默认关、**监控（kube-prometheus-stack）默认开**、gpuOperator 默认开、networkOperator（RDMA）默认开、lws（LeaderWorkerSet）默认开、volcano 调度器默认开、openresty/autoconfig/llmOperator/llmslo/bodylog 默认开——**全默认约 18 个组件**，单机部署必须按需关闭。

---

## 4. 资源需求与目标机 A001-10-003 兼容性

目标机：**RTX 4080 SUPER 16GB，驱动 535.274.02 / CUDA 12.2**（机型/内存/磁盘/OS 待验证）。

### 4.1 GPU / 驱动需求

- 引擎 POD 通过 `nvidia.com/gpu` 资源申请 GPU（`model.gpus`），必须由 GPU device plugin 宣告（gpu-operator 或自备）。
- **「预装驱动」模式官方支持**：offline-install.md 明确「our clusters run a host driver（node label `nvidia.com/gpu.deploy.driver: pre-installed`, driver DaemonSet DESIRED=0）」→ **不需要 gpu-operator 装驱动，可直接沿用目标机已装的 535.274.02**。✅ 与目标机兼容。
- 目标机是单张消费级卡：设备插件 + GFD 即可，RDMA/GPUDirect 相关（networkOperator、rdma-injector、fabricmanager）**均应关闭**。

### 4.2 CUDA / 引擎镜像兼容性（重点风险）

- 两个引擎 chart 的**默认镜像均为 CUDA 12.9 系**：
  - sglang 示例：`lmsysorg/sglang:v0.5.15-cu129`
  - vllm chart 默认：`vllm/vllm-openai:latest-cu129-ubuntu2404`
- NVIDIA 官方兼容性模型（[CUDA Compatibility — Minor Version Compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)）：
  - **CUDA 12.x 全家族最小驱动 ≥ 525**，同大版本内 minor version compatibility 允许新 runtime 跑在旧驱动上，但**新驱动特性受限**（`cudaErrorCallRequiresNewerDriver`）；
  - 官方按 minor 的最低驱动表：12.2≈535.54 / 12.8≈570 / 12.9≈575~580 档（12.8/12.9 具体号**待验证**，以 CUDA Toolkit Release Notes 为准）。
- 镜像侧证据：`lmsysorg/sglang:v0.5.15.post1-cu129` 的 Docker label `NVIDIA_REQUIRE_CUDA` 声明 `cuda>=12.9 brand=unknown,driver>=535,driver<536 ...`；vLLM 安装文档指出 **CuDA forward compatibility mode 支持 R535 与 R570 主机驱动**（R535 还将最低内核降到 3.10）。
- 综合判断：**驱动 535.274.02 在 NVIDIA 兼容性模型内「理论上」可运行 cu129 容器（12.x 家族 ≥525），但存在特性受限与未验证的不确定性**。SGLang cu129 镜像还出现过缺 `nvidia-cutlass-dsl` 的实际 bug（[sglang#30856](https://github.com/sgl-project/sglang/issues/30856)）。
- **建议（安全路径）**：① 优先使用/自行构建 **CUDA 12.2/12.3 档的引擎镜像**（CyberCafe 本就自建引擎镜像，chart 的 `image` 支持任意覆盖，且离线 bundle 支持 `offline/engine-images.txt` 指定）；② 若坚持 cu129，必须先在该机器做冒烟验证（标注**待验证**）。
- 注意引擎镜像大小：**单个引擎镜像压缩约 15~19GB**，每型号一份，磁盘规划要留足。

### 4.3 显存 / 磁盘 / 内存

- **显存**：16GB 限制模型体量。官方示例模型为 Qwen2.5-0.5B-Instruct（单 GPU）；catalog（model-catalog）以数据中心卡为主（如 8×H100 / 2 节点 1.9TiB 权重等），对 16GB 单卡，能跑的量级约为 ≤7~9B（需量化/短上下文），**具体以实测为准**。
- **磁盘**：引擎镜像 ×N（15~19GB 压缩/个）+ 模型权重（每个 HF 权重目录一份，节点本地 hostPath，如 `/mnt/disk0/models/<org>/<model>`）+ K8s 组件 + 离线 bundle（如需）。无官方单机总占用基线（**待验证**）。
- **内存/CPU**：官方未给出单机最小资源数字（**待验证**）。估算（非官方）：控制面（etcd+apiserver+controller-manager+scheduler）约 2~3GB，监控栈约 1~2GB，Cilium/volcano/gpu-operator 等约 2~4GB，引擎 POD 常驻 6~16GB 级（vLLM chart 注释示例 `requests: cpu 8 / memory 64Gi`，仅示例）。`llmGateway.memoryLimit: 64Gi` 是 bodylog 的**限额**而非典型占用。**单机建议 ≥32GB 内存、≥200GB 空闲磁盘，但需实测确认**。
- 系统层要求：Ubuntu 22.04+（Ansible playbook 目标；内核 ≥5.10、cgroup v2 供 Cilium；containerd 2.3.3 需 **glibc ≥2.34**，即 Ubuntu 22.04+/RHEL9+）。目标机 OS 待验证。

---

## 5. 与 CyberCafe 现有架构的对接分析

### 5.1 CyberCafe 现状（依据仓库 README / deploy/aliyun / agent）

现有流水线：`检测GPU → 装Docker → 镜像加速 → GPU容器支持 → 拉镜像 → 启Ollama → 拉模型 → 鉴权网关(nginx Bearer sk- Key) → cloudflared 隧道 → 公网验证`。即：**单机 Docker + Ollama 引擎 + nginx Key 网关 + 快速隧道**，云端 CF Worker 管理设备与下发指令。

### 5.2 逐环节对照

| 现有环节 | ModelSphere 对应 | 结论 |
|---|---|---|
| 检测GPU | gpu-operator（支持**预装主机驱动**模式）或自备 device plugin | ✅ 兼容（目标机驱动 535.274.02 可直接沿用） |
| 装Docker | kubeadm + containerd（与 docker-ce 可共存，但**不是** docker 形态） | ⚠️ 架构变化大：每台机器多一层完整 K8s 控制面 |
| 镜像加速 | `registryMode: mirror/rewrite` + containerd `certs.d` 国内镜像仓库；离线 bundle | ✅ 支持内网/镜像仓库（已有实践） |
| 拉镜像 | helm chart 安装（引擎镜像 15~19GB/个） | ⚠️ 体积大；需国内加速 |
| 拉模型 | ModelSphere **不负责拉模型**：权重需预置到节点本地目录（HF safetensors + `modelCheck` 校验），无内置下载器 | ❌ `ollama pull` 流程不适用，agent 需新增「权重预置」步骤 |
| 引擎 | sglang / vllm 官方 chart（单节点/多节点 LWS） | ✅ 可覆盖团队「本地部署引擎（vLLM/SGLang）」目标 |
| 鉴权网关 | openresty 路由自带 **Bearer API Key**（keys 文件多 Key/轮转、`/v1/*` 强制鉴权、fail-open 并有 `/_health_status` 明示） | ✅ 与 `sk-` Key 模型天然匹配（注意配置告警防 fail-open） |
| 隧道 | openresty Service 经 NodePort/Ingress 暴露，cloudflared 指向即可 | ✅ 可用；⚠️ 路径带前缀 `/<route>/v1/chat/completions`，聊天 UI 需带前缀或网关 rewrite |

### 5.3 API 兼容性

- **OpenAI 兼容：是**。官方 Quick Start 即 `POST http://<openresty>:8080/<release>/v1/chat/completions`，body 为 OpenAI 风格（`model` + `messages` + `max_tokens`），另有 `/v1/models`；支持流式（README 提及 streaming）。
- 请求中 `model` 字段用 HF id 或 chart 配置的 servedName（如 `Qwen/Qwen2.5-0.5B-Instruct`），**不是** Ollama 风格别名。
- 网关自带会话亲和（`x-session-id` 等 6 个来源）、健康检查、并发上限（429/503）、TTFT/TPS 削峰、内容拒绝规则、bodylog——比现有 nginx 网关能力强。

### 5.4 管理面形态

- **无独立 Web UI 管理台**（开源栈内）。管理手段 = 声明式 helmfile/helm + kubectl + CR（ModelRoute / LLMScaler / LLMSLORequirement）+ **slo-api HTTP API**（读写 SLO）+ Grafana 面板。
- model-catalog 配套的 `swiss`（CLI + Web UI，负责部署表单/站点配置）在 catalog 文档中被引用，但 **`modelsphere/swiss` 仓库当前未公开**（GitHub API 查无）——**待验证**（可能随产品商业化逐步开源）。

### 5.5 已有模型仓库兼容性

- ✅ **支持 vLLM / SGLang 常规形态模型**：HF safetensors 权重目录（config.json + *.safetensors，modelCheck 校验），与团队自建 vLLM/SGLang 引擎所用的模型一致。
- ❌ **不支持 Ollama 模型**（GGUF blob / ollama model store 无 chart）；无 Ollama 引擎 chart。Ollama 的 GGUF 需转换后另配 vLLM/llama.cpp 类引擎（不在 ModelSphere 范围内）。
- ⚠️ catalog 内模型以数据中心 GPU 为主；16GB 消费卡需自行找小模型/量化版并入 catalog（或直接跳过 catalog，用 chart values 手配）。

### 5.6 可复用的「轻量路径」（重要）

`llm-openresty` 支持**纯 Docker 运行**（README「Deploying → Docker」）：`docker build` + 挂载 `routes/`（Lua 路由 conf）与 `keys/`（Key 文件）即可。**可以不装 K8s 整栈**，仅把它作为容器化网关接入 CyberCafe 现有 docker 流水线，替代/增强 nginx 鉴权网关（Bearer Key、会话亲和、健康检查、限流、bodylog 全都有，且是 Apache 2.0）。

---

## 6. 风险点

1. **成熟度/供应链风险（高）**：上线不足 2 周、无 release/tag、全部组件 0~4 stars、chart 一周内高频版本变动（0.7.0→0.8.2）、CRD API group 迁移中（`4pd.io` → `modelsphere.dev`）、部分 chart 未公开、文档残留旧名。**采用即需要锁 commit/helm chart 版本/镜像 digest，并承担演进断裂风险**。
2. **单机运维复杂度（高）**：每台机器一个 K8s 控制面（etcd/apiserver 等），升级/自愈/证书/排障面显著扩张，与「云端管+本地跑、agent 自动部署」的轻量定位冲突。
3. **CUDA 兼容性不确定（中）**：默认引擎镜像 cu129 vs 目标机 535.274.02/CUDA 12.2；理论可跑（12.x 家族 ≥525 + 镜像 label `driver>=535`），但受限/未验证 → 需自建 cu122 镜像或冒烟验证。
4. **模型接入流程改变（中）**：无内置拉模型，agent「拉模型」环节需重写为「权重预置（HF 下载→校验→hostPath）」；Ollama 存量模型不兼容。
5. **单卡收益有限（中）**：自动扩缩容、Prefill/Decode 分离、KV cache 池、多节点 LWS 等核心价值面向多副本/多机/数据中心场景，单张 16GB 消费卡几乎发挥不出来，反而背上整栈成本。
6. **监控数据易失（低-中）**：默认存储 off（emptyDir），Prometheus/Grafana 状态在 POD 重启后丢失（文档自述的已知缺省行为）。
7. **国内网络（低）**：镜像/权重下载依赖加速与镜像仓库（团队已有实践）；离线 bundle 方案可作为兜底。
8. **文档覆盖面（中）**：install/offline 文档质量高，但**没有单机最小资源基线、容量规划、SLO 运维细节**（均待验证/需实测）。

---

## 7. 建议接入方式与工作量估算

### 7.1 建议路径

- **短期（推荐）——组件级接入**：将 `llm-openresty` 以 Docker 容器形式接入现有部署流水线（镜像构建 → 挂载 keys/routes → 替换/前置 nginx 网关 → cloudflared 指向该容器端口 → 聊天 UI 适配路径前缀）。获取：Bearer Key 网关、会话亲和（配合 vLLM/SGLang 前缀缓存）、健康检查/限流/bodylog。**不改动机器形态，风险最小**。
- **中期——引擎平替**：在现有 docker 流水线中以自建 vLLM/SGLang 镜像（CUDA 12.2 档）替换 Ollama（团队「本地部署引擎」方向本就在做），路由可继续用上述 openresty 网关。与 ModelSphere 整栈解耦。
- **远期——整栈评估**：若 CyberCafe 演进到多机/多卡集群（多副本、异地、需要统一扩缩容），再评估 ModelSphere 整栈；届时顺带解决：版本锁定（chart+镜像 digest+commit）、监控持久化、升级演练、`swiss` 管理面（若已公开）。
- **若坚持现在做整栈 PoC**，按最小集安装：单节点 kubeadm（去掉 control-plane 污点）→ `enabled: kubePrometheusStack: false, cilium: false(自带 CNI 或关), networkOperator: false, lws: false, volcano: false, rookCeph*: false`，保留 `gpuOperator`（预装驱动模式）+ `openresty + autoconfig + llmOperator(可选) + sglang chart`，自建 cu122 引擎镜像，权重预置到 `/mnt/disk0/models/...`，openresty Service 暴露 + cloudflared。**先冒烟：`/v1/chat/completions` 一次成功 + Key 鉴权 401 验证**，再谈生产。

### 7.2 工作量估算

| 路径 | 工作量 | 说明 |
|---|---|---|
| 组件级：llm-openresty 容器接入（网关能力） | **1~2 人日** | 镜像构建、keys/routes 配置、cloudflared 指向、UI 路径适配、Key 轮转验证 |
| 整栈 PoC（单机最小集） | **3~5 人日** | k8s 单节点 + 最小组件 + cu122 引擎镜像 + 权重预置 + 镜像加速 + 隧道 + 冒烟 |
| 整栈生产接入 agent 流水线 | **1~2 人周** | agent deploy 指令改造、K8s 生命周期管理、模型预置逻辑、监控/告警、排障手册 |
| 多机/多卡形态 | 另计（≥2~4 周） | 集群规划、RDMA/网络、持久化、升级演练 |

---

## 8. 待验证清单（无法从公开资料确认）

1. 驱动 535.274.02 实际运行 cu129 引擎镜像（sglang/vllm）的行为——需真机冒烟；
2. ModelSphere 单机最小 CPU/RAM/磁盘基线（官方未给出）——需实测；
3. A001-10-003 的 OS 版本、CPU、内存、磁盘容量；
4. `modelsphere/swiss`（管理 CLI/Web UI）是否/何时公开；
5. CUDA 12.8/12.9 的确切 per-minor 最低驱动号（以 CUDA Toolkit Release Notes 为准，本文仅引用「12.x 家族 ≥525」与「12.2≈535.54」）；
6. ModelSphere 与 4Paradigm 的内部关系（4pdosc 镜像前缀、4pd.io CRD group 的强线索），可向内部求证以获得支持渠道；
7. catalog 中是否有适合 16GB 单卡的调优模型变体（站点检索：https://modelsphere.github.io/model-catalog/ ）。

---

## 9. 参考链接

- 项目主仓库：https://github.com/modelsphere/modelsphere （README / [docs/install.md](https://github.com/modelsphere/modelsphere/blob/main/docs/install.md) / [docs/offline-install.md](https://github.com/modelsphere/modelsphere/blob/main/docs/offline-install.md) / [environments/default.yaml](https://github.com/modelsphere/modelsphere/blob/main/environments/default.yaml) / [sglang-qwen 示例](https://github.com/modelsphere/modelsphere/blob/main/models/examples/sglang-qwen.yaml)）
- Helm Charts 仓库与版本索引：https://github.com/modelsphere/helm-charts 、https://modelsphere.github.io/helm-charts/index.yaml 、[vllm chart values.yaml](https://github.com/modelsphere/helm-charts/blob/main/charts/vllm/values.yaml)
- llm-openresty（路由网关，含 Docker 部署方式与 API Key 鉴权）：https://github.com/modelsphere/llm-openresty
- model-catalog（模型目录站点）：https://modelsphere.github.io/model-catalog/ 、https://github.com/modelsphere/model-catalog
- GitHub API 元数据（仓库/tags/releases/组织仓库列表）：https://api.github.com/repos/modelsphere/modelsphere 、https://api.github.com/orgs/modelsphere/repos
- NVIDIA CUDA 兼容性：https://docs.nvidia.com/deploy/cuda-compatibility/ 、https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html
- vLLM 安装文档（较旧驱动兼容模式 R535/R570）：https://docs.vllm.ai/en/stable/getting_started/installation/gpu/
- SGLang cu129 镜像问题：https://github.com/sgl-project/sglang/issues/30856
- Docker Hub sglang 镜像 label：https://hub.docker.com/layers/lmsysorg/sglang/v0.5.15.post1-cu129-runtime
- CyberCafe 现状：https://github.com/zcr268/cybercafe （README / deploy/aliyun / agent）