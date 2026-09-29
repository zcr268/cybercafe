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
VERSION = "0.1.3"

HEARTBEAT_INTERVAL = 10         # 心跳间隔（秒）
DEPLOY_HEARTBEAT_INTERVAL = 15  # 部署中最长上报间隔（秒）
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

def report_deploy_result(ok, tunnel_url="", api_key="", model=""):
    heartbeat({"deploy": {"state": "online" if ok else "failed",
                          "model": model, "tunnel_url": tunnel_url,
                          "model_api_key": api_key, "ts": int(time.time())}})

# ---------------------------------------------------------------- 部署流水线

REGISTRY_MIRRORS = ["https://docker.m.daocloud.io", "https://docker.1ms.run",
                    "https://docker.xuanyuan.me"]

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

def step_pull_images():
    images = ["ollama/ollama:latest", "nginx:alpine", "cloudflare/cloudflared:latest"]
    for img in images:
        rc, out = run("docker pull %s" % img, timeout=1800)
        if rc != 0:
            raise DeployError("拉取镜像失败 %s: %s" % (img, out[-300:]))
    return "镜像就绪: " + ", ".join(images)

def step_ollama_start():
    rc, out = run("docker ps --filter name=^/ollama$ --filter status=running -q")
    if out.strip():
        return "ollama 已在运行"
    run("docker rm -f ollama")
    rc, out = run("docker run -d --name ollama --gpus all --restart unless-stopped "
                  "-p 127.0.0.1:11434:11434 -v ollama:/root/.ollama ollama/ollama:latest", timeout=120)
    if rc != 0:
        raise DeployError("ollama 启动失败: " + out[-300:])
    for _ in range(30):
        rc, out = run("curl -s http://127.0.0.1:11434/api/version", timeout=10)
        if rc == 0 and "version" in out:
            return "ollama 运行中: " + out.strip()
        time.sleep(2)
    raise DeployError("ollama 健康检查超时")

def step_model_pull(model, progress_cb):
    """流式拉取模型并回报百分比"""
    p = subprocess.Popen(["docker", "exec", "ollama", "ollama", "pull", model],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, errors="replace", bufsize=1)
    buf, last_pct, last_ts = "", -1, time.time()
    while True:
        ch = p.stdout.read(1)
        if not ch and p.poll() is not None:
            break
        if not ch:
            continue
        buf += ch
        if ch in ("\n", "\r"):
            m = re.search(r"(\d+)\s*%", buf)
            if m:
                pct = int(m.group(1))
                if pct != last_pct and (pct % 10 == 0 or time.time() - last_ts > DEPLOY_HEARTBEAT_INTERVAL):
                    last_pct, last_ts = pct, time.time()
                    progress_cb("model_pull", "running", "%s %d%%" % (model, pct))
            buf = ""
    rc = p.wait()
    if rc != 0:
        raise DeployError("模型拉取失败: " + model)
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
    for _ in range(4):  # 隧道刚建立时边缘可能短暂 530，重试几次
        rc, out = run('curl -s -m 60 -o /dev/null -w "%%{http_code}" -H "Authorization: Bearer %s" %s/v1/models'
                      % (api_key, tunnel_url), timeout=90)
        last = out.strip()
        if last == "200":
            return "公网可达: " + tunnel_url
        time.sleep(10)
    raise DeployError("公网隧道验证失败: http " + last)

def deploy(cmd, progress_cb):
    model = cmd.get("model", "qwen2.5:7b-instruct")
    api_key = cmd.get("api_key", "")
    if not api_key:
        raise DeployError("指令缺少 api_key")
    steps = [
        ("gpu_check",     "检测 GPU",        step_gpu_check),
        ("docker",        "安装/检查 Docker", step_docker),
        ("mirrors",       "配置镜像加速",      step_mirrors),
        ("gpu_toolkit",   "GPU 容器支持",     step_gpu_toolkit),
        ("pull_images",   "拉取容器镜像",      step_pull_images),
        ("ollama_start",  "启动推理引擎",      step_ollama_start),
        ("model_pull",    "拉取模型 " + model, None),  # 特殊处理
        ("gateway",       "部署鉴权网关",      None),
        ("tunnel",        "建立公网隧道",      None),
        ("verify",        "端到端验证",       None),
    ]
    tunnel_url = ""
    for step_id, title, fn in steps:
        progress_cb(step_id, "running", title)
        try:
            if step_id == "model_pull":
                detail = step_model_pull(model, progress_cb)
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
    return tunnel_url, api_key, model

# ---------------------------------------------------------------- 其他指令

def cmd_stop():
    run("docker rm -f cloudflared chatgw ollama")
    heartbeat({"deploy": {"state": "stopped", "ts": int(time.time())}})
    return "已停止 ollama/chatgw/cloudflared 容器"

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
            report_progress("command", "running", "开始部署 %s" % cmd.get("model"))
            tunnel_url, api_key, model = deploy(cmd, report_progress)
            report_deploy_result(True, tunnel_url, api_key, model)
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
    while True:
        try:
            js = heartbeat()
            if js:
                self_update(js.get("agent_version"))
                cmd = js.get("command")
                if cmd:
                    handle_command(cmd)
        except Exception as e:
            log("主循环异常: %s" % e)
            traceback.print_exc()
        time.sleep(HEARTBEAT_INTERVAL)

if __name__ == "__main__":
    main()
