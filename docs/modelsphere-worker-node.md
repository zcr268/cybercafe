# ModelSphere 工作机（16GB 卡）单独部署引擎节点可行性 + 管理面拆分

> 调研人：CyberCafe 团队调研员
> 调研时间：2026-10-02（数据以 2026-09-29 GitHub 快照 + 2026-09-19 k3s 文档为准）
> 前置：本报告为 [docs/modelsphere-feasibility.md](modelsphere-feasibility.md)（t5）的深化篇，结论沿用其基础事实（项目定位、版本、成熟度、CUDA 兼容性判断）。
> 目标机 A001-10-003：RTX 4080 SUPER 16GB，驱动 535.274.02 / CUDA 12.2，**内存 31GB**（用户提供）。
> 新方向：**A001-10-003 仅作为「工作机/推理节点」**运行 ModelSphere 引擎；**控制面/管理面（apiserver、llm-operator、autoconfig、slo、路由网关等）部署在独立的「管理机」**上。

---

## 0. 结论先行

**有条件可行（conditionally feasible）。**

- ✅ 官方明确支持拆分拓扑：ModelSphere 文档首句即「**Any conformant Kubernetes cluster runs this stack**」，并给出纯工作节点 `kubeadm join` 的标准做法；k3s 的「server（控制面）+ agent（工作节点）」架构是官方一等公民形态，agent 最低仅需 **1 核 / 512MB**。
- ✅ 官方/NVIDIA 均支持「工作节点预装驱动 + gpu-operator 不装驱动」模式；引擎 chart（sglang/vllm）**不依赖 runtimeClassName**，靠 containerd 默认 runtime 注入 GPU——k3s 上由 gpu-operator toolkit 以 `CONTAINERD_SET_AS_DEFAULT=true` 达成，NVIDIA 官方支持 k3s 平台。
- ✅ 资源可承受：工作机常驻平台开销（k3s agent + flannel + gpu-operator DaemonSet + 引擎 POD）预估 **2~4GB 内存 / 0.5~1 核**，31GB 内存/16GB 显存的 A001-10-003 足够。
- ℹ️ **网络前提（已按用户 2026-10-02 指示从考虑项移除）**：管理机未来部署在集群内部（内网），管理机↔工作机**双向可达是既定前提**，不再验证、不再准备降级方案。附录 §10 的 PoC 清单已按此新口径精简。
- ⚠️ 沿用 t5 的成熟度风险（项目上线 <2 周、无 release/tag）与 CUDA 兼容性不确定（默认引擎镜像 cu129 vs 驱动 535，建议自建 cu122 镜像）。

**建议**：采用 **k3s 拆分拓扑（管理机=server，工作机=agent-only）** 做 PoC；真机恢复/新机器分配后按 §10 新口径清单执行，结论只需回答「部署成功没有；若失败，阻塞在哪一步（阻塞点+原因）」。

---

## 1. 调研方法与新增依据

- 本次新增抓取/检索（真实调研）：
  - ModelSphere `docs/kubeadm-cluster-init.md`（工作节点 join 的标准做法）、`docs/configuration.md`、`docs/` 目录清单（确认**无** k3s/worker 专项文档）；
  - sglang chart `values.yaml` + `templates/deployment.yaml` + `templates/_pod.tpl`（确认引擎 POD 规格：`nvidia.com/gpu` 扩展资源、**无 runtimeClassName**、nodeSelector/tolerations 可用、hang-watcher 资源 16Mi/64Mi、CART 默认 limits 4CPU/4Gi）；
  - k3s 官方文档：Requirements（agent 最低 1 核/512MB、server 2 核/2GB、端口表、反隧道说明）、Server Roles（server/agent 角色拆分）；
  - NVIDIA GPU Operator 官方文档：Platform Support（**K3s 为受支持平台**，Ubuntu 22.04 + K8s 1.33~1.37）、Getting Started（预装驱动模式、toolkit `CONTAINERD_CONFIG/CONTAINERD_SOCKET/CONTAINERD_RUNTIME_CLASS/CONTAINERD_SET_AS_DEFAULT` 配置）；
  - k3s + GPU 社区实践（otvl blog：`k3s agent -s <server>:6443` + gpu-operator `driver.enabled=false` + toolkit 指向 k3s containerd）。
- 沿用 t5 已确认事实（不再重复论证）：项目概况/版本/成熟度、cu129 vs 535 兼容性、模型格式与权重预置要求、openresty Bearer Key 网关、cloudflared 隧道适配。

---

## 2. 目标拓扑（管理面/工作面拆分）

