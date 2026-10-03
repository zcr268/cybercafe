# CyberCafe OCR（文字识别流程，v1.0）

轻量 OCR 文字识别部署（**RapidOCR / onnxruntime**，CPU 推理，模型随 pip 包内置、零外部权重下载）。

## 方案

| 项 | 说明 |
|---|---|
| 引擎 | `rapidocr_onnxruntime`（det/rec/cls 三模型内置，中英文） |
| 推理 | CPU（onnxruntime），不占 GPU（目标机 RTX 4080 SUPER 留给模型部署） |
| 隔离 | 独立 venv（`/opt/cybercafe-ocr/venv`），pip 依赖不污染系统 |
| 服务 | systemd `cybercafe-ocr.service`，监听 `127.0.0.1:8820`（可选端口），开机自启 |
| 卸载 | `uninstall.sh` 一键全面清理（`--keep` 可保留模型/venv） |

## 安装

```bash
# 仓库 ocr/ 目录下（install.sh/ocr.py 同目录）
bash install.sh                 # 默认端口 8820，pip 源=清华镜像
bash install.sh --port 9900 --index https://mirrors.aliyun.com/pypi/simple/
# 环境变量: PIP_INDEX / OCR_PORT
```

安装完成自动：venv + rapidocr → systemd 单元 → 启动 → 健康检查（首次运行提取模型 10-60s）。

## 使用

```bash
# CLI（识别本地图片或远程 URL）
/opt/cybercafe-ocr/venv/bin/python /opt/cybercafe-ocr/ocr.py /tmp/scan.png
/opt/cybercafe-ocr/venv/bin/python /opt/cybercafe-ocr/ocr.py https://example.com/scan.jpg

# HTTP 服务（127.0.0.1:8820，仅本机；如需公网走 agent 隧道/网关接入）
curl -s http://127.0.0.1:8820/health
curl -s -X POST http://127.0.0.1:8820/ocr -H 'Content-Type: application/json' \
     -d '{"url":"https://example.com/scan.png"}'
curl -s -X POST http://127.0.0.1:8820/ocr -d '{"image_base64":"<base64>"}'
# 响应: {"ok":true,"text":"...","lines":[{"text":"...","score":0.99}],"elapsed_ms":123}
```

## 卸载（全面清理）

```bash
bash /opt/cybercafe-ocr/uninstall.sh        # 全删：服务/进程/venv(依赖+模型)/缓存/目录
bash /opt/cybercafe-ocr/uninstall.sh --keep # 保留 venv+模型（只停服务删单元），快速重装
```

- 默认卸载后系统仅保留 `install.sh / uninstall.sh / README.md`（重装/管理用），OCR 依赖、模型、缓存、进程、服务全部清除。
- 可逆性：模型/依赖删除不可逆（`--keep` 可保留）；能力恢复只需保留仓库 `ocr/` 目录重跑 `install.sh`。

## 验证（开发自验记录）

- 目标机 tower-zjC5pkGWm（Ubuntu 24.04 / Py3.12 / 32G）真实图片（中英文）→ CLI 与 HTTP 均输出预期文字
- 卸载后：服务 inactive、端口无监听、venv/缓存已删、目录仅剩三件套
- 真机完整验收（接入聊天/管理端）归测试任务
