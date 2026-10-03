# Strata 本地大模型运行时部署可行性调研报告（目标机 A001-10-003）

> 调研人：CyberCafe 团队 调研员2（任务 t21，用户 2026-10-02 指派）
> 调研时间：2026-10-03（数据以当日 GitHub 仓库 main 分支 + 发布 API 快照为准；仓库已只读克隆至 /tmp/cybercafe-strata）
> 调研对象：https://github.com/Niko1221/Strata（README / docs/INSTALL.md / MODELS.md / MCP_SERVER.md / COMMUNITY_BENCHMARKS.md / HOW_IT_WORKS.md / DETAILS.md / setup.py / serve/server.py + GitHub API + 社区实测文章交叉验证）
> 目标机器：A001-10-003 —— RTX 4080 SUPER **16GB 显存** / 系统内存 **31.2GB** / 驱动 **580.178.04（CUDA 13.0）** / Ubuntu 24.04.3 / 内核 6.14 / 磁盘 **408GB 可用** / 云网吧厂商 swnetboot+COW 快照机（重启丢数据）
> 背景衔接：t10 报告时该机驱动为 535.274.02（Ollama 官方要求 ≥550 而回退 CPU）；**本次驱动已升级至 580.178.04/CUDA 13.0，恰好满足 Strata 的 `MIN_DRIVER = 580`（CUDA 13.0）要求**，驱动门槛已解除。

---

## 0. 结论先行

**总体结论：有条件可部署（仅限 Coder 档，作为独立形态的第 4 引擎/备选引擎），且存在「中文弱」与「COW 重启重装」两个硬伤需要明确接受。**

Strata 是一个 **专为 Qwen3.8-Flash-Next（125B MoE）定制的本地推理运行时**（非通用引擎）：通过「GPU 缓存高频专家 + RAM 驻留全部专家 + SSD 查表」把 125B MoE 模型压进 12–24GB 显存 + 32–64GB 内存的消费机。**它不是通用引擎，只跑这一个模型家族（原版/Coder/Swift 1.5/Unsloth 4bit 四个版本）**，OpenAI/Anthropic 兼容 API、浏览器 UI、MCP server 一应俱全。

在 A001-10-003（16GB 显存 + 31.2GB 内存 + 驱动 580 + 408GB 磁盘）上：

- ✅ **满足**：驱动（580 ≥ MIN_DRIVER 580）、显存（16GB ≥ 12GB 下限）、磁盘（408GB ≥ ~66GB 需求）、OS（Ubuntu 24.04 自动安装）。
- ⚠️ **内存恰好踩线**：Strata 官方口径「32GB 内存门槛」；31.2GB 物理内存对 **Coder（IQ1_M）** 是「tight」（setup.py 判定：`31.2 < 32 = ram_gb`），但 setup 的 **low-RAM（resident）模式可容纳**（专家拆分：约 11GB 上 GPU、约 12.4GB 驻留 RAM，引擎常驻内存从 36GB 降到 ~13GB，实测同一答案）。其余全部档位（Q2_0/IQ2_XS/IQ3_XXS/IQ3_S 需 48/48/60/62GB RAM）**在 31.2GB 上不可行**（除强制 low-RAM 从 SSD 读专家、速度大幅下降并需 24GB 级显卡的路径，不推荐）。
- ❌ **Coder 的硬伤：中文/CJK 弱**（官方 issue #438：中文回答错误/循环，英文正常——因 Coder 只保留 512 专家中的 256 个、按代码数据挑选）。**对本项目中文为主的云网咖场景，这是最需要评估的取舍点**；若必须中文且要全量专家，需 48GB+ 内存（该机不满足）。
- ❌ **COW 快照机重启丢数据**：Strata 模型数据（`Strata-data`，Coder 约 58.4GB 下载 + 6GB MTP 草稿层 + 1GB 视觉）默认放在安装目录旁，重启即失，**每次启动需重装/重下 ~66GB**（或把 `--data-dir` 指向持久挂载，是否存在持久挂载**待验证**）。
- ⚠️ **单并发**：官方明确「一次只回答一个请求」（单槽位），多客户端排队——与云网咖多用户并发需求冲突，只能作单会话/单代理后端。

