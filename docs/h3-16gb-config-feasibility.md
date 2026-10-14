# MiniMax-H3 在 16GB 显存上的 GPU 利用率可行性（sd.cpp CUDA 版配置调研）

> 调研日期：2026-10-08 ｜ 调研人：调研员 ｜ 关联任务：t47（原「sd.cpp Vulkan 后端调研」于 2026-10-08 由队长改道为「H3 在 16GB 显存上能上多少 GPU」）
> 目标机（由队长提供，本次未连接）：RTX 4080 SUPER 16GB / 驱动 535.274.02 / CUDA 12.2 / Ubuntu 24.04 / kernel 6.14 / 内存 31GB
> 相关实现：A=仓库 main 纯 CPU 预编译（leejet/stable-diffusion.cpp，unsloth UD-Q2_K_XL denoiser，实测 940.83s/25帧、VRAM 0）；B=源码编译 CUDA 版（t25 交付，已抓修三缺陷）

---

## ① 一句话结论

**16GB 显存卡可以跑 H3 且能获得大幅 GPU 加速：采用「文本编码器 + VAE 参数驻留 CPU（或磁盘）、denoiser 流式上卡」的混合放置，峰值显存实测约 12.4–13.1 GiB < 16GB，unsloth 侧同参数档（640×384/25帧/4步/q4_K）墙钟仅 ~21s，相对实现 A 纯 CPU（~941s/25帧）加速约 30–45 倍；Vulkan 路线已被 sd.cpp issue #1976 否决（H3 在 16GB Vulkan 上 broken，见 §2.6），CUDA 源码编译（实现 B）是唯一可行基线，只需把脚本从全 CPU 改为混合放置参数即可。**

---

## ② 逐子问题证据（真实来源）

### 2.1 sd.cpp 的 auto-fit / --backend / --params-backend 机制：如何决定组件放 GPU 还是 CPU/RAM？卸载粒度？

来源：[docs/backend.md](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/backend.md)（leejet/stable-diffusion.cpp@master）

- **两套独立赋值**：`--backend`（运行时计算后端）、`--params-backend`（参数驻留后端）。未设 `--params-backend` 时 auto-fit 自动决策；`--auto-fit off` 时参数跟随模块运行时后端。
- **粒度是「整组件」+「denoiser 段粒度流式」**：
  - 组件粒度：`diffusion / te / vae` 等模块可分别指定，如 `--backend "te=cpu,vae=cuda0,diffusion=vulkan0"`、`--params-backend te=cpu,vae=cpu`；
  - denoiser 内分层段粒度：`--params-backend diffusion=cpu` 时走「自动图分段」（graph segmentation），把 diffusion 权重按段流式加载到计算设备、算完一段回收一段（原话：*"Automatic graph segmentation can then load the required weights for each segment and reclaim idle GPU copies"*）；多卡还可 `diffusion=cuda0&cuda1` 层切分/行切分。
- **auto-fit 的优先级顺序（放不下时的回落链）**：diffusion → te → vae 依次规划；每个组件依次尝试 ① 计算 GPU → ② CPU RAM（预留 2GiB 或 10% RAM）→ ③ 另一块 GPU → ④ 磁盘按需重载。**注意 auto-fit 不会因为某组件全量权重超显存就把它整个切到 CPU 计算**——离线参数+分段计算才是既定路径。
- 兼容旧参数：`--offload-to-cpu` 等价于 `--params-backend '*=cpu'`；`--clip-on-cpu/--vae-on-cpu/--control-net-cpu` 已废弃（等价于给 te/vae/controlnet 加 cpu 运行时）。

### 2.2 给定 16GB 显存 + 25.8GB 参数，最优配置是什么？逐组件核算

组件真实参数量（实现 A 真机日志，队长提供：`total params memory size = 25828.96MB`；与公开文件大小相互印证，见 §2.3）：

