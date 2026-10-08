# CyberCafe MiniMax-H3 本地部署

> 交付：规格核实结论 + install/uninstall 脚本 + 跑通证据（沙箱自验）。任务 t25（用户 2026-10-02 指示：方案不限、跑通流程即可；含一键卸载全面清理）。

## 1. 规格核实结论（重要：H3 不是聊天 LLM）

**MiniMax H3 是 omni-modal（全模态）视频+音频生成系统**，不是文本聊天模型（无 `/v1/chat/completions` 对话端点）。因此「聊天 200 验证」按任务预案调整为**真实生成跑通验证**（文本→视频+音频，HTTP /v1 兼容端点 200 + CLI 冒烟生成产物）。

| 项目 | 结论 | 来源 |
|---|---|---|
| 开源 | 是（MIT 社区许可 MiniMax H3 Community License，权重与推理代码开源；Context-IR/2K 再生模块托管未开放） | [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) |
| 参数量/架构 | H3-Omni-Transformer **33B** dense + H3-Encoder = **Qwen3-VL-32B**（取 50 层 hidden）+ VisualVAE(f16t4d24) + AudioVAE(40Hz) | [架构文档](https://huggingface.co/MiniMaxAI/MiniMax-H3#model-architecture) |
| 格式 | 官方 BF16 safetensors（SGLang 推荐 4×GPU / vLLM / diffusers / ComfyUI）；社区 GGUF 量化可用 | [官方仓库](https://huggingface.co/MiniMaxAI/MiniMax-H3) |
| HF 地址 | `MiniMaxAI/MiniMax-H3`（官方）、`Abiray/MiniMax-H3-Pruned-GGUF`（pruned 消费卡档）、`Abiray/MiniMax-H3-GGUF`（text encoder+VAE）、`leejet/MiniMax-H3-GGUF`（sd.cpp 作者档） | [HF](https://huggingface.co/Abiray/MiniMax-H3-Pruned-GGUF) |
| 下载体积 | 最小档（Q3_K_M pruned）≈ **29GB**：扩散 8.9GB + 文本编码器 14.6GB + 视频 VAE 5.2GB + 音频 VAE 0.6GB | 本调研（hf-mirror API 实测 200） |
| 目标机（16GB 显存/31.2GB 内存）可行性 | ✅ **可行（最小档）**：官方 pruned 档面向消费卡，Q3_K_M=8.9GB（~12GB 卡）、Q4_K_M=11.6GB（推荐 16GB 卡）；31GB 内存装 Q4 编码器+CPU offload 可行 | [Pruned-GGUF](https://huggingface.co/Abiray/MiniMax-H3-Pruned-GGUF) |
| 运行时 | stable-diffusion.cpp（[leejet](https://github.com/leejet/stable-diffusion.cpp)，Day-1 支持 MiniMax-H3、GGUF 原生、有 sd-server HTTP 服务） | [sd.cpp minimax_h3.md](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/minimax_h3.md) |

**最小可行档**：`MiniMax-H3-FL2VA-Pruned-Q3_K_M.gguf`（8.9GB，12GB 显卡档；16GB 卡平衡档 Q4_K_M 11.6GB），文本编码器 `qwen3vl_32b_minimax_h3-Q4_K_M.gguf`。

## 2. 部署形态

- **端口**：sd-server 独立端口 **127.0.0.1:11435**（避开 ollama/vllm/sglang/strata 共用的 11434，nginx 鉴权网关零改动；如需公网可加 Key 反向代理或套现有网关）
- **能力**：`/v1/models`、`/sdcpp/v1/vid_gen`（文本→视频+音频）、`/sdapi/v1/*` OpenAI 兼容形态
- **权重源**：`HF_ENDPOINT=https://hf-mirror.com`（国内可达，API 200 已验证）
- **编译兼容**：依赖 CUDA toolkit（nvcc）+ gcc≤12 兼容注入（复用 strata 的 gcc-12 隔离经验：真机 gcc 13.3 与 CUDA 12.2 不兼容，脚本自动 apt 装 gcc-12 并以 `/root/.cybercafe-gcc12` 软链隔离，不污染系统 gcc）

## 3. 使用

```bash
# 安装（默认最小档 Q3_K_M；16GB 平衡档）：
bash scripts/install.sh                 # 默认 Q3_K_M（CUDA 编译 + GPU 推理）
H3_QUANT=Q4_K_M bash scripts/install.sh # 16GB 推荐平衡档
H3_QUANT=UD-Q2_K_XL bash scripts/install.sh  # 极低配兜底档：unsloth UD-Q2_K_XL（8.06GB denoiser
                                            # + Q2_K_M 13.1GB 编码器），全 CPU offload 也可跑
                                            # （约 940s/25 帧量级），适合无 CUDA 编译环境的机器

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
> 源码编译 CUDA + gcc-12 隔离 + 独立端口 11435 + 多档支持（Q3_K_M…Q5_K_M/UD-Q2_K_XL）。
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
- [x] 真机实测修复（2026-10-08，XZ-31-002）：① set -u 下 LD_LIBRARY_PATH unbound（`${LD_LIBRARY_PATH:-}`）；② sd.cpp 依赖 ggml 子模块，clone 需 `--recursive`（补子模块+清残留 build）；③ CUDA_ENV 双 PATH 前缀致 CMake 找不到 nvcc（`${CUDA_ENV#PATH=}` 插入 + 显式 `-DCMAKE_CUDA_COMPILER`）
- [ ] 真机完整验收（16GB 显存真实生成 + 卸载后复核）——归测试任务（t27，测试三，sha256 67e837efa7218dc4 已放行开跑）
- [ ] 云管 ENGINES 接入（可后续；H3 为视频生成引擎非聊天引擎，接入价值有限）
- [ ] 云管 ENGINES 接入（可后续；注意 H3 为视频生成模型非聊天引擎，接入价值有限，任务约定可后置）

> 目标机变更（2026-10-08 实测）：原 tower-zjC5pkGWm（COW 快照机）已回收；当前在线目标为同规格新批次 **XZ-31-001 / XZ-31-002**（RTX 4080 SUPER 16GB / 31.2GB 内存 / agent 0.4.0，batch ccb-97938710f10e）。SSH 111.4.255.126 的 2028/16289 等端口当前全部超时（NAT 通道待测试任务确认），真机执行 install.sh/uninstall.sh 时请先取得可达通道。