```
┌──────────────────────── 管理机（控制面 + 管理面） ────────────────────────┐
│ k3s server（apiserver / controller-manager / scheduler / etcd 内嵌）      │
│ ModelSphere 管理组件（Deployment，nodeSelector 钉在管理机）：               │
│   llm-operator（自动扩缩容） autoconfig（路由同步） llm-slo 决策+slo-api    │
│   openresty 路由网关（Bearer Key） bodylog（日志落盘） CART（可选，按模型） │
│   kube-prometheus-stack（可选，监控）                                       │
└───────────────▲───────────────────────────────────────────────────────────┘
                │ 6443 TCP（agent→server，反隧道）  8472 UDP（flannel VXLAN 双向）
                │ 10250 TCP（kubelet 指标，双向）     └── 若 NAT 后仅出网：此三项需验证
┌───────────────┴───────────────────────────────────────────────────────────┐
│ 工作机 A001-10-003（k3s agent only = 纯工作节点）                          │
│   kubelet + containerd + flannel（k3s agent 二进制一体）                    │
│   gpu-operator DaemonSet：k8s-device-plugin / GFD / dcgm-exporter /        │
│     node-status-exporter / toolkit（nvidia runtime 设为 containerd 默认）  │
│     （driver 组件关闭——沿用预装主机驱动 535.274.02）                        │
│   引擎 POD：sglang/vllm 引擎 + hang-watcher sidecar（+ CART，可选）         │
│   模型权重：/mnt/disk0/models/<org>/<model>（hostPath，只读挂载）           │
│   ── cloudflared 快速隧道 → 公网（openresty NodePort / 引擎 Service）       │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. ① 组件归属：哪些必须控制面 / 工作节点最小需要什么

### 3.1 组件性质分析（依据安装文档与 chart）

| 组件 | 类型 | 归属判断 | 说明 |
|---|---|---|---|
| apiserver / controller-manager / scheduler / etcd | 控制面 | **必须控制面** | 任何集群都如此；k3s 由 server 内嵌，管理机承载 |
| kubelet / containerd / CNI(flannel) | 工作节点底座 | **必须工作节点** | k3s agent 一体提供 |
| gpu-operator | 集群级 Operator（Deployment + DaemonSet） | 控制器可放控制面；**DaemonSet 组件（device-plugin/GFD/dcgm/toolkit）落在 GPU 工作节点** | 官方支持按节点标签控制（`nvidia.com/gpu.deploy.operands=false` 等）；预装驱动模式 driver DaemonSet DESIRED=0 |
| 引擎 POD（sglang/vllm） | 工作负载 | **必须 GPU 工作节点** | 请求 `nvidia.com/gpu`；chart 提供 `nodeSelector` / `tolerations` / `affinity` 可钉节点 |
| hang-watcher / CART | 引擎 sidecar/子chart | 随引擎 POD（工作节点）；CART 是 CPU-only，可用 affinity 挪走 | CART 默认 limits 4CPU/4Gi（限额，非典型占用） |
| llm-operator / autoconfig / llm-slo / slo-api | Operator/Deployment | **管理面（控制面侧）** | 普通 Deployment，管理机承载 |
| openresty 路由网关 | Deployment | 管理面（控制面侧）| 需与引擎跨节点通信（flannel）；也可因网络限制移工作节点（见 §7 风险） |
| bodylog / bodylog-exporter | Deployment + 单节点落盘 | 管理面 | `llmGateway.node` + `hostPath` 指定一台机器（建议管理机） |
| kube-prometheus-stack | 监控 | 管理面（可选） | 默认 emptyDir，POD 重启丢数据 |

### 3.2 工作节点最小组成

```
k3s agent（= kubelet + containerd + flannel + kube-proxy）
+ gpu-operator DaemonSets（device-plugin / GFD / dcgm-exporter / toolkit；driver 关闭）
+ 引擎 POD（模型 chart 的 Deployment + hang-watcher sidecar）
+ 模型权重目录（hostPath 预置）
```
工作节点**不需要**：apiserver 等控制面、llm-operator、autoconfig、slo、openresty、bodylog、监控（均管理机）。llm-operator/autoconfig 的 CRD 是集群级资源，安装一次即可，不占工作节点。

---

## 4. ② 单机工作节点可行路径（多节点拓扑）

### 4.1 官方支持结论

- **ModelSphere**：`docs/kubeadm-cluster-init.md` 明示「Any conformant Kubernetes cluster runs this stack」，并给出生产形态（3 控制面 + 工作节点）：工作节点就是 `kubeadm join <endpoint> --token ... --cri-socket ...`（**不带** `--control-plane`）——**「纯工作节点加入远程控制面」是官方文档化的标准做法**。模型引擎是普通 Deployment/helm release，天然支持只调度到工作节点。
- **k3s**：官方文档（Requirements/Server Roles）定义「worker node = 运行 `k3s agent` 的机器」，join 命令 `k3s agent -s https://<server>:6443 --token ...`，agent 上只跑 kubelet/containerd/CNI——**server（管理机）与 agent（工作机）分离是 k3s 的标准形态**。且 k3s 使用**反隧道**：工作节点只需**出站**访问 server:6443 即可完成 apiserver 通道（对 NAT 后机器友好）。
- **NVIDIA GPU Operator**：Platform Support 表中 **K3s 明确列为受支持平台**（Ubuntu 22.04 + K8s 1.33~1.37），toolkit 提供针对 k3s 路径（`/var/lib/rancher/k3s/agent/etc/containerd/config.toml` + `/run/k3s/containerd/containerd.sock`）的官方配置示例（RKE2 示例即用 `/run/k3s/containerd/containerd.sock`）。
- **ModelSphere 自身无 k3s 走查文档**（docs/ 目录无 k3s/worker 专项），其安装文档以 kubeadm 为主，但 offline-install.md 已出现 k3s（airgap tarball、`k3s server --system-default-registry`、registries.yaml）→ k3s 是被认可的一种集群形态。**「ModelSphere 全栈在 k3s 上完整跑通」尚无官方验证记录（待验证，建议 PoC 第一步就是它）。**