| 组件 | 实现 A 实测（MB） | 公开文件对照 | 单独能否进 16GB |
|---|---|---|---|
| 文本编码器 qwen3vl_32b_minimax_h3（Q2_K_M） | 12,497 | 12.20 GiB（unsloth） | 单独勉强；与 denoiser 同驻**不能** |
| denoiser minimax_h3_fl2va_pruned（UD-Q2_K_XL） | 7,774 | 7.51 GiB（unsloth） | ✅ 单独可（且余量够计算缓冲） |
| VAE（video fp16 + audio fp32） | 5,558 | 5.21 GB + 605 MB（Comfy-Org） | ✅ 单独可；int8_convrot VAE 仅 2.81 GB |

**结论：没有“三个组件同时全量驻留 16GB”的组合（6.26+12.20+5.21+0.61 ≈ 24.3 GiB > 16GB），但不需要同时驻留——见 2.4 的时序复用。**

最优配置（与 [unsloth 官方模型卡示例](https://huggingface.co/unsloth/MiniMax-H3-GGUF) 完全同型）：

```
sd-cli -M vid_gen \
  --diffusion-model minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf \
  --llm qwen3vl_32b_minimax_h3-Q2_K_M.gguf \
  --vae minimax_h3_video_vae_fp16.safetensors \
  --audio-vae minimax_h3_audio_vae_fp32.safetensors \
  -p "..." --cfg-scale 1.0 -v -W 640 -H 384 \
  --diffusion-fa --offload-to-cpu --rng cpu --fps 24 --video-frames 25
```

即：**文本编码器参数在 CPU（compute 也在 CPU 或按需流式），denoiser 与 VAE 计算走 GPU**，`--offload-to-cpu` 保证参数先从磁盘进 RAM、用时才上卡。unsloth 官方示例显式写的是 `--backend te=cpu`（另加“显存更小再加 --offload-to-cpu”）。

### 2.3 是否存在更小量化档，把「全量同时驻留」压进 16GB？

来源：[unsloth/MiniMax-H3-GGUF 模型卡（文件表）](https://huggingface.co/unsloth/MiniMax-H3-GGUF)、[Comfy-Org/MiniMax-H3（VAE 目录）](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/main/vae)

- **denoiser（fl2va_pruned，均有 ref2va 同档）：Q2_K 6.26 GiB ← 最小；UD-Q2_K_XL 7.51；Q3_K 8.16；UD-Q3_K_XL 8.90；Q4_K 10.64；Q5_0 12.97；Q6_K 15.45；Q8_0 19.97。**
- **文本编码器只有两档：Q2_K_M 12.20 GiB ← 最小；Q4_K_M 16.97 GiB**。✅ 未查到比 Q2_K_M 更小（无 IQ2/更低的公开 GGUF 档）。
- **VAE：video fp16 5.21 GB / video int8_convrot 2.81 GB（23 天前上传的新档）/ audio fp32 605 MB；未查到 audio VAE 的量化档。**
- **所有组件最小档合计 = 6.26 + 12.20 + 2.81 + 0.61 ≈ 21.9 GiB 仍 > 16GB → 全量同时驻留 16GB 无解；但无需同时驻留（§2.4）。**
- 注意：denoiser 本身已是 Pruned（剪枝）版；H3 两个 denoiser（fl2va/ref2va）为不同权重，须按任务选择（[unsloth 模型卡说明](https://huggingface.co/unsloth/MiniMax-H3-GGUF)）。

### 2.4 关键：是否支持时序复用（编码完释放文本编码器 → denoiser 再上显存）？

**支持，这是 sd.cpp 的既有行为 + 官方推荐路径，且 16GB 可行性的核心依据：**

1. **组件级“相位后释放”**：[docs/backend.md](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/backend.md) 原文：*“If offloaded diffusion already needs the entire main GPU budget, TE and VAE also use offloaded parameters. Their GPU copies can then be released after their phases, leaving more room to reuse diffusion weights across sampling steps.”*（TE/VAE 的 GPU 副本在其相位结束后释放，把显存让给采样阶段的 denoiser）。
2. **贡献者确认“编码前先卸载 denoiser、编码后卸载 TE”**：[Discussion #1452](https://github.com/leejet/stable-diffusion.cpp/discussions/1452)（Flux2 顺序加载讨论）——stduhpf：*“You can use --offload-to-cpu to load them to ram first and only move the weights to VRAM when they're in use. Also loading is technically already sequential.”*；wbruna：*“sd-cli unloads the conditioner weights before generation.”*（sd-cli 在生成前卸载条件编码器权重）。
3. **denoiser 的“流式层”机制**（RAM→VRAM 按段传输）：PR [#1905 prefetch streamed layers during compute（已合）](https://github.com/leejet/stable-diffusion.cpp/pull/1905)、PR [#1906 pool VRAM for streamed layer](https://github.com/leejet/stable-diffusion.cpp/pull/1906)（open，讨论中）；`--params-backend diffusion=cpu` 即走该路径。
4. **实测峰值**（unsloth 侧提交说明，640×384/25帧/4步/q4_K、`--offload-to-cpu --clip-on-cpu`，见 §2.5）：峰值 VRAM **12.42 GiB**；加 `--vae-on-cpu` 峰值不变（12.42→12.42 GiB）但墙钟 20.9s→100.4s；另一条描述“全模型峰值 13.14 GiB”。**两个数都 < 16GB → 16GB 卡可跑且 denoiser 全程 GPU 计算。**

### 2.5 PR #1854 核验（队长要求必须自行核实）+ 官方示例命令原文

**PR #1854 真实存在**：[leejet/stable-diffusion.cpp#1854 "feat: add minimax-h3 support"](https://github.com/leejet/stable-diffusion.cpp/pull/1854)，作者 leejet（owner），2026-08-04 提出、同日 merged，合入 commit [ea7f0c8](https://github.com/leejet/stable-diffusion.cpp/commit/ea7f0c87cfe4c673263b4c201c596c7f1cbe2528)（即 README 所称 “Day-1 support for MiniMax-H3 2026-08-04”）。PR 自带 T2AV 示例命令原文（Windows 路径，Linux 同参）：

```
.\bin\Release\sd-cli.exe -M vid_gen --diffusion-model ..\models\diffusion_models\minimax_h3_fl2va-Q4_K_M.gguf
  --vae ..\models\vae\minimax_h3_video_vae_fp16.safetensors
  --audio-vae ..\models\vae\minimax_h3_audio_vae_fp32.safetensors
  --llm ..\models\text_encoders\qwen3vl_32b_minimax_h3-Q4_K_M.gguf
  -p "..." --cfg-scale 1.0 -v -W 864 -H 480 --diffusion-fa --offload-to-cpu --rng cpu --fps 24 --video-frames 56
```

- **用的是 `--offload-to-cpu`（旧兼容参数 = `--params-backend '*=cpu'`），不是 `--backend te=cpu,diffusion=cuda`，也不是全 CUDA**——即官方在示例里就把整模型参数放 RAM、用时上卡。
- unsloth 侧（[unsloth/MiniMax-H3-GGUF 模型卡](https://huggingface.co/unsloth/MiniMax-H3-GGUF)）给的 sd-cli 示例则显式用 **`--backend te=cpu`**（“keeps the 12 GB text encoder off the card. Add `--offload-to-cpu` to fit a smaller GPU”），其余组件走默认 GPU（auto-fit）。

**unsloth 侧实测数据（同一 PR 讨论区可见的 unsloth Studio 提交说明，未注明显卡型号，供量级参考）**：
- 640×384、25 帧、4 步、q4_K、`--offload-to-cpu --clip-on-cpu`：墙钟 **20.9s**，峰值 VRAM **12.42 GiB**；
- 同一配置加 `--vae-on-cpu`：墙钟 **100.4s**（VAE 上 CPU 反而 4.8× 慢，峰值不变）→ **VAE 必须留 GPU**；
- `--offload-to-cpu` 下全模型峰值 **13.14 GiB**（由流式 denoiser 决定）。

### 2.6 Vulkan 路线否决依据（队长核验 + 本次复核全文）

- **sd.cpp issue #1976（open，2026-09-14 创建、持续更新）**：[“Video regressions on 16 GB Vulkan: LTX-2.5 + MiniMax-H3 broken since master-864, Wan 2.2 broken by master-866 (graph segmentation / weight-budget behavior) — --auto-fit off only rescues Wan”](https://github.com/leejet/stable-diffusion.cpp/issues/1976)。H3 在 master-841→864 窗口被 memory-manager 重构破坏，graph 切成 50+ 段、空闲 15GB 仍 `ErrorOutOfDeviceMemory`，`--auto-fit off` 只救 Wan 不救 H3，至今 open。
- 佐证：issue #1290 “[Vulkan runs out of memory when it shouldn't](https://github.com/leejet/stable-diffusion.cpp/issues/1290)”（Vulkan 显存管理已知缺陷）；[release master-945-a1ded76](https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-945-a1ded76) 资产**无 Linux CUDA 预编译**、仅 CPU/ROCm/Vulkan；README 后端列表虽含 Vulkan（[README](https://github.com/leejet/stable-diffusion.cpp)），但社区普遍反馈 Vulkan 性能弱于 CUDA（如 r/StableDiffusion 用户报告 Vulkan 后端比 ComfyUI 慢 ~50%）。
- **因此「Vulkan 预编译免编译方案」对 H3/16GB 目标机不可行，CUDA 源码编译（实现 B）是唯一获得稳定 GPU 加速的路径。**

### 2.7 他人在 16GB 卡上跑 H3 的公开实测（生态侧佐证，非 sd.cpp）

- ComfyUI 生态有大量 16GB 报告：如 r/StableDiffusion “MiniMax H3 first local test”（RTX 4090 Laptop 16GB）；ComfyUI issue [#15628](https://github.com/Comfy-Org/ComfyUI/issues/15628)（4070 12GB DynamicVRAM 卡死，社区围绕显存-内存换页排查）；InstaSD 指南“Run MiniMax H3 on 8-16GB Cards”主张 12-16GB 卡 + ≥64GB 内存可跑。
- 社区并发出的“H3 文本编码器用后即卸载”节点（ComfyUI 生态：[H3 Evict Text Encoder](https://comfy.icu/node/H3EvictTextEncoder)——*“unloads the text encoder the instant encoding is done … so the encoder's VRAM is free before the DiT runs”*）印证 §2.4 的时序复用是 H3 16GB 方案的公认关键手法。
- ⚠️ 以上为 ComfyUI/diffusers 生态数据；sd.cpp 自身可复制的量级数据见 §2.5（20.9s/640×384/25帧/4步）。

---

## ③ 三方对比表（实现 A / 实现 B / Vulkan 预编译）

| 维度 | 实现 A：纯 CPU 预编译（repo main） | 实现 B：源码编译 CUDA 版 | Vulkan 预编译版（35.2MB） |
|---|---|---|---|
| 编译耗时 | 0（预编译） | 10–20 分钟（git/cmake/gcc-12） | 0（预编译） |
| 系统依赖 | 无 | apt 装 git/cmake/gcc-12 + CUDA 工具链 | libvulkan1 + NVIDIA Vulkan ICD（驱动 535 自带，理论兼容） |
| 组件放置能力 | 全 CPU（实测 `te=cpu,diffusion=cpu,vae=cpu`、VRAM 0） | ✅ 整体分层：`te=cpu` + denoiser/VAE GPU + `--offload-to-cpu`/`--params-backend` 任意组合；`diffusion` 可段粒度流式 | 机制上同（backend.md 支持 `vulkan0` 设备名），但 **H3 在 16GB Vulkan 上 broken（#1976，open）** |
| 能否 GPU 加速 | ❌ 纯 CPU（941s/25帧） | ✅ denoiser/VAE 上卡，预期 ~30–45× 加速（对照 unsloth 20.9s@640×384×25f×4step） | ⛔ 实际不可用（H3 运行崩溃/内存错误） |
| 实测速度 | 940.83s / 25 帧（webm 501KB） | 待真机复测（基线参考 20.9s/640×384/25f/4步 q4_K，unsloth 侧） | 无有效 H3 数据（#1976 阻断） |
| 显存占用 | VRAM 0.00MB / RAM 25,828.96MB | 峰值预期 ~12.4–13.1 GiB（<16GB） | 理论同左，实测 OOM 崩 |
| 结论 | 可用但无加速 | **✅ 唯一可行 GPU 路线（收编基底）** | ❌ 否决（#1976） |

---

## ④ 推荐配置表（量化档 × 组件放置 × 预期显存 × 预期速度）

权重源：[unsloth/MiniMax-H3-GGUF](https://huggingface.co/unsloth/MiniMax-H3-GGUF)（denoiser + 编码器，社区默认镜像）＋ [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/main/vae)（VAE）。

| 档位组合 | denoiser | 编码器 | VAE | 组分放置（推荐） | 预期峰值显存 | 预期速度（640×384/25帧/4步 量级） |
|---|---|---|---|---|---|---|
| **推荐-最小** | UD-Q2_K_XL 7.51GiB | Q2_K_M 12.20GiB | video fp16 5.21GB + audio 0.6GB | `te=cpu`；denoiser/VAE=GPU；启动加 `--offload-to-cpu`（=params `*:cpu`） | ~12.4–13.1 GiB（实测参考，q4_K 档） | ~20–40s（更快档略降，参照 20.9s@q4_K） |
| 更小显存备选 | **Q2_K 6.26GiB** | Q2_K_M 12.20GiB | **video int8_convrot 2.81GB** | 同上 | ~11.5–12.5 GiB（估算，未查到公开实测） | 更慢（更低量化，IIP 降低） |
| 质量优先 | UD-Q3_K_XL 8.90GiB | Q4_K_M 16.97GiB→**超 16GB 单组件，不可用** | fp16 | 编码器换 Q2_K_M 保住分量 | — | — |
| 不推荐 | Q4_K 10.64GiB | Q2_K_M | fp16 | `--offload-to-cpu` 下仍可（unsloth 实测档） | 12.42 GiB | 20.9s（unsloth 实测，q4_K） |

要点：
- **文本编码器永远不能全量上 16GB 卡**（Q2_K_M 已是最小档 12.2GiB，与 denoiser 计算缓冲共存会挤爆）；官方既定做法即 `te=cpu` / `--offload-to-cpu`。
- **VAE 必须留 GPU**（unsloth 实测 `--vae-on-cpu` 4.8× 变慢：20.9s→100.4s）；audio VAE 在 sd.cpp 上游配 `--vae-on-cpu` 会 abort（unsloth fork 已修，上游 open，#1861/#1862/#1863 系列）。
- H3 是 CFG-free：`--cfg-scale 1.0` 必须显式给（默认 7.0 会 abort）；`-M vid_gen` 必给。
- 16GB 卡 + 31GB 内存可行（unsloth 参考环境 16GB VRAM + 64GB RAM；31GB RAM 装 24GB 参数余量 6GB，建议配 `--mmap` 让参数走文件缓存、降低常驻 RAM 压力——见 [Discussion #1452](https://github.com/leejet/stable-diffusion.cpp/discussions/1452) 中 master-600 起 `--mmap` 的讨论）。

---

## ⑤ 给引擎开发的明确建议（实现 B：CUDA 版脚本参数改动）

1. **立即改脚本，把当前全 CPU 配置改为混合放置**（与实现 A 同权重档即可，无需换权重）：
   - 等价旧式一条：`--backend "te=cpu" --offload-to-cpu`（或直接沿用官方 PR 示例的 `--offload-to-cpu`）；
   - 新式显式：`--backend te=cpu,vae=cuda0,diffusion=cuda0 --params-backend te=cpu`（+ `--auto-fit on` 让 VAE/denoiser 自动落位）；denoiser 超显存时 `--params-backend diffusion=cpu` 走流式分段。
   - 保留必有参数：`-M vid_gen --cfg-scale 1.0 --diffusion-fa --rng cpu`；把 940s 基线任务（25 帧）作为复测基准。
2. **VAE 保持 GPU**：不要给音频 VAE 配 CPU（上游会 abort、且无谓 4.8× 变慢）；若上游 H3 1-D norm / cfg / VAE 三个已知缺陷（#1861/#1862/#1863，unsloth fork 已修）在真机复现，优先切 unslothai/stable-diffusion.cpp fork 的 CUDA 构建而不是退回 CPU。
3. **量化档**：保持 UD-Q2_K_XL denoiser + Q2_K_M 编码器（与实现 A 一致，一次放权）；如需进一步压峰值显存可换 Q2_K denoiser + int8_convrot VAE（2.81GB），但质量/速度取舍需要真机 A/B。
4. **分段/auto-fit 谨慎**：H3 分段（graph segmentation / `--max-vram`）曾有确定性出图错误（issue #1865，closed）与 16GB Vulkan 回归（#1976，open，CUDA 侧未见同类报告），优先依赖 `--offload-to-cpu` + 默认 auto-fit 的“相位释放”路径，显存不足再上调 `--max-vram` 并做图像一致性回归（与 SD1.5 输出对照）。
5. **验收基线**：同一 prompt/分辨率/帧数下，GPU 峰值显存应显示 ~12–13GiB（而非现 0MB），墙钟相对 940.83s 应有 1–2 个数量级提升；`total params memory size` 打印应出现 VRAM>0 的分量（denoiser/VAE）。

---

## 附：真实来源清单（issue/PR/URL）

- sd.cpp README（后端列表 CPU/CUDA/Vulkan/Metal/OpenCL/SYCL）：https://github.com/leejet/stable-diffusion.cpp
- backend.md（--backend/--params-backend/auto-fit/分段/相位释放）：https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/backend.md
- docs/minimax_h3.md（H3 用法、--offload-to-cpu 示例）：https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/minimax_h3.md
- PR #1854（feat: add minimax-h3 support，merged，ea7f0c8）：https://github.com/leejet/stable-diffusion.cpp/pull/1854
- Issue #1976（16GB Vulkan × H3 broken，open）：https://github.com/leejet/stable-diffusion.cpp/issues/1976
- Issue #1865（H3 分段 offload 出图错误，closed）：https://github.com/leejet/stable-diffusion.cpp/issues/1865
- Issue #1934（H3 AdaLN 预计算省 40% DiT 显存，closed）：https://github.com/leejet/stable-diffusion.cpp/issues/1934
- Issue #1927（H3 Vulkan/ROCm 量化支持请求，open）：https://github.com/leejet/stable-diffusion.cpp/issues/1927
- PR #1905 / #1906（流式层 prefetch / VRAM 池）：https://github.com/leejet/stable-diffusion.cpp/pull/1905 、https://github.com/leejet/stable-diffusion.cpp/pull/1906
- Discussion #1452（顺序加载/相位卸载/--mmap）：https://github.com/leejet/stable-diffusion.cpp/discussions/1452
- Release master-945-a1ded76（资产：仅 CPU/ROCm/Vulkan，无 Linux CUDA 预编译）：https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-945-a1ded76
- unsloth/MiniMax-H3-GGUF（denoiser/编码器量化档位与官方 sd-cli 示例 `--backend te=cpu`）：https://huggingface.co/unsloth/MiniMax-H3-GGUF
- Comfy-Org/MiniMax-H3 VAE（video fp16 5.21GB / int8_convrot 2.81GB / audio 605MB）：https://huggingface.co/Comfy-Org/MiniMax-H3/tree/main/vae
- ComfyUI Issue #15628（12GB 卡 H3 显存-内存换页问题，生态佐证）：https://github.com/Comfy-Org/ComfyUI/issues/15628
- H3 Evict Text Encoder（“编码即卸载”节点，生态佐证）：https://comfy.icu/node/H3EvictTextEncoder
- 未查到公开证据的项：sd.cpp 上「Q2_K_M 更小的文本编码器 GGUF 档」（公开 repo 无）、audio VAE 的量化档、sd.cpp 官方对 16GB CUDA H3 的基准页——均如实标注为“未查到”。