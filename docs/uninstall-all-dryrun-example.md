# uninstall-all.sh —— dry-run 清单示例与自验证据

> 版本：v0.3.7+（commit f755afe）。真机全链路清理验收归 t29（测试任务），本文件为开发自验证据。

## 1. 用法

```bash
bash uninstall-all.sh --dry-run    # 只读列出将被删项（推荐先执行）
bash uninstall-all.sh              # 交互确认（输入 yes）
bash uninstall-all.sh --yes        # 跳过交互
bash uninstall-all.sh --purge-all  # 输出"也清 NVIDIA 驱动"的说明（默认不执行）
```

⚠️ 删除全部模型与引擎数据，**不可恢复**；脚本必须存放在清理目录外（自带自删防护）。

## 2. 真机 dry-run 清单（真实输出，tower-zjC5pkGWm @ 2026-10-03，未做任何修改）

```text
[uninstall-all] 探测到的将被清理对象：
------------------------------------------------------------
container ollama
container chatgw
container cloudflared
image ollama/ollama:latest
image ollama/ollama:<none>
image cloudflare/cloudflared:latest
image nginx:alpine
image lmsysorg/sglang:v0.5.15-cu129
image lmsysorg/sglang:v0.4.1.post4-cu121
image vllm/vllm-openai:v0.4.1
volume ollama
volume vllm-hf
volume sglang-hf
dir /opt/strata
dir /opt/Strata-data
dir /opt/cybercafe-ocr
dir /opt/minimax-h3
process sglang
process ollama
------------------------------------------------------------
[uninstall-all] dry-run 模式：仅列出以上对象，未执行任何修改。
```

即真实生产内容（生产 ollama 部署 + 双版本 sglang 镜像 + vllm 镜像 + strata/OCR/MiniMax H3 目录
+ 引擎数据卷 + 原生进程）全部被识别；不存在的项（`/models`、HF 缓存等）自动跳过；系统组件
（NVIDIA 驱动/docker/agent）不在清单内——`nvidia-smi`、`/opt/cybercafe` 默认保留。

## 3. 沙箱真实执行验证（DinD，真实工件非 mock）

造真实工件：5 容器（ollama/vllm/sglang/chatgw/cloudflared）× 5 引擎镜像 × 3 数据卷
（含假模型权重）+ `/opt/strata`（含 `serve/server.py` 进程）+ `/opt/Strata-data` +
`/opt/cybercafe-ocr` + `/opt/minimax-h3` + `/models` + HF/rapidocr/onnx 缓存 +
`/usr/local/bin/sglang` 二进制 + `serve/server.py`/`sglang` 真实进程 + `/opt/cybercafe/keep.marker`。

- `--dry-run`：清单与工件一一对应（container×5/image×5/volume×3/dir×9/process×2/bin×1）；
- `--yes` 实际执行：退出码 **0**，核对清单全绿；
- 独立复核：容器 `[]`、镜像仅 `alpine:latest`（基底）、卷 `[]`、9 个目录与二进制全部删除、
  引擎进程无残留、`/opt/cybercafe/keep.marker` 原样保留、脚本自身保留、
  日志写入 `/var/log/cybercafe-uninstall-all.log`。

## 4. 系统级留白确认

- NVIDIA 驱动 / nvidia-container-toolkit / docker / containerd / cybercafe agent（`/opt/cybercafe`
  与 systemd 服务）默认保留，脚本内不包含任何相关删除动作；
- `--purge-all` 仅打印清驱动的手动步骤（先 unhold nvidia-* 再 purge、需重装 ≥550/580 线），默认不执行；
- 本仓库范围外残留（ModelSphere PoC：`/root/ms-poc`、`/var/lib/rancher`、k3s-cuda 镜像）默认不清理，需人工决策。