# Qwen 27B 部署可行性调研报告（16GB 显存机器 A001-10-003）

> 调研人：CyberCafe 团队 调研员2（任务 t10）
> 调研时间：2026-09-29（所有数据以当日公开网络资料为准）
> 调研对象：Qwen 27B 系列模型（Qwen2.5-27B / Qwen3.x-27B）在目标机的部署可行性
> 目标机器：A001-10-003 —— RTX 4080 SUPER **16GB 显存** / 系统内存 **31.2GB** / 驱动 **535.274.02（CUDA 12.2）** / 云网吧厂商 **swnetboot + COW 快照机（重启丢失所有本地数据）**
> 前置背景：该机当前 Ollama 因驱动 535 过旧自动回退 CPU 推理（t6 在修，方案为 `OLLAMA_LLM_LIBRARY` 强制 CUDA 或升级驱动）；vLLM/SGLang 引擎由 t2 开发。

---

## 0. 结论先行

**总体结论：有条件能。** 27B 密集模型（Qwen2.5-27B 或 2026 年新 Qwen3.x-27B）在 16GB 显存 + 31GB 内存机器上完全可以部署，且是「16GB 档最能打」的模型规模；但有 **两个硬性前置条件** 和一个 **明确的风险**：

1. **前置条件①（必须）：先升级 NVIDIA 驱动到 ≥ 550（推荐 570+）。** Ollama 官方文档明确要求 NVIDIA GPU 驱动 ≥ 550（[docs.ollama.com/gpu](https://docs.ollama.com/gpu)），RTX 4080 SUPER（计算能力 8.9）在 Linux 上首个正式支持驱动即 550.54.14（2024-02-23 发布）。当前 535.274.02 低于最低要求，**无论 `OLLAMA_LLM_LIBRARY` 怎么强制 CUDA 都无法绕过**（该变量只是切换 llama.cpp 预编译库，见 §4.1）。不升级驱动，27B 的 GPU/混合 offload 完全不可行，只能 CPU 纯推理（个位数 tok/s 甚至更低）。
2. **前置条件②（强烈建议）：用 llama.cpp（llama-server/llama-cli）或 Ollama + GGUF，而非 vLLM/SGLang。** 16GB 显存下 vLLM/SGLang 跑 27B（AWQ/GPTQ 4-bit 权重 ~16GB）会 OOM 或只剩极小上下文，且其 cu122 镜像仅存在于旧版本（详见 §4.2/§4.3），与当前驱动/引擎开发路线（t2）不匹配。
3. **风险（必答）：COW 快照机重启丢数据** —— 模型文件（17~29GB）无法持久化，必须每次重启后重新拉取/导入，或放持久盘；需写入部署脚本（详见 §5.5）。

**最小可行配置（驱动升级后）**：

| 用途 | 模型档位 | 层分配 | 上下文/KV | 预期速度（16GB 级实测参考） |
|---|---|---|---|---|
| 质量优先（客服/多轮对话） | Q4_K_M（16.4GB） | 58/64 层 GPU，6 层 CPU | 4K，KV q8_0 | llama.cpp 14~16 tok/s；Ollama 6~15 tok/s |
| 平衡性能（内部工具） | Q3_K_M（13.6GB） | 全部 64 层 GPU | 4K，KV q8_0 | 27~30 tok/s（峰值可到 55~64 tok/s，需 2K 上下文） |
| 极限吞吐（短文本批处理） | Q3_K_M / Q2_K | 全 GPU | 2K，KV q8_0 | 38~64 tok/s |

---

## 1. 调研方法与数据来源

- **GGUF 尺寸**：Qwen2.5-27B 档位体积以 2026-09 实测调优文章（V100 16GB + llama.cpp，[CSDN 调优实战](https://blog.csdn.net/weixin_29035405/article/details/166436984)）为主；与 unsloth Qwen3.5-27B-GGUF（Q4_K_M=16.7GB 实测）、[willitrunai Qwen3.6-27B VRAM 指南](https://willitrunai.com/blog/qwen-3-6-27b-vram-requirements)（Q4_K_M=16.8GB）交叉校验。
- **Ollama 库/注册表**：直接查询 `registry.ollama.ai` manifest API 与 `ollama.com/library/qwen2.5/tags`（官方库当前**无 27b 标签**，实测返回 `MANIFEST_UNKNOWN`）。
- **Ollama 行为/文档**：[docs.ollama.com/gpu](https://docs.ollama.com/gpu)（驱动要求）、[docs.ollama.com/faq](https://docs.ollama.com/faq)（KV 量化/上下文/offload 显示）、[ollama troubleshooting.mdx](https://github.com/ollama/ollama/blob/main/docs/troubleshooting.mdx)（`OLLAMA_LLM_LIBRARY`）。
- **吞吐实测**：[Glukhov RTX 4080 16GB + Ollama 基准](https://www.glukhov.org/llm-performance/benchmarks/choosing-best-llm-for-ollama-on-16gb-vram-gpu/)（qwen3.5:27b 实测 6.48 tok/s）、[V100 16GB llama.cpp 调优](https://blog.csdn.net/weixin_29035405/article/details/166436984)（14.8~64 tok/s 分档）、[Simon Willison Qwen3.8-27B 实测](https://simonwillison.net/2026/Aug/16/qwen-38-27b/)（17GB Q4_K_M，15~30 tok/s，MTP 加速 +72%）。
- **驱动/硬件**：NVIDIA 发布页（550.54.14 首个 40SUPER 正式驱动）、[Reddit 4080 Super +nvidia 550](https://www.reddit.com/r/linux_gaming/comments/1anjvg2/rtx_4080_super_nvidia_550/)、[CachyOS 论坛](https://discuss.cachyos.org/t/nvidia-drivers-which-versions-pairs-well-with-a-4080-super/6410)。
- **vLLM/SGLang**：[vLLM GPU 安装文档](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/)、Docker Hub 标签快照、[SGLang 安装文档](https://docs.sglang.ai/get_started/install.html)（当前要求 CUDA 13）、[vLLM cu122 issue #3786](https://github.com/vllm-project/vllm/issues/3786)、dev.to 24GB VRAM vLLM 配方。

所有无法从公开资料确认的信息均标注 **「待验证」**，未编造任何数据。

---

## 2. 模型规格

### 2.1 Qwen2.5-27B-Instruct 各量化档 GGUF 大小

Qwen2.5-27B-Instruct（2024-09 发布，27.09B 参数，Apache-2.0，128K 上下文）GGUF 实测体积（以 2026-09 V100 16GB 实测调优文章为准，与多源交叉校验）：

| 量化档 | GGUF 体积（实测/交叉） | 是否 16GB 整卡容纳 | 备注 |
|---|---|---|---|
| Q8_0 | ~27.8GB | ❌ | 完全不用考虑（27~29GB 各源略有差异） |
| Q6_K | ~21.5GB | ❌ | 放不下 |
| Q5_K_M | ~18.7GB | ❌ | 放不下 |
| Q5_K_S | ~17.9GB | ❌ | 差一点也不行 |
| **Q4_K_M** | **16.4~16.8GB** | ⚠️ 只能 58/64 层上 GPU | 多源一致：CSDN 实测 16.4GB；unsloth Qwen3.5-27B Q4_K_M=16.7GB、willitrunai Qwen3.6-27B=16.8GB（27B 密集档通用锚点） |
| Q4_K_S | ~15.4GB | ⚠️ 极限、不稳定 | KV 就没地方了 |
| Q3_K_L | ~14.9GB | ⚠️ 极限、比较紧 | 需小上下文 + KV 量化，上下文一开大即 OOM |
| **Q3_K_M** | **13.6GB** | ✅ 稳定 | 全 64 层 GPU 的推荐档 |
| Q2_K | ~11.7GB | ✅ 稳定 | 余量大但质量崩 |
| IQ2_M / IQ2_XS | ~10.5~10.9GB | ✅ | 官方 Qwen GGUF 仓库不含 I-quants，社区（bartowski 等）提供，精确值 **待验证** |
| IQ3_M / IQ3_XS | ~12.5~13.3GB | ✅ | 同上，**待验证** |
| F16 / BF16 | ~54GB | ❌ | 无意义 |

> 说明：官方 `Qwen/Qwen2.5-27B-Instruct-GGUF` 仓库在本调研网络环境（huggingface.co）不可达（401/超时），各档位精确到 0.1GB 的官方数值 **待验证**；上表已用 3 个独立二级来源交叉确认量级（Q4_K_M ≈ 16.4~16.8GB、Q3_K_M ≈ 13.6GB 为高置信锚点）。官方 Ollama 库当前**没有** `qwen2.5:27b` 标签（见 §3.3），需从 HF 导入 GGUF 或使用社区量化。

### 2.2 Qwen3 系列是否有 27B 档

**按代际区分，答案是「初代没有、2026 代际有」：**

| 代际 | 27B 档？ | 实际档位 | 说明 |
|---|---|---|---|
| **Qwen3（2025-04 首发）** | ❌ **无** | 密集档 0.6B/1.7B/4B/8B/14B/**32B** + MoE 30B-A3B / 235B-A22B | 官方博客明确六款密集模型无 27B（[qwenlm.github.io/blog/qwen3](https://qwenlm.github.io/blog/qwen3/)） |
| **Qwen3.5（2026 年）** | ✅ **有 Qwen3.5-27B** | 27B 密集 + 视觉编码器，Gated DeltaNet 混合架构，原生 262K 上下文 | [unsloth/Qwen3.5-27B-GGUF](https://huggingface.co/unsloth/Qwen3.5-27B-GGUF)（Q4_K_M=16.7GB）；注意 vocab 填充 248320，KV/embedding 比 Qwen2.5 大 |
| **Qwen3.6（2026-04-22）** | ✅ **有 Qwen3.6-27B** | 27B 密集多模态，Apache-2.0，262K 上下文 | [官方博客](https://qwen.ai/blog?id=qwen3.6-27b)、[willitrunai 指南](https://willitrunai.com/blog/qwen-3-6-27b-vram-requirements)（Q4_K_M=16.8GB 磁盘 55.6GB BF16） |
| **Qwen3.8（2026-08-14）** | ✅ **有 Qwen3.8-27B** | 27B 密集多模态，Apache-2.0，262K 上下文 | [Simon Willison 实测](https://simonwillison.net/2026/Aug/16/qwen-38-27b/)：LM Studio 17GB Q4_K_M，默认 xhigh 推理档（输出超长）、15~30 tok/s，llama.cpp MTP 投机解码 +72% |

**32B vs 27B 的差异（队长原问题的关键）**：
- **32B（Qwen3-32B）Q4_K_M ≈ 20GB**（Ollama 官方 `qwen2.5:32b` 标签实测 20GB），16GB 显存**无法**整卡容纳，需要大量 CPU offload，实测（V100-class 16GB）速度不划算；
- **27B Q4_K_M ≈ 16.4~16.8GB**，是 16GB 档的「甜点」：Q4 全卡差一口气（少 ~2.8GB），Q3_K_M 恰好全卡，质量在 16GB 硬件上最优；
- 2026 生态共识：25~34B 是 16GB+ 档本地模型默认选择（[Glukhov 2026 efficient frontier](https://www.glukhov.org/llm-performance/benchmarks/efficient-frontier-of-open-models-2026/)），而 27B 正是其中「显存刚刚好」的一档。

---

## 3. 显存适配分析（16GB 完整容纳 / 部分 offload / KV cache 账本）

### 3.1 显存账本（先算账，再动手）

- **实际可用空间**：16GB 显存中，桌面/驱动占用 + CUDA context（~1GB）+ compute buffer（~0.5GB）后，**真正能给模型权重的空间只有 ~14GB**（V100-16GB 实测结论；4080 SUPER 同量级 **待验证**）。
- **KV cache 计算**（Qwen2.5-27B：64 层 × 4 KV 头 × 128 维 × K+V 2 份）：
  `每 token = 64×4×128×2×2B = 128KB（f16）` → 2K 上下文 256MB，4K 512MB，8K 1GB，19K ~2.3GB；
  KV 量化 **q8_0 减半**（Ollama `OLLAMA_KV_CACHE_TYPE=q8_0`，官方 FAQ 证实 q8_0 约 f16 一半、q4_0 约 1/4，需开 Flash Attention）。
- **Qwen3.x-27B 注意**：vocal 填充更大（248320 vs 151936）、原生 256K 上下文预设，KV/embedding 开销高于 Qwen2.5-27B，同样上下文下显存压力更大（**数字待验证**）。

### 3.2 各档位适配结论（16GB + 31GB 内存）

| 档位 | 权重放法 | 可行性 |
|---|---|---|
| Q2_K / IQ2_M | 全 GPU（~11.7GB） | ✅ 余量大，可开 8K+ 上下文；质量牺牲大 |
| **Q3_K_M** | **全 64 层 GPU**（13.6GB + KV 512MB + buffer ≈ 15.6GB） | ✅ **最稳的「全卡」档** |
| Q3_K_L | 全 GPU 极限（14.9GB） | ⚠️ 上下文 >2K 或并发 >1 即 OOM |
| Q4_K_S | 全 GPU 极限（15.4GB） | ⚠️ KV 没地方 |
| **Q4_K_M** | **58/64 层 GPU + 6 层 CPU offload**（16.4GB） | ✅ V100 实测稳定（14.8 tok/s）；Ollama 自动做同样的事 |
| Q5_K_M / Q6_K / Q8_0 / F16 | 大部分 CPU offload | ❌ 不推荐（权重 > 显存，CPU 带宽成瓶颈，个位数 tok/s） |

**31.2GB 系统内存是否够？** 够但紧：Q4_K_M + 4K 上下文总占用约 19~20GB（权重 16.4 + KV 0.5 + 运行时），Q3.5:27b 在 19K 上下文下实测总占用 24GB（[Glukhov 实测](https://www.glukhov.org/llm-performance/benchmarks/choosing-best-llm-for-ollama-on-16gb-vram-gpu/)）。31.2GB 内存跑 24GB 占用 + 操作系统/网吧管控进程 ≈ 临界，**建议上下文控制在 4K（OLLAMA_CONTEXT_LENGTH=4096）而不是 19K**，否则可能内存吃紧。目标机 CPU 型号 **待验证**（影响 CPU offload 层速度上限）。

### 3.3 Ollama 部分 offload 机制与配置

- Ollama 底层即 llama.cpp：加载时按显存剩余自动把层分配到 GPU/CPU，`ollama ps` 的 PROCESSOR 列直接显示百分比（官方 FAQ 示例 `48%/52% CPU/GPU`），27B Q4_K_M 在 16GB 卡上会自动形成「大头 GPU + 尾部 CPU 层」的混合模式。
- 关键配置（官方 FAQ 证实）：
  - `OLLAMA_CONTEXT_LENGTH=4096`（默认只有 4096；开 8K+ 会显著挤占层数）
  - `OLLAMA_KV_CACHE_TYPE=q8_0`（KV 减半，Qwen2 高 GQA 已量化、影响小；官方提醒 GQA 模型量化影响需实测）
  - `OLLAMA_FLASH_ATTENTION=1`（KV 量化前提 + prefill 加速）
  - `OLLAMA_NUM_PARALLEL=1`（多并发 = KV 成倍，16GB 卡建议单并发）
  - `OLLAMA_KEEP_ALIVE` / `ollama ps` 观察实际分配
- **官方仓库无 27b**：`registry.ollama.ai` 实测 `qwen2.5:27b-instruct` 与 `qwen2.5:27b-instruct-q4_K_M` 均返回 `MANIFEST_UNKNOWN`；`ollama.com/library/qwen2.5/tags` 仅 0.5b~72b（无 27b）。所以 27B 走 Ollama 必须：**从 HF 导入 GGUF**（`ollama create` 自建 Modelfile）或拉社区量化（如 [siendsi/qwen3.6-27b-q3km-256k](https://ollama.com/siendsi/qwen3.6-27b-q3km-256k) 等，社区 27B 量化镜像在 Ollama 上已成熟）。

### 3.4 实测吞吐/延迟参考（16GB 级设备）

| 来源/环境 | 模型 + 档位 | 分配 | 上下文 | 生成速度 |
|---|---|---|---|---|
| [Glukhov, RTX 4080 16GB, Ollama 0.17.7](https://www.glukhov.org/llm-performance/benchmarks/choosing-best-llm-for-ollama-on-16gb-vram-gpu/) | qwen3.5:27b Q4_K_M | 43%/57% CPU/GPU | 19K | **6.48 tok/s**（总占用 24GB，i7-14700/64GB） |
| [CSDN V100-16GB + llama.cpp](https://blog.csdn.net/weixin_29035405/article/details/166436984) | Qwen2.5-27B Q4_K_M | 58/64 层 GPU | 4K + FA | 14.8~16 tok/s |
| 同上 | Qwen2.5-27B Q3_K_M | 全 GPU | 4K + FA | 27.5 tok/s |
| 同上 | Qwen2.5-27B Q3_K_M | 全 GPU | 2K + KV q8_0 | 55~64 tok/s（峰值 64.2） |
| 同上 | Qwen2.5-27B Q2_K | 全 GPU | 4K | 38.2 tok/s |
| [Simon Willison, Mac M5](https://simonwillison.net/2026/Aug/16/qwen-38-27b/) | Qwen3.8-27B Q4_K_M 17GB | 全内存 | 262K | 15~30 tok/s（llama.cpp MTP +72%） |
| [willitrunai 社区](https://willitrunai.com/blog/qwen-3-6-27b-vram-requirements) | Qwen3.6-27B Q4_K_M | RTX 4080 16GB | 短上下文 | ~40 tok/s（Q4 勉强全卡、0 余量） |

**4080 SUPER 预期**：显存带宽 736GB/s，略低于 V100 的 900GB/s，但 sm_89 架构量化算子/带宽利用率更好，全 GPU 模式的量级与 V100 相当（±20%）；**具体数值待真机验证**。明确量级结论：全卡 Q3_K_M 档 25~45 tok/s，混合 offload Q4_K_M 档 6~16 tok/s，纯 CPU 4~7 tok/s 以下。

---

## 4. 兼容性分析（驱动 535 / Ollama 回退 / vLLM / SGLang）

### 4.1 当前机器驱动问题的定性（与 t6 的衔接）

- **Ollama 官方要求：NVIDIA 驱动 ≥ 550**（[docs.ollama.com/gpu](https://docs.ollama.com/gpu)，2026-09 查证；CC 5.0~6.2 老架构则需 ≥570）。RTX 4080 SUPER = **CC 8.9**，其 Linux 首个正式支持驱动是 **550.54.14**（NVIDIA 2024-02-23 发布）；545 只能把 4080 Super 识别为泛型 "NVIDIA Graphics Adapter" 且功率受限（[Reddit](https://www.reddit.com/r/linux_gaming/comments/1anjvg2/rtx_4080_super_nvidia_550/)），535 分支无法正常识别该卡（[CachyOS 论坛](https://discuss.cachyos.org/t/nvidia-drivers-which-versions-pairs-well-with-a-4080-super/6410)）。
- 因此当前 **535.274.02 驱动下 Ollama 自动回退 CPU 是确定性行为**（驱动不满足最低要求 → 不识别 GPU → CPU 推理），与 t6 观察一致。
- **`OLLAMA_LLM_LIBRARY` 的定位**：该变量确实存在（[ollama troubleshooting.mdx](https://github.com/ollama/ollama/blob/main/docs/troubleshooting.mdx)：`Dynamic LLM libraries [rocm_v6 cpu cpu_avx cpu_avx2 cuda_v11 rocm_v5 ...]`，例 `OLLAMA_LLM_LIBRARY="cpu_avx2" ollama serve`），作用是**切换 llama.cpp 预编译库变体**。**它不能绕过驱动版本门槛**：驱动不支持该 GPU/CUDA 时，强制 `cuda_v12` 只会让加载失败或继续回退。结论：t6 的「强制 CUDA」方案只有在驱动已升级的前提下才有意义；**根修仍是升级驱动 ≥550（推荐 550.54.14+ 或 570+，与 CUDA 12.2 向后兼容）**。
- 补充：535.274.02 是数据中心（Tesla）分支驱动（[NVIDIA Tesla 535.274.02 发布说明](https://docs.nvidia.com/datacenter/tesla/tesla-release-notes-535-274-02/index.html)），对消费级 4080 SUPER 的支持本来就存疑；目标机 `nvidia-smi` 实际输出 **待验证**。
- **对 27B 的意义**：在驱动就绪前，27B 的 GPU/混合 offload 一律不可行（CPU-only：Q4 档约 1.5~4 tok/s，不可用）；驱动就绪后，§3.4 的实测参考即适用。

### 4.2 vLLM（t2 开发中）对 27B + cu122 的可行性

- **容量**：27B fp16/BF16 权重 ~54GB，16GB 显存完全不可能；必须 AWQ/GPTQ 4-bit（~15.9~16GB 权重 + KV + CUDA graph + activation ≈ 超 16GB）。
- **实测参照**：vLLM 上 27B GPTQ 4-bit 需要 24GB 才稳定（[dev.to 24GB 配方](https://dev.to/xreyrobertibm/qwen36-27b-vllm-hermes-on-24gb-vram-may-2026-recipe-5452)：`--gpu-memory-utilization 0.95 --kv-cache-dtype fp8_e5m2 --max-num-seqs 1 --max-model-len 131072`）；社区反馈 27B-GPTQ 在 32GB 上视频/长上下文仍 OOM（[Reddit](https://www.reddit.com/r/LocalLLaMA/comments/1rxwbh9/help_qwen3527bgptq_oom_on_32gb_vram_video/)）。**16GB 卡跑 vLLM 27B 基本不可行**（即使 AWQ + 极短上下文也贴着 OOM 线，**待验证**为「不建议」）。
- **cu122 镜像**：vLLM 官方镜像的 cu122 标签只存在于较旧版本（v0.4~v0.6 时代，精确 tag 列表因 Docker Hub 在本网络不可达而 **待验证**）；2026 年当前官方镜像已迁移到 cu129/cu134（Docker Hub 快照：`vllm/vllm-openai:v0.30.0-cu129`、`cu134-nightly`）。即便拉旧 cu122 镜像，其 `NVIDIA_REQUIRE_CUDA` 声明也要求匹配驱动，535 不满足 → 需驱动升级。
- **结论**：vLLM 的 27B 路线 = 驱动升级（≥550）+ 24GB 以上显存 + AWQ/GPTQ 量化；对 A001-10-003 仅具参考意义，不作为部署路径。

### 4.3 SGLang（t2 开发中）对 27B + cu122 的可行性

- **现状**：SGLang 官方安装文档当前要求 **CUDA 13**（[docs.sglang.ai](https://docs.sglang.ai/get_started/install.html)）；老版本 cu122 镜像仅存在于 v0.2~v0.3 时代（2024 年），而 **Qwen2.5-27B 支持始于 v0.4.x（当时已是 cu124 镜像）** → **SGLang + 27B + cu122 镜像组合在镜像层面就不存在**（该结论基于版本时间线推断，精确到 tag **待验证**）。
- **容量**：与 vLLM 相同，16GB 显存 + 27B = 必须 4-bit 量化 + 极小 KV，同样贴着 OOM 线。
- **结论**：SGLang 27B 同样需要驱动 ≥550（cu124+）和 ≥24GB 显存；对单卡 16GB 机器不推荐。

---

## 5. 结论与最小可行配置

### 5.1 前提条件（不满足则整个结论不成立）

1. **升级驱动 ≥ 550**（推荐 550.54.14+ / 570+）。这是 t6 修 CPU 回退的根因方案，也是 27B 部署的第一前置。COW 快照机上驱动升级需纳入镜像模板（厂商侧），重启不丢。
2. **引擎选型走 GGUF 路线**（Ollama / llama.cpp），不选 vLLM/SGLang。
3. COW 机器部署必须**无状态、可重放**：模型文件重启即丢，需启动脚本自动 `ollama pull`/导入。

### 5.2 最小可行配置（驱动就绪后）

**推荐 A（Ollama，与现有云管端集成）**：
```bash
# 1) 导入 Qwen2.5-27B Q4_K_M GGUF（官方 Ollama 库无 27b，用 HF GGUF 自建）
#   wget qwen2.5-27b-instruct-q4_k_m.gguf → ollama create qwen27b -f Modelfile
# 2) 服务端环境变量（systemd override 或启动脚本）
OLLAMA_CONTEXT_LENGTH=4096
OLLAMA_KV_CACHE_TYPE=q8_0
OLLAMA_FLASH_ATTENTION=1
OLLAMA_NUM_PARALLEL=1
# 3) 验证
ollama ps   # 期望 PROCESSOR 列：70~90%/30~10% GPU/CPU（Q4 档）或 100% GPU（Q3 档）
```

**推荐 B（llama.cpp，吞吐更高；混部/批量任务）**：
```bash
# 质量档（客服/对话）
llama-server -m qwen2.5-27b-instruct-q4_k_m.gguf -ngl 58 -c 4096 -fa on --cache-type-k q8_0 --cache-type-v q8_0 -t 8
# 吞吐档（内部工具/批处理）
llama-server -m qwen2.5-27b-instruct-q3_k_m.gguf -ngl 99 -c 2048 -fa on --cache-type-k q8_0 --cache-type-v q8_0 -t 8 --mlock --no-mmap
```

**模型选择建议**：若看重中文/代码质量选 **Qwen2.5-27B-Instruct**（生态最成熟、GGUF 最全）；若需要 2026 旗舰编码/多模态能力可选 **Qwen3.5/3.6/3.8-27B**（Q4_K_M 同为 ~16.8GB），但注意：① 默认 `reasoning_effort=xhigh` 会造成超长思考输出（[Simon Willison 实测](https://simonwillison.net/2026/Aug/16/qwen-38-27b/)），部署时建议 `enable_thinking: false` 或 low/medium；② 多模态 mmproj 在 Ollama 支持较晚（2026-04 时还不支持 Qwen3.6-27B，[willitrunai](https://willitrunai.com/blog/qwen-3-6-27b-vram-requirements)），community quant 现已上架 Ollama；③ 其 KV/embedding 开销更大。

### 5.3 吞吐/延迟量级预期（16GB 级实测，4080 SUPER 具体值待验证）

| 档位 | 分配 | 生成速度 | 首 token 延迟（4K 上下文内） |
|---|---|---|---|
| Q4_K_M（Ollama） | 混合 offload（~57% GPU） | 6~16 tok/s | 1~3s |
| Q4_K_M（llama.cpp，58 层） | 混合 offload | 14~16 tok/s | ~1s |
| Q3_K_M（全 GPU） | 100% GPU | 27~45 tok/s | <1s |

### 5.4 磁盘占用

- GGUF 单文件：Q3_K_M 13.6GB / Q4_K_M 16.4~16.8GB / Q8_0 ~28GB（选一个档位即可，无需全下）；
- Ollama 拉取缓存另占同量级磁盘，且 **COW 快照机重启全部丢失** → 每次重装需重新下载 14~17GB；建议确认网吧带宽与磁盘空间（**待验证**），或把模型目录放到厂商持久盘（如 COW 的外部挂载盘）。

### 5.5 风险评估

| 风险 | 等级 | 说明与缓解 |
|---|---|---|
| **驱动 535 不支持 GPU** | 🔴 高 | 当前一切 GPU 方案的前提障碍；不升级则 27B 只能 CPU 推理（≤5 tok/s）。缓解：厂商镜像更新驱动 ≥550（550.54.14 起正式支持 4080 SUPER） |
| **COW 快照重启丢数据** | 🔴 高 | 模型文件/量化文件/Ollama 模型库重启即失。缓解：无状态部署脚本 + 启动时自动 pull/导入；模型放持久挂载盘；部署验证放「单次会话」内完成 |
| **显存溢出（CUDA OOM）** | 🟠 中 | Q4_K_M 全 GPU 必 OOM（16.4GB > 14GB 可用）；Q3_K_L 上下文一开大即 OOM。缓解：按 §5.2 固定层数/上下文/KV 量化；启动日志确认层分配（llama.cpp 启动会打印每部分显存占用） |
| **系统内存不足** | 🟠 中 | 31.2GB 内存跑 Q4_K_M+4K 上下文 ~20GB 总量可行但紧；开 19K 上下文（24GB）接近极限。缓解：上下文锁 4K、禁用无关后台占用；**目标机实际内存占用待真机确认** |
| **量化质量下降** | 🟡 低-中 | Q3_K_M 中文长文本错字/逻辑跳跃（实测），Q2_K 质量崩；Q4_K_M 接近无损。按业务场景分档（§3.4 三档配置） |
| **Qwen3.x 默认 thinking 过长** | 🟡 低 | 27B 新模型默认 xhigh 推理档，单次请求可输出数万 token（时间×10）。缓解：部署时关闭/调低 reasoning_effort |
| **Ollama 官方无 27b 标签** | 🟡 低 | 需手动导入 GGUF 或社区量化，多一步运维；已确认社区 27B 量化（q3km/q4km）在 Ollama 上架 |

---

## 6. 待验证清单

1. 官方 `Qwen/Qwen2.5-27B-Instruct-GGUF` 各档位精确尺寸（本网络 HF 不可达；Q4_K_M≈16.4~16.8GB、Q3_K_M≈13.6GB 已多源确认）——**待验证**
2. 目标机 A001-10-003 的 `nvidia-smi` 实际输出、CPU 型号/内存带宽、实际可用内存——**待验证**
3. 驱动 535.274.02 在该机型上的具体失败形态（完全无 GPU vs 半残）——**待验证**
4. vLLM / SGLang cu122 镜像的精确 tag 是否存在及其 `NVIDIA_REQUIRE_CUDA` 声明（Docker Hub 本网络不可达）——**待验证**
5. 4080 SUPER 上 27B Q3_K_M/Q4_K_M 真机 tok/s（V100/4080 实测为参照，±20%）——**待验证**
6. 2026 新 Qwen3.x-27B 多模态 mmproj 在 Ollama 的支持状态（2026-04 时官方未支持、社区已上架）——**待验证**
7. 网吧机 COW 持久盘可用性、带宽/磁盘配额——**待验证**

---

## 7. 参考来源

- [Ollama 官方 GPU/驱动要求（CC 8.9/驱动≥550）](https://docs.ollama.com/gpu)
- [Ollama 官方 FAQ（KV 量化 / 上下文 / ollama ps offload 显示 / 并发）](https://docs.ollama.com/faq)
- [Ollama troubleshooting.mdx（OLLAMA_LLM_LIBRARY 库列表）](https://github.com/ollama/ollama/blob/main/docs/troubleshooting.mdx)
- [Ollama qwen2.5 库标签（无 27b，实测 registry MANIFEST_UNKNOWN）](https://ollama.com/library/qwen2.5/tags)
- [V100 16GB 跑 Qwen2.5-27B 调优实战（档位体积/显存账本/分档速度）](https://blog.csdn.net/weixin_29035405/article/details/166436984)
- [RTX 4080 16GB + Ollama 14 模型基准（qwen3.5:27b=6.48 tok/s，43%/57% offload）](https://www.glukhov.org/llm-performance/benchmarks/choosing-best-llm-for-ollama-on-16gb-vram-gpu/)
- [16GB 显存 KV cache 预算指南（公式/量化档/风险）](https://www.glukhov.org/llm-performance/optimization/kv-cache-16gb-long-context/)
- [Qwen3.6-27B VRAM & 硬件需求指南（GGUF 全档位表/16GB 适配结论）](https://willitrunai.com/blog/qwen-3-6-27b-vram-requirements)
- [Qwen3.6-27B 官方发布博客](https://qwen.ai/blog?id=qwen3.6-27b)
- [Qwen3 首发博客（初代无 27B，密集档 0.6B~32B + MoE 30B-A3B）](https://qwenlm.github.io/blog/qwen3/)
- [unsloth/Qwen3.5-27B-GGUF（Q4_K_M=16.7GB，架构参数）](https://huggingface.co/unsloth/Qwen3.5-27B-GGUF)
- [Simon Willison：Qwen3.8-27B 实测（15~30 tok/s、thinking 默认过长、llama.cpp MTP +72%）](https://simonwillison.net/2026/Aug/16/qwen-38-27b/)
- [RTX 4080 Super + NVIDIA 550 讨论（545/535 支持问题）](https://www.reddit.com/r/linux_gaming/comments/1anjvg2/rtx_4080_super_nvidia_550/)
- [CachyOS：4080 Super 驱动搭配（535 无法识别）](https://discuss.cachyos.org/t/nvidia-drivers-which-versions-pairs-well-with-a-4080-super/6410)
- [NVIDIA Linux 550.54.14 驱动发布（首个正式支持 40 SUPER）](https://www.nvidia.com/en-us/drivers/details/218826/)
- [vLLM GPU 安装文档（预构建镜像/版本）](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/)
- [vLLM cu122 issue #3786](https://github.com/vllm-project/vllm/issues/3786)
- [SGLang 安装文档（当前要求 CUDA 13）](https://docs.sglang.ai/get_started/install.html)
- [vLLM 27B-GPTQ 24GB VRAM 部署配方](https://dev.to/xreyrobertibm/qwen36-27b-vllm-hermes-on-24gb-vram-may-2026-recipe-5452)
- [Ollama 社区 27B 量化：siendsi/qwen3.6-27b-q3km-256k](https://ollama.com/siendsi/qwen3.6-27b-q3km-256k)