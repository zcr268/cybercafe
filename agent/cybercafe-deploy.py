#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CyberCafe L3 模型部署脚本（独立层，t45 三层拆分）
- 自包含：仅用 Python3 标准库，不 import agent（L2）内部模块；
- 云端在每次下发部署指令时经 agent 重取本脚本最新版（install-extra?name=cybercafe-deploy.py
  → sha256 校验 → 落盘执行），本脚本自身不管理版本（由 L2 触发即取即验即执行）。
- 输入：环境变量 API_BASE / DEVICE_KEY + 指令 JSON（环境 CYBERCAFE_CMD_JSON，缺省读 stdin 一行）。
- 子命令：deploy（默认）/ stop / restart_tunnel；进度与结果经云管 /api/device/progress 与
  heartbeat（deploy 字段）如实上报；失败以非零退出码 + 上报 fail 结束，不静默回退。
- 保持既有流水线节点名（gpu_check/docker/mirrors/gpu_toolkit/pull_images/engine_start/
  model_pull/strata_*/gateway/tunnel/verify）与结果字段不变（云端 UI 依赖）。
"""
VERSION = "1.0.0"

import hashlib
import json
import threading
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

API_BASE = os.environ.get("API_BASE", "").rstrip("/")
DEVICE_KEY = os.environ.get("DEVICE_KEY", "")
RAW_UA = "cybercafe-deploy/%s" % VERSION
DEPLOY_HEARTBEAT_INTERVAL = 15  # 部署中最长上报间隔（秒）


def log(msg):
    print("[%s] [l3] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


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
    url = API_BASE + path
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


def heartbeat(extra=None):
    payload = {"device": {"device_id": device_id(),
                          "last_seen": int(time.time())}}
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
    for attempt in range(3):  # 单次投递防丢，重试 3 次
        if heartbeat(payload):
            return
        log("deploy 结果上报失败（第 %d 次），3s 后重试" % (attempt + 1))
        time.sleep(3)
# ---------------------------------------------------------------- 部署流水线

# 国内 docker 镜像源（t51，实测依据 2026-10-08，XZ-31-001/6026）：
#   docker.m.daocloud.io —— 唯一实测可用源：拉 alpine 3.3s / ollama 1s；
#   另两个候选站与直连 docker.io 均实测 60s 超时（CN 网络不可达），已从候选移除（防多源并发被死源拖垮）。
#   保留 3s 健康探测：daocloud 恒保底且排首位，探测误判也不写空列表；全灭时保留原列表并告警。
REGISTRY_MIRRORS = ["https://docker.m.daocloud.io"]
MIRROR_PROBE_TIMEOUT_S = 3   # 探测超时：短且可预期（当前单候选，最坏 ~3s；多候选时并行、总耗时收敛 ~3s）

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

def _probe_mirrors(candidates):
    """并行健康探测（threading 标准库）：registry /v2/ 任意 HTTP 应答（含 401 鉴权页）即视为可达；
    000/超时=死源。仅配置镜像那一步调用一次（非每次 deploy）。串行最坏 len×3s，并行收敛 ~3s。"""
    def _ok(url):
        try:
            urllib.request.urlopen(urllib.request.Request(url.rstrip("/") + "/v2/"),
                                   timeout=MIRROR_PROBE_TIMEOUT_S)
            return True
        except urllib.error.HTTPError:
            return True   # 401/403 等 = registry 在应答
        except Exception:
            return False
    res = {}
    def _run(u):
        res[u] = _ok(u)
    ts = [threading.Thread(target=_run, args=(u,)) for u in candidates]
    for t in ts: t.start()
    for t in ts: t.join()
    return res

def step_mirrors():
    path = "/etc/docker/daemon.json"
    conf = {}
    if os.path.exists(path):
        try:
            with open(path) as f:
                conf = json.load(f)
        except Exception:
            conf = {}
    # 健康探测：仅写入存活源；daocloud 恒保底且排首位（探测误判也不写空列表）
    alive_map = _probe_mirrors(REGISTRY_MIRRORS)
    selected = [u for u in REGISTRY_MIRRORS if alive_map.get(u)]
    for u in REGISTRY_MIRRORS:
        if u not in selected:
            selected.append(u)   # 硬化：候选全部保留（含误判死的），宁试可能活的不写空
    if not alive_map.get(REGISTRY_MIRRORS[0]):
        log("警告: 镜像源探测失败（含 daocloud），已保留候选原样写入，docker pull 可能变慢")
    mirrors = list(dict.fromkeys(selected + conf.get("registry-mirrors", [])))
    conf["registry-mirrors"] = mirrors
    with open(path, "w") as f:
        json.dump(conf, f, indent=2)
    run("systemctl restart docker", timeout=60)
    time.sleep(3)
    return "镜像加速(健康探测后): " + ", ".join(mirrors)

def step_gpu_toolkit():
    # 已正确安装（nvidia-ctk 在 PATH）→ 跳过重复安装，不因重装拖慢部署
    if shutil.which("nvidia-ctk"):
        return "nvidia-container-toolkit 已安装"
    # R2：外部源调用必须带显式超时——nvidia.github.io 在新机/受限网络会静默挂起 ~6 分钟。
    # 所有 curl 均带 --connect-timeout 10 --max-time 30（快速失败）；源不可达时走降级路径
    # （NVIDIA_TOOLKIT_BASE 环境变量可指向可达镜像/备用源），失败如实上报，绝不静默成功。
    CURL = "curl -fsSL --connect-timeout 10 --max-time 30"
    base = os.environ.get("NVIDIA_TOOLKIT_BASE", "https://nvidia.github.io/libnvidia-container")
    tmp = "/tmp/cc-nvidia-toolkit"
    # 分开执行并取 curl 自身 rc（管道 rc 会被 gpg/sed 掩盖，curl 失败不能静默通过）
    rc1, out1 = run("%s %s/gpgkey -o %s.gpgkey" % (CURL, base, tmp), timeout=45)
    rc2, out2 = run("%s %s/stable/deb/nvidia-container-toolkit.list -o %s.list" % (CURL, base, tmp), timeout=45)
    src_detail = ""
    if rc1 != 0 or rc2 != 0:
        # 源限时不可达：如实记录，进入降级路径（不死等）
        src_detail = "（源 %s 限时不可达 rc1=%d rc2=%d）" % (base, rc1, rc2)
    else:
        run("gpg --dearmor < %s.gpgkey > /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg" % tmp, timeout=30)
        run("sed -e 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' %s.list > /etc/apt/sources.list.d/nvidia-container-toolkit.list" % tmp, timeout=30)
    # apt 步统一限时（源配置失败时快速失败，不静默继续）
    run("apt-get update -qq", timeout=180)
    rc_i, out_i = run("DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nvidia-container-toolkit", timeout=300)
    if rc_i != 0:
        # 降级路径尝试已包含在同上 apt 通道（发行版归档/已配置源若提供 toolkit 则安装成功）；
        # 仍失败 → 如实上报 fail，绝不假装工具包已就绪
        raise DeployError("toolkit 安装失败%s: apt install nvidia-container-toolkit -> %s"
                          % (src_detail, out_i[-300:]))
    rc, out = run("nvidia-ctk runtime configure --runtime=docker && systemctl restart docker", timeout=120)
    if rc != 0:
        raise DeployError("toolkit 配置失败: " + out[-300:])
    time.sleep(3)
    return "nvidia-container-toolkit 安装完成" + src_detail

def step_docker_prep(engine):
    """t106：运行时 docker-prep 兜底——部署前检测对应 docker-prep 就绪
    （标记 /opt/cybercafe/docker-prep.<engine>.done 或镜像已存在）；
    未就绪且有脚本 → 临时执行 docker-prep.<engine>.sh（自动闭环），再部署。
    无脚本（引擎尚未入库 docker-prep，如 ollama 等 t107 前）→ 跳过，零影响。"""
    prep_dir = "/opt/cybercafe/docker-prep"
    marker = "/opt/cybercafe/docker-prep.%s.done" % engine
    script = os.path.join(prep_dir, "docker-prep.%s.sh" % engine)
    if not os.path.isdir(prep_dir):
        return "无 docker-prep 目录（L1 未落位），跳过"
    if os.path.exists(marker):
        return "docker-prep 已就绪（%s，标记在位），跳过" % engine
    if not os.path.exists(script):
        return "无 %s 的 docker-prep 脚本（尚未入库），跳过" % engine
    log("t106 运行时兜底：%s 未 docker-prep，临时执行 %s" % (engine, script))
    rc, out = run("bash %s" % script, timeout=2000)
    if rc != 0:
        log(out[-800:])
        raise DeployError("docker-prep %s 临时执行失败（rc=%d；部署中止，重试/手动可补）" % (engine, rc))
    return "docker-prep 已执行（%s 就绪）" % engine


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

def _cuda_env():
    """探测已安装的 CUDA toolkit（/usr/local/cuda* 或 /opt/cuda*），返回注入 PATH/LD_LIBRARY_PATH 的前缀。

    t23 真机复现：CUDA 12.2 已装于 /usr/local/cuda-12.2 但 agent systemd 环境 PATH 不含 /usr/local/cuda/bin，
    setup.sh 内 CMake enable_language(CUDA) 找不到 nvcc → 编译器 ID 探测失败中止。这里把 toolkit bin/lib64
    主动加入子进程环境（setup.sh 的 sudo apt 安装路径同理）。找不到时返回空串（让 setup.sh 自行安装）。
    """
    cands = []
    for base in ("/usr/local", "/opt"):
        try:
            cands += [p for p in sorted(Path(base).glob("cuda*"), reverse=True)
                      if (p / "bin" / "nvcc").is_file()]
        except OSError:
            pass
    if not cands:
        return ""
    b = cands[0]  # 版本号最大者优先（sorted 字典序对 cuda-12.2 > cuda-12.10 不成立，再按版本排）
    def _ver(p):
        m = re.search(r"cuda[.-]?(\d+)\.(\d+)", str(p))
        return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    b = max(cands, key=_ver)
    bindir, libdir = b / "bin", b / "lib64"
    parts = ["PATH=%s:$PATH" % bindir]
    if libdir.is_dir():
        parts.append("LD_LIBRARY_PATH=%s:$LD_LIBRARY_PATH" % libdir)
    return " ".join(parts) + " "

# CUDA 主版本 → nvcc 支持的宿主 gcc 上限（host_config.h #error 硬限制；12.x 不支持 gcc>12）
CUDA_GCC_LIMIT = {11: 11, 12: 12, 13: 13}

def _cuda_ver():
    """探测 nvcc 版本 → (major, minor) 或 None"""
    env = _cuda_env()
    rc, out = run(env + "nvcc --version", timeout=30)
    m = re.search(r"release (\d+)\.(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if rc == 0 and m else None

def _host_gcc_major():
    rc, out = run("gcc --version", timeout=15)
    m = re.search(r"gcc \(.*?\) (\d+)\.", out)
    return int(m.group(1)) if rc == 0 and m else None

def _gcc_env():
    """nvcc/gcc 版本兼容修复（t23 真机确诊：CUDA 12.2 只支持宿主 gcc<=12，机器是 gcc 13.3）。

    返回隔离 PATH 前缀：把 gcc-<limit>/g++-<limit>（缺失时 apt 安装）经软链目录前置到 PATH——
    nvcc 与 CMake 从 PATH 找宿主编译器即得到兼容 gcc，系统 /usr/bin/gcc(13) 原样保留，
    不影响 python/其他进程。宿主 gcc 已兼容或无需修复时返回""（无前缀）。"""
    cuda = _cuda_ver()
    if not cuda:
        return ""
    limit = CUDA_GCC_LIMIT.get(cuda[0], 13)
    host = _host_gcc_major()
    if host is not None and host <= limit:
        return ""
    gcc_bin = shutil.which("gcc-%d" % limit)
    if not gcc_bin:
        run("DEBIAN_FRONTEND=noninteractive apt-get update -qq "
            "&& DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gcc-%d g++-%d"
            % (limit, limit), timeout=900)
        gcc_bin = shutil.which("gcc-%d" % limit)
    if not gcc_bin:
        return ""
    gxx_bin = shutil.which("g++-%d" % limit) or gcc_bin.replace("gcc", "g++")
    iso = "/root/.cybercafe/gcc%d" % limit
    os.makedirs(iso, exist_ok=True)
    for src, name in ((gcc_bin, "gcc"), (gxx_bin, "g++"), (gcc_bin, "cc"), (gxx_bin, "c++")):
        link = os.path.join(iso, name)
        if not os.path.lexists(link):
            try:
                os.symlink(src, link)
            except OSError:
                pass
    return "PATH=%s:$PATH " % iso

def _strata_env():
    """Strata 子进程完整环境前缀：CUDA toolkit + gcc 兼容隔离"""
    return _cuda_env() + _gcc_env()

def step_strata_check():
    """环境预检：驱动 >= 580 / 内存 >= 31GB / 磁盘 >= 80GB / CUDA nvcc 可用 / nvcc-宿主gcc 兼容"""
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
    # CUDA toolkit 预检：nvcc 需可达（systemd 环境 PATH 常缺 /usr/local/cuda/bin，这里主动探测并注入）
    cuda_env = _cuda_env()
    rc, out = run(cuda_env + "nvcc --version", timeout=30)
    if rc != 0 or "release" not in out:
        raise DeployError("未找到可用的 CUDA nvcc（Strata 需要本地编译引擎）。"
                          "已扫描 /usr/local/cuda* 与 /opt/cuda*，请安装 CUDA Toolkit 12.x/13.x "
                          "（Ubuntu: sudo apt install nvidia-cuda-toolkit，或从 developer.nvidia.com 装）")
    nvcc_v = re.search(r"release (\d+)\.(\d+)", out)
    nvcc_str = nvcc_v.group(0) if nvcc_v else "版本未知"
    # nvcc-宿主gcc 兼容预检：CUDA 12.x 只支持宿主 gcc<=12（host_config.h 硬限制）。
    # 不兼容时自动准备 gcc-<limit> 隔离注入（_gcc_env 会装/软链）；装不上才报错。
    cuda_major = int(nvcc_v.group(1)) if nvcc_v else 0
    gcc_limit = CUDA_GCC_LIMIT.get(cuda_major, 13)
    gcc_prefix = _gcc_env()
    host_gcc = _host_gcc_major()
    if host_gcc is not None and host_gcc > gcc_limit and not gcc_prefix:
        raise DeployError("nvcc %s 与宿主 gcc %d 不兼容（CUDA %d 仅支持 gcc<=%d）。"
                          "自动安装 gcc-%d 失败，请手动安装: "
                          "sudo apt install gcc-%d g++-%d，或升级 CUDA Toolkit 13.x"
                          % (nvcc_str, host_gcc, cuda_major, gcc_limit, gcc_limit, gcc_limit, gcc_limit))
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
    gcc_note = ("（nvcc 兼容 gcc: gcc-%d 已隔离注入）" % gcc_limit) if gcc_prefix else ""
    return "环境预检通过: 驱动 %s / nvcc %s / 内存 %.1fGB / 磁盘 %.1fGB%s" % (ver, nvcc_str, mem_gb, disk_gb, gcc_note)

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
    # 清理上次失败的 CMake 缓存（CMakeCache.txt 会记住旧的 CMAKE_CUDA_COMPILER，
    # 换了 nvcc/gcc 组合后重跑会复用旧编译配置导致再次失败；t23 真机实测残留）
    if os.path.exists(os.path.join(d, "build", "CMakeCache.txt")):
        run("rm -rf %s/build %s/build-vision" % (d, d))
        progress_cb("strata_setup", "running", "清理上次失败残留的 build 缓存，重新 configure")
    args = " ".join(cfg["setup_args"])
    # HF 权重走 hf-mirror 镜像站（大陆可达）；安装过程可能长达数小时，每 15s 回报进度
    # _strata_env() = CUDA toolkit PATH + LD_LIBRARY_PATH + nvcc-宿主gcc 兼容隔离注入
    #   （t23：PATH 缺 /usr/local/cuda/bin → CMake 找不到 nvcc；gcc 13.3 与 CUDA 12.2 不兼容 → 需 gcc-12）
    cmd = "cd %s && %sHF_ENDPOINT=https://hf-mirror.com ./setup.sh %s" % (d, _strata_env(), args)
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
    # 端口 11434 = 容器引擎同端口，nginx 网关不变；--open 免开浏览器）。
    # _strata_env() 注入 CUDA toolkit + gcc 兼容隔离（t23：systemd PATH 缺 CUDA bin；
    # 运行期无编译需求但保持与 setup 一致的工具链环境，避免 nvcc/gcc 相关工具缺失）
    rc, out = run("cd %s && %snohup .venv/bin/python serve/server.py --engine strata "
                  "--config strata-coder-iq1_m.json --port %s > /tmp/strata.log 2>&1 & echo $!"
                  % (d, _strata_env(), cfg["port"]), timeout=60)
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
    # R3：网关自检与 nginx 启动存在时序竞争——网关刚起来时自检瞬时 000 被误判失败（重发即过）。
    # 改为有界退避重试：总时长上限 90s（wall-clock 硬上限，每次 curl 带 -m 5 与 run 超时）；
    # 到上限仍不就绪 → 如实报 fail（宁如实失败，不虚假成功——与 R2 同源红线）。
    total_cap = 90.0
    t0 = time.time()
    ok = False
    last = ("", "")
    while time.time() - t0 < total_cap:
        rc1, out1 = run('curl -s -m 5 -o /dev/null -w "%%{http_code}" -H "Authorization: Bearer %s" http://127.0.0.1:8000/v1/models' % api_key, timeout=15)
        rc2, out2 = run('curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/v1/models', timeout=15)
        last = (out1.strip(), out2.strip())
        if last == ("200", "401"):
            ok = True
            break
        time.sleep(2)
    if not ok:
        raise DeployError("网关鉴权自检失败: %ds 上限内未就绪（key=%s 无key=%s）——nginx/网关启动超时，如实上报" % (int(total_cap), last[0], last[1]))
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
        ("docker_prep",   "docker 前置准备",    None),
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
            if step_id == "docker_prep":
                detail = step_docker_prep(engine)
            elif step_id == "pull_images":
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

# ---------------------------------------------------------------- 主入口（payload 由 L2 注入）

def load_command():
    """指令 JSON：环境 CYBERCAFE_CMD_JSON 优先，缺省读 stdin 第一行"""
    raw = os.environ.get("CYBERCAFE_CMD_JSON", "")
    if not raw:
        line = sys.stdin.readline() if not sys.stdin.isatty() else ""
        raw = (line or "").strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        log("指令 JSON 解析失败: " + raw[:200])
        return {}


def main():
    if not API_BASE:
        log("ERROR: API_BASE 未注入"); sys.exit(1)
    if not DEVICE_KEY:
        log("ERROR: DEVICE_KEY 未注入"); sys.exit(1)
    mode = sys.argv[1] if len(sys.argv) > 1 else "deploy"
    cmd = load_command()
    log("L3 启动 mode=%s device=%s engine=%s model=%s" % (mode, device_id(), cmd.get("engine"), cmd.get("model")))
    try:
        if mode == "deploy":
            engine = cmd.get("engine") or "ollama"
            model = cmd.get("model", "")
            api_key = cmd.get("api_key", "")
            tunnel_url, api_key, engine, model = deploy(cmd, report_progress)
            report_deploy_result(True, tunnel_url, api_key, engine, model)
            print("RESULT_DEPLOY_OK device=%s engine=%s model=%s tunnel=%s" % (device_id(), engine, model, tunnel_url))
            log("✅ 部署完成: %s" % tunnel_url)
            sys.exit(0)
        elif mode == "stop":
            log(cmd_stop())
            sys.exit(0)
        elif mode == "restart_tunnel":
            log(cmd_restart_tunnel())
            sys.exit(0)
        else:
            log("未知子命令: %s" % mode)
            sys.exit(2)
    except DeployError as e:
        log("部署失败: %s" % e)
        report_progress("command", "fail", str(e)[:300])
        report_deploy_result(False, model=cmd.get("model", ""))
        print("RESULT_DEPLOY_FAIL %s" % e)
        sys.exit(1)
    except Exception as e:
        log("部署异常: %s: %s" % (type(e).__name__, e))
        report_progress("command", "fail", "%s: %s" % (type(e).__name__, e)[:300])
        report_deploy_result(False, model=cmd.get("model", ""))
        sys.exit(1)


if __name__ == "__main__":
    main()