### 4.2 两条可行路径对比

| | 路径 A：k3s（推荐 PoC） | 路径 B：kubeadm |
|---|---|---|
| 管理机 | k3s server（内嵌 etcd，1 个二进制） | kubeadm init（apiserver/etcd/…） |
| 工作机 | `k3s agent -s https://<管理机>:6443 --token …` | `kubeadm join <endpoint> --cri-socket …` |
| CNI | 自带 flannel（无需 cilium；ModelSphere 文档对自带 CNI 集群：`enabled.cilium: false` 保持默认即可） | 需自行装 CNI（ModelSphere 用 cilium，`enabled.cilium: true`） |
| kube-proxy | 有（保留） | 用 cilium 时去掉（`--skip-phases=addon/kube-proxy`） |
| 资源基线 | agent 最低 1 核/512MB；server 最低 2 核/2GB | 控制面较重（≈2~4GB 常驻） |
| 反隧道 | ✅ agent→server 仅需出站 6443 | ❌ 需双向可达 6443/10250 |
| 与 ModelSphere 官方走查贴合度 | 低（官方以 kubeadm 写文档） | 高（官方生产文档即此形态） |

> k3s 版本选择：ModelSphere 官方 kubeadm 用 K8s v1.36.3；NVIDIA gpu-operator 支持 k3s 的 K8s 1.33~1.37 → **k3s v1.36.x 与两侧都对齐**（推荐）。

---

## 5. ③ 工作节点资源占用估算（31GB 内存 / 16GB 显存可承受？）

### 5.1 常驻平台开销（估算值，需真机实测确认）

| 组件 | 内存 | CPU | 磁盘 |
|---|---|---|---|
| k3s agent（kubelet+containerd+flannel+kube-proxy 一体） | ~0.5~1.0 GB | ~0.3~0.5 核 | 镜像缓存 ~1~2 GB |
| gpu-operator DaemonSets（device-plugin/GFD/dcgm/node-status/toolkit，driver 关） | ~0.3~0.6 GB | ~0.2 核 | 少量 |
| 引擎 POD：sglang/vllm server（0.5B~7B 小模型） | ~1~3 GB（CPU 侧；权重/KV 在显存） | ~0.5~1 核 | — |
| hang-watcher sidecar | 16 MiB request / 64 MiB limit | 10m/100m | — |
| CART（可选，CPU-only） | 典型 ~0.2~0.5 GB（limits 4Gi 是上限） | ~0.2~0.5 核 | — |
| **合计（单模型）** | **约 2~4 GB** | **约 1~2 核** | **30~60 GB（含引擎镜像+权重）** |

- 31GB 内存的 A001-10-003 余量充足：平台 + 单模型后仍剩 ~25GB 以上；理论上可同时跑 2~3 个量化小模型（受显存约束，见 §6.3）。
- 磁盘：引擎镜像每型号压缩 ~15~19GB（解压 25~45GB）；权重按模型 10~40GB；加上 OS/运行时，**建议 ≥200GB SSD（待验证最终基线）**。
- CPU：估算 1~2 核常驻可承受（具体核数待验证）；大模型加载/镜像拉取瞬间会有尖峰。

