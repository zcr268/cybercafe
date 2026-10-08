# CyberCafe MiniMax-H3 本地部署

> 交付：规格核实结论 + install/uninstall 脚本 + 跑通证据（沙箱自验）。任务 t25（用户 2026-10-02 指示：方案不限、跑通流程即可；含一键卸载全面清理）。

## 1. 规格核实结论（重要：H3 不是聊天 LLM）

**MiniMax H3 是 omni-modal（全模态）视频+音频生成系统**，不是文本聊天模型（无 `/v1/chat/completions` 对话端点）。因此「聊天 200 验证」按任务预案调整为**真实生成跑通验证**（文本→视频+音频，HTTP /v1 兼容端点 200 + CLI 冒烟生成产物）。

| 项目 | 结论 | 来源 |
|---|---|---|
| 开源 | 是（MIT 社区许可 MiniMax H3 Community License，权重与推理代码开源；Context-IR/2K 再生模块托管未开放） | [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) |
| 参数量/架构 | H3-Omni-Transformer **33B** dense + H3-Encoder = **Qwen3-VL-32B**（取 50 层 hidden）+ VisualVAE(f16t4d24) + AudioVAE(40Hz) | [架构文档](https://huggingface.co/MiniMaxAI/MiniMax-H3#model-architecture) |
| 格式 | 官方 BF16 safetensors（SGLang 推荐 4×GPU / vLLM / diffusers / ComfyUI）；社区 GGUF 量化可用 | [官方仓库](https://huggingface.co/MiniMaxAI/MiniMax-H3) |
| HF 地址 | `MiniMaxAI/MiniMax-H3`（官方）、`unsloth/MiniMax-H3-GGUF`（sd.cpp 兼容 denoiser+编码器，本脚本默认源）、`leejet/MiniMax-H3-GGUF`（sd.cpp 作者档）、`Comfy-Org/MiniMax-H3`（VAE）；⚠️ `Abiray/MiniMax-H3-Pruned-GGUF` 为 ComfyUI-GGUF 布局，sd.cpp 加载报 `model metadata validation failed`，本脚本**不使用**（t48 真机实测） | [unsloth](https://huggingface.co/unsloth/MiniMax-H3-GGUF) |
| 下载体积 | 最小档（UD-Q2_K_XL）≈ **27GB**：denoiser 8.06GB + 文本编码器 Q2_K_M 13.1GB + 视频 VAE 5.2GB + 音频 VAE 0.6GB | 本调研（hf-mirror API 实测 206） |
| 目标机（16GB 显存/31.2GB 内存）可行性 | ✅ **可行（UD-Q2_K_XL 默认档）**：denoiser 8.06GB 可上卡、文本编码器 Q2_K_M 13.1GB 留 CPU（31GB 内存够）、峰值显存实测 ~9GB（t48 NVML）；16GB 卡平衡档 Q4_K_M（11.4GB denoiser）亦可 | [unsloth](https://huggingface.co/unsloth/MiniMax-H3-GGUF) |
| 运行时 | stable-diffusion.cpp（[leejet](https://github.com/leejet/stable-diffusion.cpp)，Day-1 支持 MiniMax-H3、GGUF 原生、有 sd-server HTTP 服务） | [sd.cpp minimax_h3.md](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/minimax_h3.md) |

**最小可行档**：`minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf`（8.06GB denoiser，unsloth）+ `qwen3vl_32b_minimax_h3-Q2_K_M.gguf`（13.1GB 编码器，留 CPU）——t48 真机实测 GPU 运行（102.65s/25帧 vs 纯 CPU 940s）。

## 2. 部署形态

- **端口**：sd-server 独立端口 **127.0.0.1:11435**（避开 ollama/vllm/sglang/strata 共用的 11434，nginx 鉴权网关零改动；如需公网可加 Key 反向代理或套现有网关）
- **能力**：`/v1/models`、`/sdcpp/v1/vid_gen`（文本→视频+音频）、`/sdapi/v1/*` OpenAI 兼容形态
- **权重源**：`HF_ENDPOINT=https://hf-mirror.com`（国内可达，API 200 已验证）
- **编译兼容**：依赖 CUDA toolkit（nvcc）+ gcc≤12 兼容注入（复用 strata 的 gcc-12 隔离经验：真机 gcc 13.3 与 CUDA 12.2 不兼容，脚本自动 apt 装 gcc-12 并以 `/root/.cybercafe-gcc12` 软链隔离，不污染系统 gcc）

## 3. 使用

```bash
# 安装（默认档 UD-Q2_K_XL，sd.cpp 兼容最小档；16GB 卡平衡档 Q4_K_M）：
bash scripts/install.sh                          # 默认 UD-Q2_K_XL（CUDA 编译 + GPU 推理）
H3_QUANT=Q4_K_M bash scripts/install.sh          # 16GB 卡推荐平衡档（11.4GB denoiser）
H3_QUANT=Q5_0 bash scripts/install.sh            # 可选更高档（13.0GB denoiser）
H3_QUANT=UD-Q3_K_XL bash scripts/install.sh      # 可选（8.9GB，质量/速度均衡）

# 冒烟验证自动化：install.sh 内置「文本→视频+音频」真实生成（640x384/25帧/4步）
# 产物：/opt/minimax-h3/smoke_test.webm；HTTP：http://127.0.0.1:11435/v1/models → 200

# 生成（经网关或直接）：
curl -s http://127.0.0.1:11435/v1/models          # 200 就绪
curl -s -X POST http://127.0.0.1:11435/sdcpp/v1/vid_gen \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a red fox trotting through falling snow, cinematic"}'

# 一键卸载 + 全面清理（除脚本外零残留）：
bash scripts/uninstall.sh
```

> **如何读 sd.cpp 日志里的 `VRAM 0.00MB`（重要，勿误判为"没在用 GPU"）**：
> 脚本固定使用 `--backend "te=cpu,vae=cuda0,diffusion=cuda0" --offload-to-cpu`。
> 在此配置下，sd.cpp 启动日志
> `total params memory size = 25828.96MB (VRAM 0.00MB, RAM 25828.96MB): text_encoders 12497MB(RAM), diffusion_model 7774MB(RAM), vae 5558MB(RAM), ...`
> 统计的是**每个组件的「参数常驻位置」**——`--offload-to-cpu` 语义为参数先驻系统 RAM、计算时按需流式送 GPU（backend.md 的 offloaded/分段机制）。因此：
> - `text_encoders ...(RAM)` = 文本编码器参数常驻 RAM（`te=cpu` 的预期行为，12GB 编码器不占 16GB 显存）；
> - `VRAM 0.00MB` = **没有任何组件把参数常驻显存**，这不代表 GPU 未参与计算——denoiser/VAE 在 cuda0 上流式计算，参数按段上卡；
> - GPU 是否被使用的判据以 **NVML 独立采样**为准（t48 真机实测：空闲基线 1MB → 生成峰值 8986MB 显存、利用率 20 次非零、峰值 util_gpu=100%）。
> **源码依据**：leejet/stable-diffusion.cpp `src/pipeline/diffusion_engine.cpp`：
> L1316 `return sd_backend_is_cpu(module_backend) ? "RAM" : "VRAM";`
> L1329 `"total params memory size = %.2fMB (VRAM %.2fMB, RAM %.2fMB): ..."`——
> 组件标签（RAM/VRAM）按 `params_backend_for(module)` 是否 CPU 后端返回，te=cpu → "RAM"（参数在 RAM），diffusion/vae=cuda0 运行时流式上卡。

> **Vulkan 预编译版为什么不采用**：leejet/stable-diffusion.cpp release 确有 Linux Vulkan 预编译资产
> （35.2MB，零编译即可跑），且 NVIDIA 卡有 Vulkan ICD；但 MiniMax-H3 是 2026-08 才加入的新模型，
> **16GB Vulkan 后端当前不可用**——[issue #1976](https://github.com/leejet/stable-diffusion.cpp/issues/1976)
> （open，2026-09-14）：「Video regressions on 16 GB Vulkan: LTX-2.5 + MiniMax-H3 broken since master-864」，
> graph 被切 50+ 段后 `ErrorOutOfDeviceMemory`（15GB 空闲仍崩），`--auto-fit off` 只救得了 Wan 救不了 H3。
> 因此「零编译」与「GPU 加速」在此场景不可兼得：CUDA 后端是 sd.cpp primary backend（H3 官方示例全 CUDA），
> 本方案采用源码编译 CUDA（sm_89），一次性 10-20min，换取可用速度。

> **与仓库内历史版本（main@5f683c7，dev3）的关系**：main 上 `minimax-h3/` 目录为 dev3 2026-10-03 交付的
> **早期版本**（预编译 CPU 二进制 + Q2 档，真机实测 `VRAM 0.00MB / te=cpu,diffusion=cpu,vae=cpu`，
> 940s/25 帧）。本目录（/tmp/cybercafe-h3，引擎开发 2026-10-08）为其 **GPU 升级版**：
> 源码编译 CUDA + gcc-12 隔离 + 独立端口 11435 + 多档支持（UD-Q2_K_XL/UD-Q3_K_XL/Q4_K_M/Q5_0）。
> 合并方向：**以本版为基底**，dev3 版保留作历史证据并标注 superseded。

## 4. 卸载清理范围（uninstall.sh）

1. **进程**：sd-server(11435) / sd-cli（仅本模型路径，防误杀） + fuser 端口兜底
2. **systemd 服务**：minimax-h3 / sd-server-h3 遗留 unit（含 daemon-reload）
3. **目录**：`/opt/minimax-h3`（权重+sd.cpp 编译产物+日志+冒烟产物）整体删除
4. **缓存**：HF 缓存中 Abiray 两仓库条目（不删共用 hub 目录）
5. **gcc 隔离目录**：默认保留（strata 共用）；`UNINSTALL_GCC=1` 时连 `/root/.cybercafe-gcc12` 一起清
6. **残留核验**：目录/进程/端口三项自动复查，有残留即报错退出；系统级依赖（git/cmake/build-essential/CUDA）保守保留（四引擎共用，避免误伤）

可逆性：权重/编译产物均来自公开仓库，重新执行 `bash install.sh` 即可完整恢复，无手工步骤。

## 5. 验收状态

- [x] 规格核实（web 真实调研，含 hf-mirror API 200/206 实测）
- [x] 脚本开发（install.sh / uninstall.sh，bash -n + 逻辑自验）
- [x] 权重 URL 可达性（hf-mirror 全部量化档 + 组件 7 个 URL 206 实测）
- [x] 沙箱自验：脚本语法（bash 3.2 兼容）/ 端口规划（11435 独立）/ uninstall 端到端（10 文件目录全清 + 强清模式）
- [x] 真机实测修复（2026-10-08，XZ-31-002，t48 累计六处）：
  ① `set -u` 下 LD_LIBRARY_PATH unbound（`${LD_LIBRARY_PATH:-}`）
  ② sd.cpp 依赖 ggml 子模块，clone 需 `--recursive`（补子模块+清残留 build）
  ③ CUDA_ENV 双 PATH 前缀致 CMake 找不到 nvcc（`${CUDA_ENV#PATH=}` 插入 + 显式 `-DCMAKE_CUDA_COMPILER`）
  ④ gcc/g++ 安装守卫分别独立判定 + cc1plus 存在性硬校验（g++-12 缺失致 `cannot execute cc1plus`，CUDA 编译器探测失败）
  ⑤ 隔离目录软链 `cc/c++` 悬空（Ubuntu 无 cc-12/c++-12，改为指向 gcc-12/g++-12，源不存在不建链）
  ⑥ 下载守卫静默沿用旧权重：换仓库/换档位后不重下（文件名带档位编码 + `.src` URL 记录 sidecar，不符即重下）——**第五类缺陷「不崩但静默用错数据」**
  ⑦ 权重源修正：Abiray/MiniMax-H3-Pruned-GGUF 为 ComfyUI-GGUF 布局，sd.cpp 加载报 `model metadata validation failed`（wrong shape）——改为 unsloth/leejet 兼容源 + Comfy-Org VAE
  ⑧ 编译幂等：sd-cli 已生成时跳过清理与重编译（仅失败残留才清 build）
- [x] 真机 GPU 验证（XZ-31-002，16721，2026-10-08）：CUDA 版编译成功（sd-cli 242MB）；真实视频生成 `generate_video completed in 102.65s`（纯 CPU 基线 940s ≈ 9 倍加速）；**NVML 独立采样（nvml_monitor.py，ctypes 直读 libnvidia-ml，v2 version=0x02000028）：空闲基线 1MB → 峰值 8986MB，GPU 利用率非零采样 20 次、峰值 util_gpu=100%/util_mem=51%**；参数显式 `--backend "te=cpu,vae=cuda0,diffusion=cuda0" --offload-to-cpu`（文本编码器留 CPU，denoiser/VAE 上卡）；sd-server 常驻 11435 且 `/v1/models` 200。证据文件：`/opt/minimax-h3/gpu_evidence_run.log`、`/opt/minimax-h3/nvml_gpu_run.log`、`/opt/minimax-h3/smoke_test.webm`
- [ ] 云管 ENGINES 接入（可后续；H3 为视频生成引擎非聊天引擎，接入价值有限）

> 目标机变更（2026-10-08 实测）：原 tower-zjC5pkGWm（COW 快照机）已回收；当前在线目标为同规格新批次 **XZ-31-001 / XZ-31-002**（RTX 4080 SUPER 16GB / 31.2GB 内存 / agent 0.4.0，batch ccb-97938710f10e）。SSH 111.4.255.126 的 2028/16289 等端口当前全部超时（NAT 通道待测试任务确认），真机执行 install.sh/uninstall.sh 时请先取得可达通道。