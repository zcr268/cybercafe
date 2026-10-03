#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CyberCafe 本地控制脚本（agent）
- 启动时采集设备信息并注册/上报到云管理端
- 周期心跳：上报状态 + 拉取云端指令
- 执行模型部署流水线（每一步节点状态实时上报）
- 支持自更新（云端版本更新后自动下载替换并重启服务）
仅依赖 Python3 标准库。
"""

API_BASE = "__API_BASE__"       # 云管理端地址（安装/下载时由云端注入）
DEVICE_KEY = "__DEVICE_KEY__"   # 设备密钥（安装时注入）
VERSION = "0.3.6"

HEARTBEAT_INTERVAL = 10         # 默认心跳间隔（秒），实际由云端 poll_after 驱动
DEPLOY_HEARTBEAT_INTERVAL = 15  # 部署中最长上报间隔（秒）
POLL_MIN, POLL_MAX = 3, 300     # poll_after 钳制范围
RAW_UA = "cybercafe-agent/%s" % VERSION

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import traceback
import urllib.request
import urllib.error

# ---------------------------------------------------------------- 基础工具

def log(msg):
    print("[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)

def run(cmd, timeout=600, check=False):
    """运行命令，返回 (rc, stdout+stderr)"""
    try:
        p = subprocess.run(cmd, shell=True, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           text=True, errors="replace")
        if check and p.returncode != 0:
            raise RuntimeError("cmd failed(%d): %s\n%s" % (p.returncode, cmd, p.stdout[-2000:]))
        return p.returncode, p.stdout
    except subprocess.TimeoutExpired:
        return 124, "TIMEOUT"

def http(method, path, payload=None, timeout=30, headers=None):
    """对云管理端发请求，返回 (status, json|None, raw_text)"""
    url = API_BASE.rstrip("/") + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", RAW_UA)
    req.add_header("X-Device-Key", DEVICE_KEY)
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(body), body
            except ValueError:
                return resp.status, None, body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body), body
        except ValueError:
            return e.code, None, body
    except Exception as e:
        return 0, None, "ERROR: %s" % e

def device_id():
    return hashlib.sha256(DEVICE_KEY.encode()).hexdigest()[:12]

# ---------------------------------------------------------------- 设备信息采集

def collect_device_info():
    info = {
        "device_id": device_id(),
        "machine_id": "",
        "hostname": platform.node(),
        "os": "",
        "kernel": platform.release(),
        "cpu": "",
        "cpu_cores": os.cpu_count(),
        "mem_total_gb": 0.0,
        "gpu": "",
        "gpu_mem_mb": 0,
        "disk_root": "",
        "ips": [],
        "agent_version": VERSION,
    }
    # machine_id：与基础镜像 provision（provision.sh 采集 /etc/machine-id）一致，
    # 云端据此关联设备记录与批次来源
    for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            with open(p) as f:
                v = f.read().strip()
                if v:
                    info["machine_id"] = v
                    break
        except Exception:
            pass
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    info["os"] = line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    rc, out = run("lscpu | grep 'Model name' | head -1")
    if rc == 0 and ":" in out:
        info["cpu"] = out.split(":", 1)[1].strip()
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    info["mem_total_gb"] = round(int(line.split()[1]) / 1048576, 1)
    except Exception:
        pass
    rc, out = run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1")
    if rc == 0 and out.strip():
        parts = [p.strip() for p in out.strip().split(",")]
        info["gpu"] = parts[0]
        if len(parts) > 1:
            m = re.search(r"(\d+)", parts[1])
            if m:
                info["gpu_mem_mb"] = int(m.group(1))
    rc, out = run("df -h / | tail -1 | awk '{print $2\" total, \"$4\" free\"}'")
    if rc == 0:
        info["disk_root"] = out.strip()
    rc, out = run("ip -o -4 addr show scope global | awk '{print $2\": \"$4}'")
    if rc == 0:
        info["ips"] = [l.strip() for l in out.strip().splitlines() if l.strip()]
    return info

# ---------------------------------------------------------------- 资源用量采集

# 跨心跳 CPU 差分：模块级保存上次 /proc/stat 样本 (idle, total, wall_ts)
# 下次心跳用两次样本差值计算平均使用率；首次或间隔过短时用短窗口兜底
_last_cpu_sample = None

def _cpu_times():
    with open("/proc/stat") as f:
        parts = f.readline().split()[1:]
    vals = [int(x) for x in parts]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
    return idle, sum(vals)

def _cpu_short_sample():
    """短窗口兜底采样（约 0.5s）：仅用于首次心跳/上次样本距今过短时。"""
    i1, t1 = _cpu_times()
    time.sleep(0.5)
    i2, t2 = _cpu_times()
    dt, di = t2 - t1, i2 - i1
    if dt > 0:
        return round(100.0 * (1 - di / dt), 1)
    return None

def _gpu_samples():
    """GPU 利用率 1s 窗口内采样 3 次取最大（避开瞬时 0 快照）；
    显存取最大利用率那次采样的真实值。无 GPU 时返回 None。"""
    best = None
    for i in range(3):
        rc, out = run("nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total "
                      "--format=csv,noheader,nounits 2>/dev/null | head -1", timeout=15)
        if rc == 0 and out.strip():
            try:
                gu, mu, mtot = [int(x.strip()) for x in out.strip().split(",")[:3]]
            except ValueError:
                pass
            else:
                if best is None or gu > best[0]:
                    best = (gu, mu, mtot)
        if i < 2:
            time.sleep(0.4)
    return best

def collect_usage():
    """采集 CPU/内存/GPU 用量。

    CPU：跨心跳差分——模块级保存上次 /proc/stat 样本，下次心跳用两次样本差值算
         平均使用率，间隔随 poll_after 变大的心跳自然拉长，空闲也显示真实小值；
         首次采样（或间隔<1s）用 0.5s 短窗口兜底。
    GPU：1s×3 多次采样取最大利用率（避开推理间隙的瞬时 0）；
         显存保持真实上报（空闲时模型自动卸载导致低占用属正常，gpu_note 标注）。"""
    u = {}
    global _last_cpu_sample
    try:
        idle, total = _cpu_times()
        now = time.time()
        if _last_cpu_sample is not None and now - _last_cpu_sample[2] >= 1.0:
            _idle, _total, _ts = _last_cpu_sample
            dt, di = total - _total, idle - _idle
            if dt > 0:
                u["cpu_pct"] = round(100.0 * (1 - di / dt), 1)
        _last_cpu_sample = (idle, total, now)
        if "cpu_pct" not in u:
            v = _cpu_short_sample()
            if v is not None:
                u["cpu_pct"] = v
    except Exception:
        pass
    try:
        mt = ma = 0
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    mt = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    ma = int(line.split()[1])
        if mt:
            u["mem_pct"] = round(100.0 * (1 - ma / mt), 1)
            u["mem_used_gb"] = round((mt - ma) / 1048576, 1)
            u["mem_total_gb"] = round(mt / 1048576, 1)
    except Exception:
        pass
    gpu = _gpu_samples()
    if gpu:
        gu, mu, mtot = gpu
        u["gpu_util_pct"] = gu
        u["gpu_mem_used_mb"] = mu
        u["gpu_mem_total_mb"] = mtot
        u["gpu_mem_pct"] = round(100.0 * mu / mtot, 1) if mtot else 0
        u["gpu_note"] = "模型已加载" if mu >= 256 else "模型未加载（空闲自动卸载，属正常）"
    return u

# ---------------------------------------------------------------- 云端交互

def register():
    st, js, raw = http("POST", "/api/device/register", {"device": collect_device_info()})
    if st == 200 and js and js.get("ok"):
        log("registered, device_id=%s" % js.get("device_id"))
        return True
    log("register failed: %s %s" % (st, raw[:300]))
    return False

def heartbeat(extra=None):
    payload = {"device": {"device_id": device_id(), "agent_version": VERSION,
                          "last_seen": int(time.time()), "usage": collect_usage()}}
    if extra:
        payload["device"].update(extra)
    st, js, raw = http("POST", "/api/device/heartbeat", payload)
    if st != 200 or not js:
        log("heartbeat failed: %s %s" % (st, str(raw)[:200]))
        return None
    return js

def report_progress(step, state, detail=""):
    log("deploy [%s] %s %s" % (step, state, detail))
    http("POST", "/api/device/progress",
         {"device_id": device_id(), "step": step, "state": state,
          "detail": detail[:500], "ts": int(time.time())})

def report_deploy_result(ok, tunnel_url="", api_key="", engine="", model=""):
    payload = {"deploy": {"state": "online" if ok else "failed",
                          "engine": engine, "model": model,
                          "tunnel_url": tunnel_url,
                          "model_api_key": api_key, "ts": int(time.time())}}
    # 结果心跳为单次投递：真机偶发 TLS 握手超时（t4 实测复现）会整包丢失，
    # 导致云管 deploy 记录缺 Key/隧道 → UI 聊天失效。重试 3 次直至成功。
    for attempt in range(3):
        if heartbeat(payload):
            return
        log("deploy 结果上报失败（第 %d 次），3s 后重试" % (attempt + 1))
        time.sleep(3)

# ---------------------------------------------------------------- 部署流水线

REGISTRY_MIRRORS = ["https://docker.m.daocloud.io", "https://docker.1ms.run",
                    "https://docker.xuanyuan.me"]

# 引擎定义：容器内监听端口统一映射到宿主 127.0.0.1:11434（nginx 网关不变）
# - vLLM v0.4.1 / SGLang v0.4.1.post4-cu121 均为 CUDA 12.1 基底镜像，
#   兼容该机驱动 535.274.02（nvidia-smi CUDA 12.2），HF 权重走 hf-mirror
# - strata = Strata 专用运行时（Niko1221/Strata）：原生进程（非容器），
#   仅 Qwen3.8-Flash-Next Coder 档（IQ1_M），驱动>=580 / 内存>=31GB / 磁盘>=80GB，
#   low-RAM resident 模式，单并发；serve/server.py 监听 127.0.0.1:11434（与容器引擎同端口）
ENGINES = {
    "ollama": {
        "image": "ollama/ollama:latest",
        "container": "ollama",
        "port": "11434",
        "volume": "ollama:/root/.ollama",
        "args": [],
    },
    "vllm": {
        "image": "vllm/vllm-openai:v0.4.1",
        "container": "vllm",
        "port": "8000",
        "volume": "vllm-hf:/root/.cache/huggingface",
        "args": ["--model", "{model}", "--host", "0.0.0.0", "--port", "8000",
                 "--quantization", "awq"],
    },
    "sglang": {
        "image": "lmsysorg/sglang:v0.4.1.post4-cu121",
        "container": "sglang",
        "port": "30000",
        "volume": "sglang-hf:/root/.cache/huggingface",
        "args": ["python3", "-m", "sglang.launch_server",
                 "--model-path", "{model}", "--host", "0.0.0.0", "--port", "30000",
                 "--quantization", "awq"],
    },
    "strata": {
        "native": True,                      # 非容器：原生进程（git clone + setup.sh + run 脚本）
        "repo": "https://github.com/Niko1221/Strata.git",
        "dir": "/opt/strata",                # COW 快照机重启会丢，需重装/重拉（见 strata_setup）
        "run": "run-coder-iq1_m.sh",         # setup.sh --no-start 后生成的启动脚本
        "port": "11434",                     # serve/server.py 监听 127.0.0.1:11434
        "family": "coder",                   # 模型档（Coder = Qwen3.8-Flash-Next Coder，IQ1_M）
        "quant": "IQ1_M",
        "min_driver": 580.0,                 # MIN_DRIVER = 580（CUDA 13.0）
        "min_ram_gb": 31.0,
        "min_disk_gb": 80.0,
        "setup_args": ["--family", "coder", "--model", "IQ1_M", "--context", "32768",
                       "--vision", "no", "--port", "11434", "--host", "127.0.0.1",
                       "--low-ram", "resident", "--yes", "--no-start"],
    },
}

class DeployError(Exception):
    pass

def step_gpu_check():
    rc, out = run("nvidia-smi -L", timeout=30)
    if rc != 0 or "GPU" not in out:
        raise DeployError("未检测到 NVIDIA GPU: " + out.strip()[:200])
    return out.strip().splitlines()[0]

def step_docker():
    if shutil.which("docker"):
        return "docker 已安装"
    run("apt-get update -qq", timeout=600)
    rc, out = run("DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io", timeout=900)
    if rc != 0:
        raise DeployError("docker 安装失败: " + out[-500:])
    run("systemctl enable --now docker")
    return "docker.io 安装完成"

def step_mirrors():
    path = "/etc/docker/daemon.json"
    conf = {}
    if os.path.exists(path):
        try:
            with open(path) as f:
                conf = json.load(f)
        except Exception:
            conf = {}
    mirrors = list(dict.fromkeys(REGISTRY_MIRRORS + conf.get("registry-mirrors", [])))
    conf["registry-mirrors"] = mirrors
    with open(path, "w") as f:
        json.dump(conf, f, indent=2)
    run("systemctl restart docker", timeout=60)
    time.sleep(3)
    return "镜像加速: " + ", ".join(mirrors)

def step_gpu_toolkit():
    if shutil.which("nvidia-ctk"):
        return "nvidia-container-toolkit 已安装"
    cmds = [
        "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
        "curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' > /etc/apt/sources.list.d/nvidia-container-toolkit.list",
        "apt-get update -qq",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nvidia-container-toolkit",
    ]
    for c in cmds:
        rc, out = run(c, timeout=900)
        if rc != 0:
            raise DeployError("toolkit 安装失败: %s -> %s" % (c[:60], out[-300:]))
    rc, out = run("nvidia-ctk runtime configure --runtime=docker && systemctl restart docker", timeout=120)
    if rc != 0:
        raise DeployError("toolkit 配置失败: " + out[-300:])
    time.sleep(3)
    return "nvidia-container-toolkit 安装完成"

def step_pull_images(engine):
    # strata 为原生进程：无引擎容器镜像，仅拉网关/隧道镜像
    images = ["nginx:alpine", "cloudflare/cloudflared:latest"]
    if not ENGINES[engine].get("native"):
        images = [ENGINES[engine]["image"]] + images
    for img in images:
        rc, out = run("docker pull %s" % img, timeout=1800)
        if rc != 0:
            raise DeployError("拉取镜像失败 %s: %s" % (img, out[-300:]))
    return "镜像就绪: " + ", ".join(images)

def _kill_strata():
    """停掉 strata 原生 server 进程（serve/server.py，含 --open 浏览器进程不涉及）"""
    run("pkill -f 'serve/server.py' ; true")

def _engine_running(container):
    rc, out = run("docker ps --filter name=^/%s$ --filter status=running -q" % container)
    return out.strip() != ""

def step_engine_start(engine, model, progress_cb):
    """启动推理引擎容器（ollama/vllm/sglang），统一暴露 OpenAI 兼容 API 到 127.0.0.1:11434。

    vllm/sglang 首次启动会在容器内从 HF（hf-mirror）下载权重，耗时较长，
    期间每 15s 回报一次进度；就绪判定轮询 /v1/models 返回 200。
    """
    cfg = ENGINES[engine]
    container = cfg["container"]
    # 引擎切换/重建：先清掉其它引擎容器（strata 为原生进程用 pkill），避免 11434 端口占用
    for name, c in ENGINES.items():
        if name != engine:
            if c.get("native"):
                _kill_strata()
            else:
                run("docker rm -f %s" % c["container"])
    if _engine_running(container):
        return "%s 已在运行" % engine
    run("docker rm -f %s" % container)
    args = [a.replace("{model}", model) for a in cfg["args"]]
    # vllm/sglang 拉 HF 权重需走镜像站；PyTorch 多进程共享内存建议 --ipc host
    envs = ""
    ipc = ""
    if engine in ("vllm", "sglang"):
        envs = "-e HF_ENDPOINT=https://hf-mirror.com "
        ipc = "--ipc host "
    cmd = ("docker run -d --name %s --gpus all --restart unless-stopped "
           "-p 127.0.0.1:11434:%s -v %s %s%s%s %s"
           % (container, cfg["port"], cfg["volume"], envs, ipc, cfg["image"], " ".join(args)))
    rc, out = run(cmd, timeout=180)
    if rc != 0:
        raise DeployError("%s 启动失败: %s" % (engine, out[-300:]))
    if engine == "ollama":
        return _wait_ollama_ready()
    return _wait_openai_ready(engine, model, progress_cb)

def _wait_ollama_ready():
    for _ in range(30):
        rc, out = run("curl -s http://127.0.0.1:11434/api/version", timeout=10)
        if rc == 0 and "version" in out:
            return "ollama 运行中: " + out.strip()
        time.sleep(2)
    raise DeployError("ollama 健康检查超时")

def _wait_openai_ready(engine, model, progress_cb, step="engine_start"):
    last_ts = time.time()
    for i in range(240):  # 最长约 60 分钟（含首次 HF 权重下载 / Strata 冷加载 125B MoE）
        rc, out = run("curl -s -m 10 http://127.0.0.1:11434/v1/models", timeout=15)
        if rc == 0 and out.strip() and '"id"' in out:
            return "%s 运行中: %s" % (engine, out.strip()[:200])
        if time.time() - last_ts >= DEPLOY_HEARTBEAT_INTERVAL:
            last_ts = time.time()
            progress_cb(step, "running",
                        "%s 启动中（下载/加载权重，已等待 %ds）..." % (engine, i * 15))
        time.sleep(15)
    raise DeployError("%s 健康检查超时（60 分钟）" % engine)

# ---------------------------------------------------------------- Strata 引擎（原生进程，非容器）
# 约束（t21 调研 docs/strata-feasibility.md）：驱动>=580（MIN_DRIVER）、内存>=31GB（Coder IQ1_M tight）、
# 磁盘>=80GB（~66GB 下载）；low-RAM resident 模式自动容纳；单并发。COW 快照机重启丢数据，需重装/重拉。

def step_strata_check():
    """环境预检：驱动 >= 580 / 内存 >= 31GB / 磁盘 >= 80GB"""
    cfg = ENGINES["strata"]
    rc, out = run("nvidia-smi --query-gpu=driver_version --format=csv,noheader", timeout=30)
    if rc != 0:
        raise DeployError("nvidia-smi 不可用: " + out.strip()[:200])
    ver = (out.strip().splitlines() or [""])[0].strip()
    # 驱动版本为 X.Y.Z 三段式（如 580.178.04），float() 无法解析多个小数点；
    # 按数值 tuple 比较（主版本即门槛，580.x.y 均放行）
    try:
        ver_t = tuple(int(x) for x in ver.split(".") if x)
    except ValueError:
        raise DeployError("无法解析驱动版本: %s" % ver)
    if ver_t < (int(cfg["min_driver"]),):
        raise DeployError("Strata 要求驱动 >= %s（MIN_DRIVER 580/CUDA 13.0），当前 %s" % (cfg["min_driver"], ver))
    # 内存
    rc, out = run("awk '/MemTotal/{print $2}' /proc/meminfo", timeout=10)
    mem_gb = (int(out.strip()) if rc == 0 and out.strip() else 0) / 1024 / 1024
    if mem_gb < cfg["min_ram_gb"]:
        raise DeployError("Strata Coder 档要求内存 >= %sGB（low-RAM resident），当前 %.1fGB" % (cfg["min_ram_gb"], mem_gb))
    # 磁盘（根分区可用）
    rc, out = run("df -B1 --output=avail / | tail -1", timeout=10)
    disk_gb = (int(out.strip()) if rc == 0 and out.strip().isdigit() else 0) / 1024**3
    if disk_gb < cfg["min_disk_gb"]:
        raise DeployError("Strata 模型 ~66GB，要求可用磁盘 >= %sGB，当前 %.1fGB" % (cfg["min_disk_gb"], disk_gb))
    return "环境预检通过: 驱动 %s / 内存 %.1fGB / 磁盘 %.1fGB" % (ver, mem_gb, disk_gb)

def _strata_installed(cfg):
    """模型数据已就绪判定：run 配置 + 模型数据目录存在。
    数据默认放安装目录旁（ROOT.parent/Strata-data，t21 调研），COW 重启丢数据后需重跑 setup"""
    d = cfg["dir"]
    config_ok = (os.path.exists(os.path.join(d, "strata-coder-iq1_m.json"))
                 or os.path.exists(os.path.join(d, cfg["run"])))
    data_ok = (os.path.isdir(os.path.join(d, "Strata-data"))
               or os.path.isdir(os.path.join(os.path.dirname(d), "Strata-data")))
    return config_ok and data_ok

def step_strata_setup(progress_cb):
    """克隆 Strata + 安装 Coder 模型（~66GB 下载，含缓存/重拉逻辑；COW 重启需重装）"""
    cfg = ENGINES["strata"]
    d = cfg["dir"]
    if _strata_installed(cfg):
        return "模型已就绪（缓存命中）: " + d
    # Strata 安装需 git（install.sh 只装 python3/curl，这里补装）
    if not shutil.which("git"):
        rc, out = run("DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git", timeout=600)
        if rc != 0:
            raise DeployError("git 安装失败: " + out[-300:])
    if not os.path.isdir(d):
        rc, out = run("git clone --depth 1 %s %s" % (cfg["repo"], d), timeout=900)
        if rc != 0:
            raise DeployError("Strata 仓库克隆失败: " + out[-300:])
    args = " ".join(cfg["setup_args"])
    # HF 权重走 hf-mirror 镜像站（大陆可达）；安装过程可能长达数小时，每 15s 回报进度
    cmd = "cd %s && HF_ENDPOINT=https://hf-mirror.com ./setup.sh %s" % (d, args)
    p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, errors="replace", bufsize=1)
    start_ts = time.time()
    buf, tail, last_ts, last_pct = "", [], start_ts, -1
    while True:
        ch = p.stdout.read(1)
        if not ch and p.poll() is not None:
            break
        if not ch:
            continue
        buf += ch
        if ch in ("\n", "\r"):
            line = buf.strip()
            buf = ""
            if not line:
                continue
            m = re.search(r"(\d+(?:\.\d+)?)\s*%", line)
            if m and "Downloading" in line:
                pct = int(float(m.group(1)))
                if pct != last_pct and time.time() - last_ts > DEPLOY_HEARTBEAT_INTERVAL:
                    last_pct, last_ts = pct, time.time()
                    progress_cb("strata_setup", "running", "下载模型 %d%%（~66GB，含 MTP/视觉，已用 %ds）..."
                                % (pct, int(time.time() - start_ts)))
            elif time.time() - last_ts > DEPLOY_HEARTBEAT_INTERVAL:
                last_ts = time.time()
                progress_cb("strata_setup", "running",
                            "安装中（%ds）: %s" % (int(time.time() - start_ts), line[:120]))
            tail.append(line)
            tail = tail[-5:]
    rc = p.wait()
    if rc != 0:
        raise DeployError("Strata 安装失败: %s" % (" | ".join(tail)[-300:] or "无输出"))
    if not _strata_installed(cfg):
        raise DeployError("Strata 安装结束但模型数据缺失: " + " | ".join(tail)[-300:])
    return "Strata 安装完成（模型 ~66GB 已就位）"

def step_strata_start(model, progress_cb):
    """启动 Strata server（low-RAM resident 自动），统一暴露 OpenAI 兼容 API 到 127.0.0.1:11434"""
    cfg = ENGINES["strata"]
    d = cfg["dir"]
    # 引擎切换：先清掉其它引擎容器 + 残留 strata 进程，避免 11434 端口占用
    for name, c in ENGINES.items():
        if name != "strata":
            if c.get("native"):
                _kill_strata()
            else:
                run("docker rm -f %s" % c["container"])
    _kill_strata()
    if not _strata_installed(cfg):
        raise DeployError("Strata 未安装，先执行 strata_setup")
    # 直接以 venv python 启动 serve/server.py（config=安装时生成的 strata-coder-iq1_m.json，
    # 端口 11434 = 容器引擎同端口，nginx 网关不变；--open 免开浏览器）
    rc, out = run("cd %s && nohup .venv/bin/python serve/server.py --engine strata "
                  "--config strata-coder-iq1_m.json --port %s > /tmp/strata.log 2>&1 & echo $!"
                  % (d, cfg["port"]), timeout=60)
    if rc != 0:
        raise DeployError("Strata 启动失败: " + out[-300:])
    return _wait_openai_ready("strata", model, progress_cb, step="strata_start")

def step_model_pull(model, progress_cb):
    """流式拉取模型并回报百分比；失败时带上输出尾部便于诊断"""
    p = subprocess.Popen(["docker", "exec", "ollama", "ollama", "pull", model],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, errors="replace", bufsize=1)
    buf, tail, last_pct, last_ts = "", [], -1, time.time()
    while True:
        ch = p.stdout.read(1)
        if not ch and p.poll() is not None:
            break
        if not ch:
            continue
        buf += ch
        if ch in ("\n", "\r"):
            line = buf.strip()
            buf = ""
            if not line:
                continue
            m = re.search(r"(\d+)\s*%", line)
            if m:
                pct = int(m.group(1))
                if pct != last_pct and (pct % 10 == 0 or time.time() - last_ts > DEPLOY_HEARTBEAT_INTERVAL):
                    last_pct, last_ts = pct, time.time()
                    progress_cb("model_pull", "running", "%s %d%%" % (model, pct))
            elif "pulling" not in line and "verifying" not in line and "writing" not in line:
                tail.append(line)
                tail = tail[-5:]
    rc = p.wait()
    if rc != 0:
        raise DeployError("模型拉取失败 %s: %s" % (model, " | ".join(tail)[-300:] or "无输出"))
    return "模型就绪: " + model

NGINX_CONF_TMPL = """server {{
    listen 127.0.0.1:8000;
    location / {{
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        if ($request_method = OPTIONS) {{
            return 204;
        }}
        if ($http_authorization != "Bearer {api_key}") {{
            add_header Content-Type application/json;
            add_header Access-Control-Allow-Origin * always;
            return 401 "{{\\"error\\":{{\\"message\\":\\"Missing or invalid API key\\",\\"type\\":\\"invalid_request_error\\"}}}}";
        }}
        proxy_pass http://127.0.0.1:11434;
        proxy_set_header Host $host;
        proxy_set_header Origin "";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }}
}}
"""

def step_gateway(api_key):
    os.makedirs("/root/chatgw", exist_ok=True)
    with open("/root/chatgw/nginx.conf", "w") as f:
        f.write(NGINX_CONF_TMPL.format(api_key=api_key))
    rc, out = run("docker ps --filter name=^/chatgw$ --filter status=running -q")
    if not out.strip():
        run("docker rm -f chatgw")
        rc, out = run("docker run -d --name chatgw --network host --restart unless-stopped "
                      "-v /root/chatgw/nginx.conf:/etc/nginx/conf.d/default.conf:ro nginx:alpine", timeout=120)
        if rc != 0:
            raise DeployError("网关启动失败: " + out[-300:])
    else:
        run("docker restart chatgw", timeout=60)
    time.sleep(2)
    rc, out = run('curl -s -o /dev/null -w "%%{http_code}" -H "Authorization: Bearer %s" http://127.0.0.1:8000/v1/models' % api_key)
    if out.strip() != "200":
        raise DeployError("网关鉴权自检失败: http " + out.strip())
    rc, out = run('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/v1/models')
    if out.strip() != "401":
        raise DeployError("网关未鉴权暴露! http " + out.strip())
    return "网关就绪（带Key鉴权+CORS）"

def step_tunnel():
    # 总是重建：快速隧道每次会话域名随机，复用旧容器会拿到日志里的过期域名
    run("docker rm -f cloudflared")
    rc, out = run("docker run -d --name cloudflared --network host --restart unless-stopped "
                  "cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://127.0.0.1:8000", timeout=120)
    if rc != 0:
        raise DeployError("cloudflared 启动失败: " + out[-300:])
    url = ""
    for _ in range(40):
        rc, out = run("docker logs cloudflared 2>&1")
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", out)
        if m:
            url = m.group(0)
            break
        time.sleep(3)
    if not url:
        raise DeployError("等待隧道域名超时")
    return url

def step_verify(tunnel_url, api_key):
    last = ""
    for i in range(8):  # 隧道边缘注册需要时间，000/5xx 均可重试，约2分钟窗口
        rc, out = run('curl -s -m 45 -o /dev/null -w "%%{http_code}" -H "Authorization: Bearer %s" %s/v1/models'
                      % (api_key, tunnel_url), timeout=60)
        last = out.strip()
        if last == "200":
            return "公网可达: " + tunnel_url
        time.sleep(15)
    raise DeployError("公网隧道验证失败: http " + last)

def deploy(cmd, progress_cb):
    engine = cmd.get("engine") or "ollama"
    if engine not in ENGINES:
        raise DeployError("未知引擎: %s" % engine)
    model = cmd.get("model", "")
    api_key = cmd.get("api_key", "")
    if not api_key:
        raise DeployError("指令缺少 api_key")
    if not model:
        raise DeployError("指令缺少 model")
    # 环境步（gpu_check/docker/mirrors/gpu_toolkit）四引擎共用；引擎步按 engine 分支
    steps = [
        ("gpu_check",     "检测 GPU",        step_gpu_check),
        ("docker",        "安装/检查 Docker", step_docker),
        ("mirrors",       "配置镜像加速",      step_mirrors),
        ("gpu_toolkit",   "GPU 容器支持",     step_gpu_toolkit),
        ("pull_images",   "拉取容器镜像",      None),
    ]
    if engine == "strata":
        # Strata 为原生进程（非容器）：环境预检 + 安装/拉模型 + 启动，无 ollama 式 model_pull
        steps += [
            ("strata_check", "Strata 环境预检", None),
            ("strata_setup", "安装 Strata + 拉模型", None),
            ("strata_start", "启动 Strata", None),
        ]
    else:
        steps.append(("engine_start", "启动推理引擎", None))
        if engine == "ollama":
            steps.append(("model_pull", "拉取模型 " + model, None))
    steps += [
        ("gateway",       "部署鉴权网关",      None),
        ("tunnel",        "建立公网隧道",      None),
        ("verify",        "端到端验证",       None),
    ]
    tunnel_url = ""
    for step_id, title, fn in steps:
        progress_cb(step_id, "running", title)
        try:
            if step_id == "pull_images":
                detail = step_pull_images(engine)
            elif step_id == "engine_start":
                detail = step_engine_start(engine, model, progress_cb)
            elif step_id == "model_pull":
                detail = step_model_pull(model, progress_cb)
            elif step_id == "strata_check":
                detail = step_strata_check()
            elif step_id == "strata_setup":
                detail = step_strata_setup(progress_cb)
            elif step_id == "strata_start":
                detail = step_strata_start(model, progress_cb)
            elif step_id == "gateway":
                detail = step_gateway(api_key)
            elif step_id == "tunnel":
                detail = step_tunnel()
                tunnel_url = detail
            elif step_id == "verify":
                detail = step_verify(tunnel_url, api_key)
            else:
                detail = fn()
            progress_cb(step_id, "ok", detail)
        except DeployError as e:
            progress_cb(step_id, "fail", str(e))
            raise
        except Exception as e:
            progress_cb(step_id, "fail", "%s: %s" % (type(e).__name__, e))
            raise DeployError(str(e))
    return tunnel_url, api_key, engine, model

# ---------------------------------------------------------------- 其他指令

def cmd_stop():
    # 停全部引擎（容器 + strata 原生进程）+ 网关/隧道
    for e in ENGINES.values():
        if e.get("native"):
            _kill_strata()
        else:
            run("docker rm -f %s" % e["container"])
    run("docker rm -f cloudflared chatgw")
    heartbeat({"deploy": {"state": "stopped", "ts": int(time.time())}})
    return "已停止 %s/chatgw/cloudflared" % "/".join(ENGINES.keys())

def cmd_restart_tunnel():
    run("docker rm -f cloudflared")
    url = step_tunnel()
    heartbeat({"deploy": {"state": "online", "tunnel_url": url, "ts": int(time.time())}})
    return "隧道已重建: " + url

# ---------------------------------------------------------------- 自更新

def self_update(server_version):
    if not server_version or server_version == VERSION:
        return
    log("发现新版本 %s（当前 %s），开始自更新" % (server_version, VERSION))
    st, js, raw = http("GET", "/api/agent/latest", timeout=60)
    if st != 200 or not raw or "VERSION" not in raw:
        log("下载新版本失败: %s" % st)
        return
    target = os.path.abspath(sys.argv[0])
    tmp = target + ".new"
    with open(tmp, "w") as f:
        f.write(raw)
    os.chmod(tmp, 0o755)
    os.replace(tmp, target)
    log("已更新到 %s，重启服务" % server_version)
    run("systemctl restart cybercafe-agent", timeout=30)
    sys.exit(0)

# ---------------------------------------------------------------- 主循环

def handle_command(cmd):
    ctype = cmd.get("type")
    log("收到指令: %s" % json.dumps(cmd, ensure_ascii=False))
    try:
        if ctype == "deploy":
            report_progress("command", "running", "开始部署 %s %s" % (cmd.get("engine"), cmd.get("model")))
            tunnel_url, api_key, engine, model = deploy(cmd, report_progress)
            report_deploy_result(True, tunnel_url, api_key, engine, model)
            log("部署完成: %s" % tunnel_url)
        elif ctype == "stop":
            log(cmd_stop())
        elif ctype == "restart_tunnel":
            log(cmd_restart_tunnel())
        else:
            log("未知指令类型: %s" % ctype)
    except Exception as e:
        log("指令执行失败: %s" % e)
        traceback.print_exc()
        report_deploy_result(False, model=cmd.get("model", ""))
        report_progress("command", "fail", str(e)[:300])

def main():
    if not API_BASE or API_BASE.startswith("__"):
        log("ERROR: API_BASE 未注入，请通过安装脚本安装")
        sys.exit(1)
    if not DEVICE_KEY or DEVICE_KEY.startswith("__"):
        log("ERROR: DEVICE_KEY 未注入，请通过安装脚本安装")
        sys.exit(1)
    log("cybercafe-agent v%s 启动，API=%s, device=%s" % (VERSION, API_BASE, device_id()))
    for _ in range(12):  # 启动时注册，最多重试2分钟
        if register():
            break
        time.sleep(10)
    poll = HEARTBEAT_INTERVAL
    while True:
        try:
            js = heartbeat()
            if js:
                self_update(js.get("agent_version"))
                pa = js.get("poll_after")
                if isinstance(pa, (int, float)):
                    poll = max(POLL_MIN, min(POLL_MAX, int(pa)))
                cmd = js.get("command")
                if cmd:
                    handle_command(cmd)
                    poll = POLL_MIN  # 执行完指令后快速回到云端取结果/新指令
        except Exception as e:
            log("主循环异常: %s" % e)
            traceback.print_exc()
        time.sleep(poll)

if __name__ == "__main__":
    main()