### 5.2 控制面（管理机）开销（供选型参考）

- k3s server 最低 2 核/2GB；叠加 ModelSphere 管理组件（llm-operator/autoconfig/slo/openresty/bodylog ≈0.5~1GB）+ 可选监控（kube-prometheus-stack ≈1~2GB）→ **管理机建议 ≥4 核 / ≥8GB RAM**（k3s 官方：2 核/4GB 可支撑 0~350 个 agent）。

---

## 6. ④ 引擎镜像 cu129 vs 驱动 535 的兼容路径 + 16GB 显存模型量级

### 6.1 兼容路径（沿用 t5 结论 + 补充）

- **推荐路径 1（预装主机驱动模式）**：目标机已装驱动 535.274.02 → gpu-operator 用**预装驱动**模式：节点打标 `nvidia.com/gpu.deploy.driver=pre-installed`（或 `nvidia.com/gpu.deploy.driver=false`），driver DaemonSet 不部署，device-plugin/GFD 直接用主机驱动。**无需动目标机驱动，与 CUDA 12.2 主机环境一致。**（NVIDIA 官方 Getting Started「Pre-Installed NVIDIA GPU Drivers」场景；ModelSphere offline-install.md 亦说明其自有集群即此模式。）
- **推荐路径 2（自建 cu122 引擎镜像）**：默认引擎镜像 `lmsysorg/sglang:v0.5.15-cu129` / `vllm/vllm-openai:latest-cu129-ubuntu2404` 为 CUDA 12.9；驱动 535.274.02 属 CUDA 12.2 档。NVIDIA 12.x 家族 minor-version compatibility 允许 ≥525 驱动跑新 runtime 但**特性受限**；镜像 label 声明 `driver>=535`、vLLM 文档称 R535 支持 compatibility mode——**理论可跑但未验证**。稳妥做法：CyberCafe 自建 CUDA 12.2/12.3 档引擎镜像（chart `image.repository/tag` 可任意覆盖；离线 bundle 支持 `offline/engine-images.txt` 指定）。
- toolkit 配置（k3s 关键细节）：gpu-operator toolkit 需指向 k3s containerd：
  `CONTAINERD_CONFIG=/var/lib/rancher/k3s/agent/etc/containerd/config.toml`、`CONTAINERD_SOCKET=/run/k3s/containerd/containerd.sock`、`CONTAINERD_RUNTIME_CLASS=nvidia`、**`CONTAINERD_SET_AS_DEFAULT=true`**——因为 ModelSphere 引擎 chart **不含 runtimeClassName**，必须让 nvidia runtime 成为 containerd 默认，容器才拿得到 GPU。（NVIDIA 官方文档示例；具体到 ModelSphere chart 的适配**待验证**。）

### 6.2 引擎 chart 对工作节点的其他要求（已核实）

