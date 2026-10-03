# MiniMax H3 本地部署（minimax-h3/）

MiniMax H3 是 MiniMax 开源的 **omni-modal（全模态）生成系统**（2026 年开源），不是纯文本聊天模型：
以文本/图像/视频/音频统一输入，生成**视频 + 原生立体声**（≤15 秒、最高 2K、24FPS、32kHz 立体声）。
本目录提供目标机（Ubuntu 24.04 + NVIDIA 16GB 显存）上的最小可跑档一键安装/卸载脚本。

## ① 规格核实结论（2026-10-02 web 调研）

| 项 | 结论 |
|---|---|
| 开源？ | 是（MiniMax-AI/MiniMax-H3，H3-Base 两个 checkpoint 开源；H3-Context-IR / H3-Regenerate-2K 仅托管 API） |
| 参数量 | ~33B（H3-Omni-Transformer，其中 ~13B 在 AdaLN 分支、推理可预计算不加载）+ Qwen3-VL-32B 文本编码器（H3-Encoder，取第 50 层 hidden states）+ VisualVAE + AudioVAE |
| 官方格式 | HuggingFace diffusers 风格（FL2VA/Ref2VA + transformer + text_encoder + visual/audio vae） |
| 官方地址 | HF: [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) · GitHub: [MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3) · 镜像（国内）: ModelScope minimax 组织 |
| GGUF 量化 | [unsloth/MiniMax-H3-GGUF](https://huggingface.co/unsloth/MiniMax-H3-GGUF)：denoiser fl2va/ref2va Q2_K(6.3GiB)~Q8_0(20GiB)；文本编码器 qwen3vl_32b_minimax_h3 Q2_K_M(12.2GiB)/Q4_K_M(17GiB)；[Abiray/MiniMax-H3-GGUF](https://huggingface.co/Abiray/MiniMax-H3-GGUF)（Q4_K_M 14.6GB） |
| 许可 | MiniMax H3 Community License；**适用地域排除美国/欧盟/英国/韩国**（中国大陆适用 ✓，使用前请自行确认合规） |
| 官方运行时 | SGLang（官方示例 **4×GPU**）/ vLLM / diffusers / ComfyUI —— 单卡 16GB 不可行 |
| 下载体积 | 最小可跑档（本方案）≈ 20GB：UD-Q2_K_XL denoiser 7.5GiB + 文本编码器 Q2_K_M 12.2GiB + 2×VAE |

## ② 目标机可行性结论（RTX 4080 SUPER 16GB + 31GB 内存，四引擎并存）

- **官方档（SGLang/vLLM 4 卡）→ 不可行**（单卡），如实说明。
- **GGUF + stable-diffusion.cpp 档 → 可行**：文本编码器放 CPU（`--backend te=cpu`，12.2GiB 内存），
  denoiser 最小档 UD-Q2_K_XL（7.5GiB）按需加载。若显存被四引擎占用（实测 sglang 常驻 ~13.3GB），
  sd.cpp 自动降级 CPU 全卸载（本机 24.8GB 可用内存可容纳 Q2 全 CPU 档，速度慢但可跑通）。
- 本仓库验证口径：**跑通流程（文本→短视频生成）**，384x224/9 帧/4 步 CPU 冒烟；
  官方 2K/15s 全质量档需要多卡或专用部署，超出本机能力（如实记录，不算失败）。

## ③ 安装 / 卸载

```bash
# 一键安装（幂等、断点续传；约 20GB 下载；冒烟验证通过才算成功）
bash minimax-h3/install.sh
# 可选：启用常驻 sd-server（独立端口 17888，HTTP POST /sdcpp/v1/vid_gen）
H3_ENABLE_SERVER=1 H3_SERVER_PORT=17888 bash minimax-h3/install.sh

# 一键卸载（删除全部权重/二进制/缓存/日志/进程，/opt/minimax-h3 整体移除，零系统残留）
bash minimax-h3/uninstall.sh
```

手工生成示例：

```bash
/opt/minimax-h3/bin/sd-cli -M vid_gen \
  --diffusion-model /opt/minimax-h3/models/minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf \
  --llm /opt/minimax-h3/models/qwen3vl_32b_minimax_h3-Q2_K_M.gguf \
  --vae /opt/minimax-h3/models/minimax_h3_video_vae_fp16.safetensors \
  --audio-vae /opt/minimax-h3/models/minimax_h3_audio_vae_fp32.safetensors \
  -p "a tiny red robot walking on a mossy rock, cinematic" \
  --cfg-scale 1.0 -W 640 -H 384 --video-frames 25 --fps 24 \
  --rng cpu --backend te=cpu -o out.webm
```

## ④ 与现有四引擎并存 / 端口 / 卸载说明

- **端口**：默认 CLI 批式生成，无常驻服务，不占 11434/8000/30000 等既有端口；可选 sd-server 用
  独立 127.0.0.1:17888（`H3_SERVER_PORT` 可改）。
- **显存**：与 ollama/vllm/sglang/strata 分时共用 GPU（sglang 常驻 ~13.3GB 时自动 CPU 卸载）。
- **卸载可逆性**：uninstall.sh 仅删除 `/opt/minimax-h3`（权重/二进制/日志/产物）与可能的 HF 缓存与
  预下载脚本，**不安装也不卸载任何系统包/服务**（预编译二进制方案）；重跑 install.sh 即恢复。
- **接入云管 ENGINES**：H3 为批式生成模型、非 OpenAI 兼容对话服务，暂不接入云管 ENGINES 目录
  （与 ollama/vllm/sglang 的聊天语义不同）；如需暴露可自建 sd-server + 轻量网关，后续任务再议。

## ⑤ 验证记录（真机 tower-zjC5pkGWm，2026-10-02/03）

- install.sh 全流程：环境预检 → sd.cpp 预编译下载 → hf-mirror 26GB 权重下载（16:49–16:58，~33MB/s）→ 冒烟生成。
- 生成跑通（**真实证据**，CPU Q2 最小档 384x224@9 帧）：`generate_video completed in 940.83s`、
  `decode_first_stage completed`、`RC=0`，产物 `h3_smoke_evidence.webm`（513KB，Matroska/webm，含 32kHz 立体声轨）。
  - 注：H3 为**视频生成模型**（非聊天 LLM），「聊天 200」验证语义不适用，以真实生成退出码 0 + 产物替代；
    需要 HTTP 验证时可 `H3_ENABLE_SERVER=1 H3_SERVER_PORT=17888` 启用 sd-server（`POST /sdcpp/v1/vid_gen`，独立端口）。
- 与四引擎并存：运行时未占用 11434/8000，未停止/改动 sglang/ollama/nginx/cloudflared；显存不足时 sd.cpp 自动 CPU 卸载。
- **已知机器故障（外部，非本部署所致）**：2026-10-03 17:15 起 tower 根分区 `/`（ext4，设备
  `swadminblock0p2`）被内核置为 `emergency_ro`（只读），日志显示 ext4 journal 中止（`Detected aborted journal`，
  首次 17:20:03；该机为软件定义块设备 + k3s/swadmin 栈）。后果：`/opt/minimax-h3` 无法写入，**uninstall.sh 执行
  验证被阻塞**（脚本逻辑已就绪且静态正确）。
- **恢复与收尾**：tower 需 `reboot`（启动时 ext4 journal 回放）+ 必要时 `e2fsck -f /dev/swadminblock0p2`；
  恢复后重跑 `bash minimax-h3/install.sh`（已下载文件跳过，幂等）→ `bash minimax-h3/uninstall.sh` 即可完成
  卸载验证（预计 ~20 分钟；install.sh 支持 `H3_OUT_DIR=/dev/shm` 在紧急只读场景兜底）。

## ⑥ 静态检查 / 资产

- `install.sh` / `uninstall.sh`：`bash -n` 通过；install 幂等（`curl -C -`）、零系统包安装、可选独立端口 server。
- 证据文件（本目录）：`h3_smoke_evidence.webm`、`h3_vidgen_evidence.log`（sd-cli 完整运行日志）。
- 具体输出与证据见对应任务执行记录（真机完整验收归测试任务）。