**最小可行配置（若接受上述取舍）**：`Coder (IQ1_M)`，`--context 32768`（或按 16GB 卡建议），`--vision no`（省 0.9GB 下载与显存），low-RAM resident 自动开启，`--port 8081 --api-key <secret>`，`--host 0.0.0.0` 后置于现有 nginx Key 网关 + cloudflared 隧道之后。预期（参照 RTX 5070 12GB 实测 + 4080 SUPER 16GB 更多显存）：**输出 ~40–70 tok/s、prompt 读取 ~1.5–2.2K tok/s、4K prompt 首字延迟 ~2–4s**（真机值待验证）。

**建议**：Strata 作为「代码/英文强项」的备选引擎值得在 t2 引擎层登记支持（OpenAI 兼容，接入成本低），但**不建议**作为云网咖中文主力引擎——中文弱 + 单并发 + 每次重启 66GB 重装的组合，对多用户中文场景不利；主力仍建议 t10 调研的 Qwen2.5-27B/Ollama 路线。

---

## 1. 调研方法与数据来源

- **仓库本体**：只读克隆 `Niko1221/Strata@main`（快照 2026-10-03），通读 README、docs/INSTALL.md、MODELS.md、MCP_SERVER.md、COMMUNITY_BENCHMARKS.md、HOW_IT_WORKS.md、DETAILS.md（"Speed (measured)"、"Which model"、"Using it" 章节）；读 setup.sh 与 setup.py 关键逻辑（MODELS 表、`low_ram_*` 判定、`MIN_DRIVER=580`、模型推荐与 RAM 判定）；读 serve/server.py 的 API key/Host 处理；读 bench/results/ 下的官方与社区测量报告。
- **GitHub API**：仓库元数据（创建时间 2026-09-24、7033 stars/626 forks/127 issues、MIT）、release 列表（v0.1.0→v0.1.38，最新 2026-10-03）。
- **社区实测**：[note.com 两天安装实录（RTX 5090/Linux）](https://note.com/zephel01/n/nce0d0c3328cd)、Reddit（[Strata is amazing](https://www.reddit.com/r/LocalLLM/comments/1wv6fwi/strata_is_amazing/)、[12GB VRAM 65 tok/s](https://www.reddit.com/r/LocalLLaMA/)）、[Trendshift 快照](https://trendshift.io/repositories/259708)。

所有无法从公开资料确认的信息均标注 **「待验证」**；未编造任何数据。

---

## 2. 项目全貌（问题①）

| 维度 | 事实（已核实） |
|---|---|
| 定位 | 在消费级 PC 上运行 **Qwen3.8-Flash-Next（125B 参数 MoE）** 的本地推理运行时：`Run a 125-billion-parameter AI model on your own gaming PC`（README） |
| 引擎实现 | **专用引擎**（非通用）：为 Qwen3.8-Flash-Next 架构重写 CUDA kernel（社区实测证实"专用才快"）；NVIDIA 走 CUDA、AMD 走 HIP（同一引擎分别编译）；内置 llama.cpp/ggml 部分（MIT）；模型侧「MTP 草稿层」投机解码 1.6–1.8×、long-prompt 批量读取 >1K tok/s |
| 运行机制 | MoE 24,576 专家：GPU 缓存高频专家（按对话自适应），RAM 驻留全部专家，SSD 28.8GB n-gram 查表；显存不够时 low-RAM 模式（专家从文件映射/SSD 读） |
| 技术栈 | Python 3.10+（.venv 私有环境）+ C++ 引擎 + CMake 构建；setup.py（220KB）负责安装/下载/打包/启动；serve/server.py 提供 HTTP API；浏览器 UI（Chat/Monitor/About） |
| 开源/商用 | **MIT License**（仓库自身）；模型文件不在仓库内，各自许可（Qwen3.8-Flash-Next 卡页为 Apache-2.0，**待验证**细节；ISTA-DASLab GGUF 压缩版、UkisAI Swift 1.5、Unsloth 4bit 各有许可） |
| 成熟度 | **极新且高速迭代**：首提交 2026-09-24（调研时仅 9 天），一周 230+ commits，38 个 release（v0.1.0→v0.1.38，最新 2026-10-03），7033 stars/626 forks/127 open issues；文档随版本每日变动（社区：2 天内引擎 0.1.24→0.1.27）——**功能可用但生产稳定性属「观察期」**，升级需走 `./setup.sh`（不能只 git pull，见 §4） |
| 版本形态 | GitHub release 提供 Windows zip（cuda 版 124MB / hip 版 599MB）；Linux 走 git clone + setup.sh（引擎按需下载预编译版或本地编译） |

**模型家族（Strata 只跑这个家族）**：

| 版本 | 说明 | 许可注意 |
|---|---|---|
| 原版 Qwen3.8-Flash-Next（Q2_0/IQ2_XS/IQ3_XXS/IQ3_S） | 全 512 专家/层，4 个量化档 | Qwen/ISTA-DASLab 各自许可 |
| **Coder（IQ1_M）** | 只留 256/512 专家（按代码数据挑选），SWE-bench 91% 得分；**中文/CJK 弱（#438）** | ISTA-DASLab |
| Swift 1.5（UkisAI 微调） | 思考更短、回答更快，无 IQ3_S | UkisAI 许可 |
| Unsloth UD-Q4_K_XL（实验） | 4bit 全量，111GB 下载、77GB 专家需 SSD 流式读，7–8.5 tok/s，需 48GB+ RAM + NVMe | Unsloth |

---

## 3. 目标机适配（问题②）

### 3.1 各档位模型体积 / 显存+内存需求（setup.py `MODELS` 表，实测核实）

| 档位 | 下载体积 | 官方 RAM 需求（ram_gb） | 专家驻留（arena_gb） | 31.2GB 机器判定（按 setup 公式） |
|---|---|---|---|---|
| **Coder (IQ1_M)** | **58.4GB** | **32GB** | 23.4GB | ⚠️ **tight**（31.2<32），low-RAM resident 可容纳（见 3.2）——**唯一可行档** |
| Q2_0 | 66.4GB | 48GB | 34.0GB | ❌ 不可行（缺 16.8GB；low-RAM 需 24GB 级显卡） |
| IQ2_XS | 68.0GB | 48GB | 35.5GB | ❌ 同上 |
| IQ3_XXS | 75.8GB | 60GB | 42.9GB | ❌ 不可行 |
| IQ3_S | 83.6GB | 62GB | 50.3GB | ❌ 不可行（官方：需 64GB 内存且少开程序） |
| UD-Q4_K_XL（实验） | 111.3GB | 48GB（预算式） | 77.0GB | ❌ 需 48GB+ RAM + NVMe |

另：首次启动还需下载 **MTP 草稿层 ~6GB**（+ 视觉编码器 0.9–1GB，若开启）；Q2_0 在 AVX-512 CPU 上会额外写一次性 ~40GB 专家副本（Coder 无此项）。磁盘总计：Coder ≈ 58.4 + 6 + 1 = **~66GB**（README 建议预留 ~80GB）→ 408GB ✅。

### 3.2 31.2GB 内存 vs 32GB 门槛：Coder 恰好踩线，靠 low-RAM 模式容纳

setup.py 的判定逻辑（已逐行核实）：

- `low_ram_needed(model, ram)`：`ram < arena_gb + 10` → Coder 需 `23.4 + 10 = 33.4GB` → **31.2 < 33.4，low-RAM 模式会被启用**；
- `low_ram_resident(model, ram, vram)`：`ram ≥ (arena − GPU 专家数) + 10`。16GB 显存下 GPU 可缓存专家 ≈ `min(23.4, 16−5) = 11GB`，其余 `12.4GB` 驻留 RAM；`12.4 + 10 = 22.4 ≤ 31.2` → **resident（专家留在 RAM、稳态内存占用）成立**；
- setup 的 `--check` 结论格式：`fits in the low-RAM mode (the GPU holds ~47% of its experts, the rest stays in RAM)`；
- 官方文档量化：**「On the Coder the engine's committed memory drops from 36 to ~13 GB, with the same answers」**——normal 模式 Coder 要占 ~36GB RAM（31.2GB 物理内存会分页，几乎不可用），**low-RAM resident 模式 ~13GB 常驻**，31.2GB 下可用。
- 16GB 显存的预算：11GB 专家缓存 + attention/DeltaNet + KV（int8，>4K 上下文时）+ MTP 头（~180MiB）+ 默认 700MiB `--vram-reserve-mib` 预留 → 16GB 贴满但这是官方设计的 12GB 卡场景的放大版，可行；若同时跑浏览器/其他 GPU 程序需 `--vram-reserve-mib 2048`（实测经验）。

**结论：31.2GB 内存够 Coder 档（低 RAM 模式），不够任何全量专家档。** 若要全量专家且保中文质量，需 ≥48GB 内存（该机不满足）。

### 3.3 预期 tokens/s 与首字延迟

官方/社区实测（均为相同 Qwen3.8-Flash-Next 家族，RTX 5070 12GB + Ryzen 5 7600 + 64GB RAM，引擎 0.1.26 一档跑分）：

| 档位 | 写答案 tok/s（短聊/128K） | 读 prompt tok/s（4K/32K） |
|---|---|---|
| Q2_0 | 87–94 / 74–76 | 1,299 / 2,107–2,171 |
| IQ2_XS | 79 / 63 | 1,256 / 1,752–2,092 |
| IQ3_XXS | 62 / 49 | 1,007 / 1,602–1,745 |
| IQ3_S | 53 / 46 | 913 / 1,443–1,624 |
| **Coder** | **55–59 / 43–53** | **1,583 / 2,177–2,236** |

- 社区补充：RTX 5090+IQ2_XS（64GB RAM）= 解码 165–179 tok/s；RTX 5090 32GB+128GB RAM 实测 114 tok/s（400 token 代码生成，MTP 接受率 71%）、短问题 0.4s 返回；12GB VRAM 档社区报 65 tok/s。
- **4080 SUPER（16GB，sm_89）预期**：显存比 RTX 5070 12GB 多 4GB → 专家缓存更多（~11GB vs ~7GB），带宽 736GB/s、算力更高，**输出估计 ~40–70 tok/s、prompt ~1.5–2.2K tok/s、4K prompt TTFT ~2–4s、短问题 <1s**；CPU 侧（RAM 驻留专家由 CPU 计算）依赖机器 CPU 型号/AVX2/AVX-512——目标机 CPU **待验证**，若 CPU 较弱输出会下降。
- 语言影响：MTP 草稿层自 0.1.27 起**包含全部中日韩 token（106,299 个）**，中文回答提速 15–38%（但 Coder 模型本身中文弱的问题依旧，那是专家裁剪问题，不是草稿层问题）。

### 3.4 COW 快照机重启丢数据的影响

- Strata 数据全部落在安装目录旁的 `Strata-data/`（models/ + packs/ + mtp/，Coder ~66GB）；重启即失（COW 快照回滚）。
- 影响：**每次重启需重跑 `./setup.sh --yes` 重新下载 ~66GB + 打包转换（约 2 小时，视带宽）**，或把 `--data-dir` 指向持久挂载（目标机是否存在持久挂载**待验证**）。
- 与 t10（Ollama 27B，~17GB）相比，Strata 的单次重装成本高 4 倍，且打包转换（pack）耗时不短。
- 无状态化建议：启动脚本 = `git clone → ./setup.sh --yes（非交互）→ 启动`；若网络带宽有限，优先把 `Strata-data` 放持久盘。

---

## 4. 部署形态（问题③）

**setup.sh 装什么（逐行核实）**：
1. 检查 Python 3.10+（缺则 `sudo apt install python3 python3-venv python3-pip`，Ubuntu 24.04 自带 3.12 一般免 sudo）；
2. 建 `.venv`（私有，不动系统 Python；实测 .venv 约 205MB）；
3. 引擎：NVIDIA 用**预编译 ready-made 引擎**（RTX 20/30/40/50）+ NVIDIA CUDA 库（pip，~0.4GB）；无匹配卡才提示本地编译（20–40 分钟，需 build-essential+CUDA）；
4. 下载模型 GGUF（HF，pinned revision + 校验；Coder 58.4GB）+ MTP 草稿层（~6GB）+ 可选视觉编码器（0.9–1GB）→ 打包转换（pack）→ 写入 `strata-<model>.json` 配置；
5. 生成 `run-<model>.sh` 启动脚本（内容即 `python -m serve.server --engine strata --config strata-<model>.json --port N`）。

**联网/离线**：
- **首次安装必须联网**（HF 下载权重）；下载可断点续传（"you can stop and it continues where it left off"）；
- **离线/镜像路径**：官方支持 ① `HF_ENDPOINT=https://hf-mirror.com`（国内镜像，pinned revision 与校验不变）；② `--gguf-dir <已有 GGUF 目录>` 直接使用预下载文件（如 `Strata-data/models/IQ1_M/`）；③ 模型文件按原文件名放入 `Strata-data/models/<SIZE>/` 即可被识别（INSTALL.md #495）。→ **可在有网络的机器预下载后拷入，或走 hf-mirror**；
- 运行期无需联网（模型已本地化）；`update.sh` 更新才需联网。

**安装足迹**：Strata 文件夹（.venv 205MB + engine/ + third_party/）+ 相邻 `Strata-data/`（66–120GB）+ `~/.config/strata/settings.json`（数据目录指针）；**无 systemd 服务、无系统级常驻**（前台进程，`run-<model>.sh` 启动，Ctrl+C/SIGINT 停止并清理引擎）；端口默认 **8080**（`--port` 可改，实测社区因占用改用 8082）。部署为服务需自行套 systemd/tmux/supervisor 包装。

---

## 5. 接入评估（问题④）

**API 兼容性（serve/server.py + DETAILS.md 核实）**：

| 能力 | 端点 | 备注 |
|---|---|---|
| OpenAI Chat Completions（流式+非流式+tools） | `POST /v1/chat/completions` | 任意 API key 与 model 名；`reasoning_effort: none/low/medium/high`；`reasoning_budget_tokens` 可硬限思考；默认 thinking=high（社区实测思考可吃满 16K+ token，需调高输出上限） |
| Anthropic Messages（流式+thinking blocks） | `POST /v1/messages` | Claude Code 用 `ANTHROPIC_BASE_URL` 直连 |
| 模型列表/健康 | `GET /v1/models`、`/models`、`/health` | Docker 版有 HEALTHCHECK 于 `/health` |
| 状态/监控 | `GET /status`、`/slots`、`/metrics`、`/props` | 单槽位 busy/idle、实时 token 数 |
| MCP | `GET /mcp` | 见下 |

- 流式响应带 **`X-Accel-Buffering: no`**（官方文档明确 "nginx-style proxies pass each token on at once"）→ 现有 nginx Key 网关 + cloudflared 隧道可直接套用；走公网必须设 API key（`--api-key <secret>` 或 `STRATA_API_KEY` 环境变量），有 Host 校验（api_key 开启后关闭）与 CORS（默认关，需 `cors_origins` 配置）——安全模型与现有网关兼容。
- **接入形态结论：独立形态（standalone server on :8081），而非 Ollama 式引擎插拔**。Strata 有自己的启动/更新流程与单模型、单并发语义，无法进 Ollama 的模型列表；作为「第 4 引擎」在 agent 部署流水线中应作为独立 systemd 服务，由 nginx 按 upstream（`/v1/chat/completions → strata:8081`）转发，cloudflared 隧道同现有链路。
- **单并发限制**（重要）：一次一个请求，多客户端排队（社区实测确认）；与云网咖多用户并发模型冲突 → 只适合单会话/单代理（如一个 coding agent 实例）或排队式批处理。
- **MCP server 两种用途（勿混淆）**：
  1. `tools/strata_mcp.py`：给外部 AI 助手（Claude Code/Cursor/Codex）用的 MCP，让助手**安装/启动/停止/测速/查日志**管理 Strata（stdio，标准库，Python 3.10+）——适合我们把 Strata 纳入自动化运维；
  2. `serve/mcp.py`：让 **Strata 模型自己调用外部 MCP 工具**（在聊天页里）——即 Strata 作为 agent 后端时可接工具调用，与 CyberCafe agent 流水线（工具调用型）互补。

---

## 6. 性能测量口径（问题⑤，为后续真机实测做准备）

**官方定义（README/MODELS.md/DETAILS.md 核实）**：
- **"Writes answers"（写答案 tok/s）= 解码吞吐（decode/output throughput）**：回答生成速度，短聊一档、128K 上下文一档；一个 token ≈ ¾ 个词；**随文本浮动**（MTP 投机接受率影响几个百分点），同 prompt 换一次答案可能差几个 tok/s。
- **"Reads your prompt"（读 prompt tok/s）= 提示处理吞吐（prompt processing throughput）**：官方在 32K-token prompt 上测（4K prompt 为 910–1,580 tok/s）；"a 32K prompt takes about 15 seconds with Q2_0"。
- **TTFT（首字延迟）**：官方测量口径 = 「从发送请求到第一个生成 token 的秒数」；流式 API 测量时**忽略 keep-alive 与空 delta**，并注明第一个 token 是思考（reasoning）还是答案文本（COMMUNITY_BENCHMARKS.md）。
- 官方基准方法（bench/results/2026-09-29-speed-0126）：单发、固定 256 个生成 token、greedy、无计时标记、图像关、8-bit KV；每配置至少 3 次取中位数+区间（社区模板要求）；**不要**用「生成 token 数 ÷ 总耗时」当解码吞吐（混入 prefill）。

**实用测量方法（可直接用于真机）**：
```bash
# ① 解码吞吐（输出 tok/s）：流式请求 + 客户端计时（首 chunk 前为 TTFT）
time curl -N http://127.0.0.1:8081/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"strata","stream":true,"reasoning_effort":"none","messages":[{"role":"user","content":"<短 prompt>"}],"max_tokens":256}' \
  -o /dev/null   # 由返回 token 数/耗时换算；TTFT = 到首个 data: chunk 的时间
# ② 读 prompt 吞吐：长 prompt（如 32K token 文档）+ 流式，记录引擎日志的 prompt 处理时间行（官方取引擎计时输出）
# ③ 长期限测试：python tools/needle_bench.py --url http://127.0.0.1:8081 --lengths 32k,128k --depths 10,50,90
# ④ MCP 自带测速：strata_benchmark（短固定请求、greedy、thinking off，返回输出/输入 tok/s）
```
注意：单并发排队影响延迟；预热（专家缓存/前缀缓存）与冷启动（加载 ~1–3 分钟，首启更久）分开记录；显存/内存记录区分启动快照与推理峰值（社区模板要求）。

---

## 7. 结论与最小可行配置（问题⑥）+ 风险与工作量

### 7.1 判定：**有条件可部署**

| 条件 | 状态 |
|---|---|
| 驱动 580.178.04 ≥ MIN_DRIVER 580（CUDA 13.0） | ✅ |
| 显存 16GB ≥ 12GB 下限；4080 SUPER=sm_89 在预编译引擎覆盖（RTX 40 系） | ✅ |
| 磁盘 408GB ≥ ~66GB（Coder） | ✅ |
| OS Ubuntu 24.04（自动装依赖） | ✅ |
| 内存 31.2GB 对 Coder（32GB 门槛） | ⚠️ tight，但 **low-RAM resident 模式可行**（常驻 ~13GB） |
| 中文/CJK 场景 | ❌ Coder 中文弱（#438）；全量档需 48GB+ 内存，本机不可行 |
| 多用户并发 | ❌ 单并发（一次一个请求） |
| COW 重启持久性 | ❌ 需每次重装或 `--data-dir` 到持久盘（待验证） |

### 7.2 最小可行配置（若接受取舍后部署）

```bash
# 1) 部署（无状态脚本，建议 systemd 包装）
git clone https://github.com/Niko1221/Strata.git /opt/strata
cd /opt/strata
./setup.sh --check                              # 先体检（确认 low-RAM 判定与推荐）
./setup.sh --family coder --model IQ1_M \
  --context 32768 --vision no --port 8081 \
  --host 0.0.0.0 --api-key <secret> --yes --no-start
# 2) 启动（run-coder-iq1_m.sh），验证
curl http://127.0.0.1:8081/v1/chat/completions -d '{"model":"strata","messages":[{"role":"user","content":"hi"}]}'
# 3) 网关：nginx upstream → 127.0.0.1:8081（/v1/*），cloudflared 隧道同现有链路；流式 X-Accel-Buffering: no 已兼容
# 4) 运维：update = ./setup.sh（不能只 git pull，引擎需经 setup 更新；third_party/llama.cpp pinned commit 变了要删了重拉）
```
关键参数：`--context` 建议 32K（16GB 卡官方建议档；KV 用 int8 默认，>64K 自动 KV streaming）；`--vision no`（省 1GB 下载+显存）；`--vram-reserve-mib 2048`（若同机还跑别的 GPU 程序）；`--reasoning_budget_tokens` 或客户端 `reasoning_effort: none/low`（默认 high 思考超长，社区实测单次思考可超 16K token）。

### 7.3 风险清单

| 风险 | 等级 | 说明/缓解 |
|---|---|---|
| Coder 中文弱（#438） | 🔴 高 | 中文回答可能错误/循环；英文/代码强。缓解：中文场景回退 Ollama 27B（t10），Strata 只用于代码/英文任务 |
| COW 重启丢 ~66GB | 🔴 高 | 每次重启重下/重打包 ~2h。缓解：`--data-dir` 持久挂载（待验证）、预下载镜像包离线拷入、HF_ENDPOINT=hf-mirror |
| 项目迭代过快（9 天 38 release） | 🟠 中 | 行为/命令随版本变动；社区确认「只 git pull 不更新引擎」。缓解：锁定版本 tag、更新走官方 update 流程、回归冒烟 |
| 单并发 | 🟠 中 | 多客户端排队。缓解：限流/单会话场景使用 |
| 内存贴线（31.2GB） | 🟠 中 | low-RAM resident 常驻 ~13GB + 系统；仍需保证无大后台。启动加载 1–3 分钟机器可能卡顿（官方说明，属正常） |
| 默认 thinking=high 超长输出 | 🟡 中 | 单请求可输出数万 token、速度被思考占满。缓解：reasoning_effort none/low 或 reasoning_budget_tokens |
| 显存贴满（16GB） | 🟡 低-中 | 16GB 显存几乎用满，同机 GPU 程序需 --vram-reserve-mib；COW 重启后需完整重载 |
| 模型许可 | 🟡 低 | 引擎 MIT 可商用；模型各自许可（Qwen3.8-Flash-Next 卡页 Apache-2.0，待验证；GGUF 压缩版/微调版以各仓库为准） |

### 7.4 工作量评估

- 接入（登记为独立引擎 + nginx upstream + cloudflared + systemd 包装 + 启动脚本）：**1–2 人日**；
- 首次真机验证（下载 66GB + 打包 + 实测 tok/s/TTFT + 中文/代码对比 + 重启重装脚本演练）：**1–2 人日**；
- 若需中文全量专家档：**需升级内存 ≥48GB（硬件改造，超出软件范围）**，否则维持 Coder 档取舍。

---

## 8. 待验证清单

1. 目标机 CPU 型号/AVX-512 支持（影响 RAM 驻留专家的计算速度与预期 tok/s）——**待验证**
2. 目标机是否存在持久挂载盘（决定 COW 重装成本：66GB 重下 vs `--data-dir` 免重下）——**待验证**
3. Qwen3.8-Flash-Next / ISTA-DASLab GGUF / Swift 1.5 的精确许可证文本（卡页为 Apache-2.0，**待验证**）
4. 4080 SUPER 16GB + 31.2GB 真机上 Coder 档的 tok/s/TTFT 实测值（官方/社区仅有 12GB 5070、5090、9070XT 数据，幅度 ±20%）——**待验证**
5. 31.2GB 物理内存 + low-RAM resident 在真实负载下的内存峰值/是否触发 swap——**待验证**
6. 当前仓库在 2026-10-03 后是否再出新版本/引擎行为变化（项目极速迭代）——**待验证**
7. Ubuntu 24.04.3 上预编译引擎（RTX 40 系 sm_89）的首次安装是否完全免编译（文档称免，社区 Linux 实测免）——**待验证**

---

## 9. 参考来源

- [Niko1221/Strata（README）](https://github.com/Niko1221/Strata)
- [docs/INSTALL.md（驱动 580+/CUDA13、Docker、HF_ENDPOINT 镜像、--gguf-dir 离线、存储位置）](https://github.com/Niko1221/Strata/blob/main/docs/INSTALL.md)
- [docs/MODELS.md（按 RAM 选型、低内存模式、Coder 中文警告 #438、各档速度）](https://github.com/Niko1221/Strata/blob/main/docs/MODELS.md)
- [docs/COMMUNITY_BENCHMARKS.md（测量口径/TTFT/报告模板）](https://github.com/Niko1221/Strata/blob/main/docs/COMMUNITY_BENCHMARKS.md)
- [docs/MCP_SERVER.md（strata_mcp.py 管理工具、RAM 判定、下载体积）](https://github.com/Niko1221/Strata/blob/main/docs/MCP_SERVER.md)
- [docs/HOW_IT_WORKS.md（引擎机制、MIT、模型许可）](https://github.com/Niko1221/Strata/blob/main/docs/HOW_IT_WORKS.md)
- [docs/DETAILS.md（Speed measured 全表、Using it API、KV/低内存细节）](https://github.com/Niko1221/Strata/blob/main/docs/DETAILS.md)
- [setup.py（MODELS 表/ram_gb/arena_gb、MIN_DRIVER=580、low_ram_* 判定）](https://github.com/Niko1221/Strata/blob/main/setup.py)
- [serve/server.py（--api-key/STRATA_API_KEY、Host 校验、8080）](https://github.com/Niko1221/Strata/blob/main/serve/server.py)
- [bench/results/2026-09-29-speed-0126/README.md（RTX 5070 12GB 官方测量）](https://github.com/Niko1221/Strata/tree/main/bench/results/2026-09-29-speed-0126)
- [bench/results/2026-09-30-community-rtx-5090/README.md（社区 Linux 实测报告）](https://github.com/Niko1221/Strata/tree/main/bench/results/2026-09-30-community-rtx-5090)
- [GitHub API：仓库元数据与 release 列表（created 2026-09-24、7k stars、v0.1.38）](https://api.github.com/repos/Niko1221/Strata)
- [note.com 两天安装实录（RTX 5090/Linux：2h15m 安装、端口冲突、更新陷阱、实测速度）](https://note.com/zephel01/n/nce0d0c3328cd)
- [Reddit：Strata is amazing!（MoE 显存/RAM 拆分运行 Qwen3.8）](https://www.reddit.com/r/LocalLLM/comments/1wv6fwi/strata_is_amazing/)
- [Trendshift 快照（12–24GB GPU + 64GB RAM 概述）](https://trendshift.io/repositories/259708)