- POD 请求 `nvidia.com/gpu: 1`（扩展资源，仅 limits）；**无 runtimeClassName 字段**（见上）。
- chart 暴露 `nodeSelector` / `tolerations` / `affinity` → 可把引擎钉在工作机、并容忍工作机 taint。
- `model.localPath` 为节点本地 hostPath（权重预置；`modelCheck` init 容器校验 config.json/*.safetensors）。
- `scaler.enabled` 默认开（Custom provider → decision-gen，即管理机上的 llm-slo）——单节点部署可关 scaler 或保持（CRD 集群级，一次安装）。

### 6.3 16GB 显存可跑模型量级（估算，需实测）

| 模型量级 | BF16/FP16 | INT4/AWQ-GPTQ | 备注 |
|---|---|---|---|
| 0.5B~3B | ✅ 轻松 | ✅ | 官方示例即 Qwen2.5-0.5B |
| 7B | ⚠️ 权重≈14GB，KV cache 空间很小（短上下文可） | ✅ ≈4~5GB | 推荐量化版 |
| 8~14B | ❌ | ✅ ≈5~9GB | 14B int4 可行 |
| 32B | ❌ | ❌ ≈18GB+ 超 16GB | 不可行 |

结论：16GB 卡以**量化小模型（≤14B int4）**为主力；vLLM/SGLang 均可跑 AWQ/GPTQ。

---

## 7. ⑤ 结论、管理面拆分建议、最小拓扑、工作量与风险

### 7.1 结论

**有条件可行**。条件 = ① 管理机可用（≥4 核/8GB）；② 管理机↔工作机双向可达（**已按用户 2026-10-02 指示为内网既定前提，不再考虑**）；③ 引擎镜像换 cu122 或先冒烟 cu129；④ 接受 t5 已列明的项目成熟度风险（建议 PoC 先行）。

### 7.2 管理面拆分建议

- 管理机承担：k3s server + 全部 ModelSphere 管理组件（llm-operator / autoconfig / llm-slo / slo-api / openresty 网关 / bodylog / 可选监控）。管理组件用 `nodeSelector`/taint 钉在管理机，工作机只跑引擎。
- 工作机承担：k3s agent + gpu-operator DaemonSets（预装驱动模式）+ 引擎 POD + 权重目录 + cloudflared 隧道出口。
- 管理机成为单点（SPOF）：建议管理机做备份/快照；多管理机 HA（k3s 3-server）为后续演进项。
- Key 管理沿用 t5 结论：openresty Bearer Key 文件（sk- Key 轮转），隧道出口指向 openresty。

### 7.3 最小部署步骤（PoC 清单）

1. 管理机：装 k3s server（v1.36.x，`--token`）；工作机：`k3s agent -s https://<管理机IP>:6443 --token …`，`kubectl get nodes` 确认 Ready；
2. 管理机：`make helm-bootstrap` + `helm-apply ENV=<env>`（环境文件：`enabled: kubePrometheusStack: false, cilium: false, networkOperator: false, lws: false, volcano: false, rookCeph*: false, gpuOperator: true`，toolkit env 指向 k3s 路径 + `SET_AS_DEFAULT=true`）；
3. 工作机：打 GPU 标签（预装驱动模式），确认 `nvidia.com/gpu` allocatable；
4. 工作机：权重预置 `/mnt/disk0/models/<org>/<model>`；管理机：`helm install <model> modelsphere/sglang|vllm`（values：`image` 指向 cu122 自建镜像、`nodeSelector` 钉工作机、`modelRoute.nginx.outputConfigMap`、`service.type: NodePort`）；
5. 工作机：cloudflared 快速隧道 → openresty NodePort/引擎端口；云端聊天 UI 走 `/<route>/v1/chat/completions`（带前缀）；
6. 冒烟：`curl -H 'Authorization: Bearer <sk-Key>' http://<tunnel>/<route>/v1/chat/completions`；再验 401/限流。

### 7.4 工作量估算

| 阶段 | 工作量 | 说明 |
|---|---|---|
| k3s 拆分拓扑 + gpu-operator（预装驱动）+ 单模型引擎部署冒烟 | **1~2 人日** | 含镜像 cu122 自建/替换与权重预置 |
| 管理机管理组件（openresty/autoconfig/llm-operator/slo/bodylog）+ 网关 Key + 隧道接线 | **1~2 人日** | 沿用 t5 组件级结论 |
| agent 流水线集成（工作机 bootstrap= k3s join + 部署指令改为 helm/helmfile） | **2~3 人日** | 新增/改造部署指令与权重预置步骤 |
| 真机全链路验收（云管→隧道→网关→引擎）+ 文档 | **2~3 人日** | 按团队「真实路径红线」执行 |
| **合计（PoC→可交付）** | **约 1 人周** | 不含管理机硬件与多机 HA |

### 7.5 风险点（新增，t5 之外）

1. **网络可达性（已按用户 2026-10-02 指示从考虑项移除）**：原风险为 k3s 反隧道只保证 agent→server 的 apiserver 通道、跨节点 Pod 流量（flannel VXLAN 8472 UDP）与 kubelet 10250 需双向可达。新口径：管理机位于集群内部（内网），双向可达为既定前提，**不再验证、不降级**。本项仅保留技术备忘：若未来某工作机确实 NAT 后仅出网，原降级思路（同内网/隧道互通、flannel WireGuard、回退单机 k3s server 或 t5 容器方案）仍可参考。
2. **k3s 未被 ModelSphere 官方走查（中）**：官方文档以 kubeadm 为准；k3s 全栈跑通无官方验证记录（待验证，PoC 第 1 步即验证项）。
3. **cu129 on 535（沿用，中）**：理论可行未验证；建议 cu122 镜像或冒烟。
4. **管理机 SPOF（中）**：控制面与管理组件都在管理机；建议快照/备份。
5. **监控/日志数据易失（低-中）**：默认 emptyDir；bodylog 落盘节点需指定（管理机）。
6. **权重预置仍是手工环节（中）**：ModelSphere 无内置拉模型；agent 需新增 HF 权重下载/校验步骤。
7. **项目成熟度（沿用 t5，高）**：<2 周、无 release；锁定 chart 版本/镜像 digest 后再上生产。

---

## 8. 待验证清单

1. ~~管理机↔工作机双向网络可达性（8472 UDP / 10250）~~ —— **已按用户 2026-10-02 指示移除**（管理机在内网，双向可达为既定前提）；
2. ModelSphere 全栈在 **k3s**（v1.36）上完整跑通（含 gpu-operator toolkit `SET_AS_DEFAULT=true` 与引擎 POD 无 runtimeClassName 的适配）；
3. 驱动 535.274.02 上 cu129 引擎镜像实际行为（或直接验证自建 cu122 镜像）；
4. 工作机常驻资源实测（k3s agent / gpu-operator DaemonSets / 引擎 POD 实际 RSS 与 CPU）；
5. 16GB 显存各模型量级实测（7B 量化/14B 量化/上下文长度）；
6. A001-10-003 的 OS 版本、CPU 核数、磁盘容量（31GB 内存已知）；
7. 管理机硬件选型（推荐 ≥4 核/8GB/SSD，待最终确认）；
8. ModelSphere 官方对 k3s 的正式支持声明（当前仅能从「any conformant cluster」+ offline 文档推断）。

---

## 9. 参考链接

- ModelSphere 主仓库：https://github.com/modelsphere/modelsphere
  - [docs/kubeadm-cluster-init.md](https://github.com/modelsphere/modelsphere/blob/main/docs/kubeadm-cluster-init.md)（工作节点 join 官方做法）
  - [docs/install.md](https://github.com/modelsphere/modelsphere/blob/main/docs/install.md)（自带 CNI 集群配置、GPU 节点、污点说明）
  - [docs/offline-install.md](https://github.com/modelsphere/modelsphere/blob/main/docs/offline-install.md)（k3s 提及、预装驱动模式、engine-images）
  - [environments/default.yaml](https://github.com/modelsphere/modelsphere/blob/main/environments/default.yaml)（组件开关、gpuOperator 版本 v26.3.3）
- ModelSphere helm-charts：https://github.com/modelsphere/helm-charts
  - [sglang values.yaml](https://github.com/modelsphere/helm-charts/blob/main/charts/sglang/values.yaml)、[vllm values.yaml](https://github.com/modelsphere/helm-charts/blob/main/charts/vllm/values.yaml)、[_pod.tpl](https://github.com/modelsphere/helm-charts/blob/main/charts/sglang/templates/_pod.tpl)（无 runtimeClassName、nodeSelector/tolerations、hang-watcher 资源）
- k3s 官方：https://docs.k3s.io/installation/requirements（agent 最低 1 核/512MB、端口表、反隧道）、https://docs.k3s.io/installation/server-roles（server/agent 角色）
- NVIDIA GPU Operator 官方：https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/getting-started.html（预装驱动、toolkit env）、https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/platform-support.html（K3s 支持矩阵）
- k3s + GPU 社区实践：https://blog.otvl.org/blog/k3s-gpu-node/（`k3s agent -s` + gpu-operator driver.enabled=false + k3s containerd 路径）
- NVIDIA CUDA 兼容性（沿用 t5）：https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html
- 前置报告：https://github.com/zcr268/cybercafe/blob/main/docs/modelsphere-feasibility.md

---

## 10. PoC 验证清单（新口径，2026-10-02 用户指示精简版）

> 本节为**真机部署验证备用清单**（待队长通知真机恢复/新机器分配后执行）。
> **口径调整（用户 2026-10-02）**：① 网络可达问题不再作为考虑项——管理机部署在集群内部（内网），管理机↔工作机双向可达是**既定前提**，不验证、不降级；② 验证聚焦单一目标：**在当前机器（或真机恢复/新机器）上能否完整部署 ModelSphere**（k3s 工作机 + gpu-operator + 引擎；管理面可在管理机或同环境）；③ 最终结论只需回答：**部署成功没有；若失败，阻塞在哪一步（阻塞点+原因）**。

### 10.1 验证目标与判定标准

| 项 | 内容 |
|---|---|
| 唯一目标 | ModelSphere（k3s 工作机 + gpu-operator + 引擎）在当前真机完整部署成功 |
| 成功判定 | 引擎 POD Ready（2/2：engine+hang-watcher）+ `curl <openresty>/<route>/v1/chat/completions` 带 Key 返回正常 + `/v1/models` 可见 |
| 失败判定 | 任一步阻塞时停止，**明确报告阻塞点（哪一步）与原因**（如：k3s join 失败/GPU 不可分配/镜像拉取失败/引擎 crash/OOM 等），不继续硬闯 |
| 管理面位置 | 管理机（内网）或同环境；工作机只跑 k3s agent + gpu-operator + 引擎 |

### 10.2 精简步骤（已去除网络可达相关项）

1. **环境基线**：记录 A001-10-003 的 OS/内核/CPU/磁盘（31GB 内存、RTX 4080 SUPER 16GB、驱动 535.274.02/CUDA 12.2 已知）；确认 `nvidia-smi` 正常。
2. **集群拆分**：管理机装 k3s server（v1.36.x，记录 token/IP）；工作机装 k3s agent join（`k3s agent -s https://<管理机IP>:6443 --token …`）；`kubectl get nodes` 双节点 Ready。
3. **GPU 就绪**：gpu-operator（v26.3.3）预装驱动模式（节点标 `nvidia.com/gpu.deploy.driver=pre-installed`）；toolkit env 指 k3s containerd + `CONTAINERD_SET_AS_DEFAULT=true`；确认工作机 `nvidia.com/gpu` allocatable=1。
4. **管理面组件**：ModelSphere helm-apply 最小集（`enabled: kubePrometheusStack: false, cilium: false, networkOperator: false, lws: false, volcano: false, rookCeph*: false`，保留 gpuOperator + openresty + autoconfig + llmOperator）；openresty 网关 + Bearer Key 文件。
5. **权重预置**：工作机 `/mnt/disk0/models/<org>/<model>`（HF safetensors，modelCheck 校验 config.json/*.safetensors）。
6. **引擎部署**：`helm install <model> modelsphere/sglang|vllm`（image 指向自建 cu122 镜像或先按默认 cu129 冒烟；nodeSelector 钉工作机；service NodePort）。
7. **端到端冒烟**：cloudflared 隧道（或内网直连）→ `POST /<route>/v1/chat/completions`（Bearer Key）→ 成功；401/限流复验；记录引擎资源实测（RSS/VRAM/磁盘）。

### 10.3 阻塞点报告格式（失败时按此回报）

```
部署结果：失败
阻塞步骤：<第 N 步：名称>
阻塞点  ：<现象/错误信息原文>
原因判断：<根因分析，如 k3s join 端口/GPU 未 allocatable/镜像 digest 不兼容/OOM……>
下一步  ：<建议修复项，如换 cu122 镜像、调整 toolkit env、加内存参数……>
```

### 10.4 仍保留的待验证项（PoC 中顺带记录，不阻塞主目标）

- ModelSphere 全栈在 k3s 上完整跑通（含无 runtimeClassName 适配）；
- cu129 vs 驱动 535.274.02 实际行为（失败则换自建 cu122）；
- 工作机常驻资源与 16GB 显存模型量级实测；A001-10-003 OS/CPU/磁盘补录。

### 11. PoC 实测记录（2026-10-02，tower-zjc5pkgwm / 111.4.255.126 真机）

#### 11.1 结论

**部署成功。** ModelSphere 管理面最小集（autoconfig + openresty）+ 引擎（sglang，Qwen2.5-0.5B-Instruct）在本机 k3s 上完整跑通：

- 引擎 POD `qwen-747d7c8446-*` **2/2 Running**（sglang + hang-watcher sidecar）；
- `GET /qwen/v1/models` 返回模型清单（`owned_by: sglang, max_model_len: 4096`）；
- 带 `Authorization: Bearer sk-ms-poc-test` 调 `/qwen/v1/chat/completions` → **200 + 完整 completion**（`content:"pong"`，usage 正常）；
- 不带 Key → **HTTP 401**（鉴权生效）。

#### 11.2 实测环境（真实数据）

| 项 | 值 |
|---|---|
| 主机 | 111.4.255.126（tower-zjc5pkgwm），Ubuntu 24.04.3 / 内核 6.14 / 24C / 31GB / 408G |
| GPU | RTX 4080 SUPER 16GB，驱动 580.178.04（CUDA 13.0）——**cu129 引擎镜像原生兼容，无需自建 cu122**（§10.4 待验证项之一解除） |
| 容器运行时 | 宿主级 k3s v1.36.4+k3s1 单节点（非容器化），containerd 2.3.4-k3s1.36 |
| GPU 注入 | k3s `--default-runtime=nvidia`（宿主已装 nvidia-container-runtime）+ k8s-device-plugin v0.15.0-rc.2 DaemonSet → `nvidia.com/gpu=1` allocatable；无 runtimeClassName 的 POD 直接拿 GPU（gpu-test POD 通过） |
| 镜像 | sglang 引擎 `lmsysorg/sglang:v0.5.15-cu129`（19GB，docker save → `k3s ctr images import`）；4pdosc 管理面镜像经 `docker.1ms.run` 镜像加速拉取后导入 |
| 权重 | `/mnt/disk0/models/Qwen/Qwen2.5-0.5B-Instruct`（954MB 完整，modelCheck 校验通过），引擎 chart `model.localPath` hostPath 直挂 |
| Helm | `modelsphere/autoconfig-0.4.0`、`modelsphere/openresty-0.1.20`（key `sk-ms-poc-test`）、`modelsphere/sglang-0.8.5`，均 deployed |

#### 11.3 与 §10.2 的差异适配点（真实路径，未 mock）

1. **k3d 容器沙箱失败复盘**（PoC §10 步骤②最小验证）：
   - k3d 节点容器（rancher/k3s 镜像，alpine/musl）内挂载宿主 toolkit 后，nvidia-container-runtime（glibc 二进制）报 `fork/exec /proc/self/fd/6: exec format error`——**宿主导 glibc runc 在 musl 容器内 init memfd re-exec 失败**；k3s 自带 runc 可 `run` 但 containerd shim 的 `create` 路径同样 ENOEXEC；经 2×2 矩阵（二进制位置 × run/create 命令）与静态 runc（1.2.6 static-pie）交叉验证均失败 → 判定**容器内 OCI 运行时链（wrapper→runc）在 alpine 节点容器内不可行**。
   - 官方镜像对照实验确认问题在"自建 CUDA 基座 + 宿主工具链挂载"组合，k3s 官方镜像本身在 k3d 中工作正常。
2. **转向宿主级 k3s**（§10.2 步骤②的替代形态，更贴近生产口径）：k3s 以进程级运行（nohup，无 systemd 足迹），宿主原生 glibc 环境无上述问题，一次通过。
3. **gpu-operator 未使用**（§10.2 步骤③适配）：容器化节点内 gpu-operator 的 containerd 重启机制（systemd/hostPath 注入）不适用；采用等价渲染形态"**宿主预装驱动 + `--default-runtime=nvidia` + device-plugin DaemonSet**"。
4. **网络按用户口径不作为考虑项**：Docker Hub 直连被墙属预期外；实际经 daocloud/1ms 镜像加速 + 本地 `docker save/ctr import` 兜底；ModelRoute 等 CRD 经 `helm show crds modelsphere/llm-slo-decision-gen` 提取安装（autoconfig 控制器依赖 `LLMSLORequirement` CRD）。

#### 11.4 部署结果明细

- 命名空间：`llm-route`（管理面）、`llm-demo`（引擎）；
- POD：`autoconfig-* 1/1 Running`、`openresty-* 2/2 Running`（router + reload sidecar）、`qwen-* 2/2 Running`、`nvidia-device-plugin-* 1/1 Running`、coredns/local-path/metrics 正常；
- CRD：`modelroutes.routing.modelsphere.dev`、`llmslorequirements.inference.modelsphere.dev`；
- 生产设备（9e4eb005e463）共存验证：ollama `127.0.0.1:11434` HTTP 200、chatgw 8000 401（鉴权正常）、cloudflared 20241 存活——全程未受影响。

#### 11.5 E2E 证据（原样节选）

```
无 Key   → HTTP=401
带 Key   → {"id":"4f129d...","object":"chat.completion","model":"Qwen/Qwen2.5-0.5B-Instruct",
            "choices":[{"message":{"role":"assistant","content":"pong"}}],
            "usage":{"prompt_tokens":31,"completion_tokens":2,"total_tokens":33}}
/v1/models → {"data":[{"id":"Qwen/Qwen2.5-0.5B-Instruct","owned_by":"sglang","max_model_len":4096}]}
```

#### 11.6 遗留项（不阻塞主目标）

- `qwen-cart`（cache-aware router）POD init `wait-workers` 未就绪——路由当前由 openresty 直连引擎后端，**不影响 E2E**；待查 chart 内 init 等待逻辑（推测等 peer/ConfigMap 同步）；
- 引擎资源实测（RSS/VRAM）与 16GB 显存更大模型量级验证留待后续；
- 回滚路径：宿主 k3s 可 `kill k3s-server` + 删除 `/var/lib/rancher/k3s`、`/etc/rancher/k3s` 完全还原（未启用 systemd/开机自启）。
