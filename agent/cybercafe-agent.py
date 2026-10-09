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
VERSION = "0.6.6"

HEARTBEAT_INTERVAL = 10         # 默认心跳间隔（秒），实际由云端 poll_after 驱动
DEPLOY_HEARTBEAT_INTERVAL = 15  # 部署中最长上报间隔（秒）
POLL_MIN, POLL_MAX = 3, 300     # poll_after 钳制范围
RAW_UA = "cybercafe-agent/%s" % VERSION

import ctypes
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
from pathlib import Path

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
        "net": [],
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
    info["net"] = collect_net()
    return info

# 虚拟网口前缀（排除：lo / docker* / veth* / br-* / virbr* / tun* / tap* /
# tailscale* / zt* / wg* / gre* / sit* / erspan* / ip6* / vti* 等隧道与虚拟口）；仅收物理网卡
NET_VIRT_PREFIXES = ("lo", "docker", "veth", "br-", "virbr", "tun", "tap",
                     "tailscale", "zt", "wg", "gre", "gretap", "erspan", "sit",
                     "ipip", "ip6", "ip_vti", "vti", "tunl", "vlan", "bond",
                     "dummy", "ifb", "macvtap", "macvlan")

def _is_virtual_iface(name):
    n = (name or "").lower()
    return any(n.startswith(p) for p in NET_VIRT_PREFIXES)

def _is_zero_mac(m):
    """全 0 的 MAC（00:00:00:00:00:00 或 ipv6 长度全零）视为无真实硬件地址"""
    return sum(1 for c in (m or "").lower() if c not in "0:") == 0

def collect_net():
    """物理网卡 MAC/IP 列表：[{"iface":.., "mac":.., "ip":..}]

    - MAC 主来源 /sys/class/net/<iface>/address，兜底 `ip -o link show`（link/ether）；
    - IPv4 沿用 `ip -o -4 addr ... scope global` 输出按网卡名配对；
    - 无 IPv4 的物理口保留 mac、ip 留空；虚拟口（lo/docker*/veth*/br-* 等）排除。
    """
    # 物理口清单（/sys/class/net 全量过滤虚拟前缀）
    ifaces = []
    try:
        ifaces = sorted(d for d in os.listdir("/sys/class/net") if not _is_virtual_iface(d))
    except Exception:
        pass
    # MAC：主来源 /sys/class/net/<iface>/address
    macs = {}
    for i in ifaces:
        try:
            with open("/sys/class/net/%s/address" % i) as f:
                m = f.read().strip()
                if m and not _is_zero_mac(m):
                    macs[i] = m.lower()
        except Exception:
            pass
    # 兜底：ip -o link show（/sys 不可用时取 link/ether）
    if len(macs) < len(ifaces):
        rc, out = run("ip -o link show 2>/dev/null")
        if rc == 0:
            for line in out.splitlines():
                # 形如: 2: eth0: <BROADCAST,...> mtu 1500 ... \  link/ether aa:bb:cc:dd:ee:ff brd ...
                m = re.match(r"^\d+:\s+([^@:\s]+)\s.*?link/ether\s+([0-9a-fA-F:]{17})", line)
                if m and not _is_virtual_iface(m.group(1)):
                    mac = m.group(2).lower()
                    if not _is_zero_mac(mac):
                        macs.setdefault(m.group(1), mac)
    # IPv4 按网卡名配对（与 ips 同来源：scope global）
    ipmap = {}
    rc, out = run("ip -o -4 addr show scope global 2>/dev/null | awk '{print $2\": \"$4}'")
    if rc == 0:
        for l in out.strip().splitlines():
            if ":" in l:
                iface, ip = l.split(":", 1)
                ipmap[iface.strip()] = ip.strip().split("/")[0]
    net = []
    for i in ifaces:
        net.append({"iface": i, "mac": macs.get(i, ""), "ip": ipmap.get(i, "")})
    return net

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

# ---------------- GPU 多源采集（t49） ----------------
# 负载（显存/利用率）二源降级：NVML 直连主源 → nvidia-smi 兜底 → 都失败 gpu_src=none 不写字段。
# 【边界①·防回退】「身份走 /proc、负载走 NVML」：/proc/driver/nvidia 只有身份字段
# （gpus/*/information 仅 Model/IRQ/GPU UUID/Video BIOS/Bus Type/DMA Size/DMA Mask/Bus Location/
# Device Minor/GPU Excluded），无 memory/utilization；/sys/class/drm 的 mem_info_vram_used/
# gpu_busy_percent 属 AMD amdgpu 接口、N 卡不存在。禁止把 /proc 当显存/利用率兜底源
# （会得到永远为空的假兜底，掩盖真实失败）。

_nvml_state = {"lib": None, "handle": None, "err": None}

class _NvmlMemoryV2(ctypes.Structure):
    # 【边界②·防回退】必须同时用对符号名（nvmlDeviceGetMemoryInfo_v2）与结构体版本
    # （version=0x02000028）。禁止用 v1 符号 nvmlDeviceGetMemoryInfo / v1 三字段结构体：
    # 真机实测 v1 符号读出的 used=298MiB 是虚高脏数据（真实 1MiB，reserved 被计入）；
    # 用 v1 结构体调 _v2 符号会得 rc=13 FUNCTION_NOT_FOUND（驱动校验 version 后干净拒绝，
    # 错配是干净可判定而非静默脏数据）。若 _v2 不可用，视为 NVML 整体不可用 →
    # 显存/利用率整体落 nvidia-smi 兜底，宁缺毋滥。
    _fields_ = [
        ("version", ctypes.c_uint32),   # 必须 = NVML_MEM_V2_VERSION
        ("total", ctypes.c_uint64),
        ("reserved", ctypes.c_uint64),
        ("free", ctypes.c_uint64),
        ("used", ctypes.c_uint64),
    ]

NVML_MEM_V2_VERSION = 0x02000028

class _NvmlUtilization(ctypes.Structure):
    _fields_ = [("gpu", ctypes.c_uint), ("memory", ctypes.c_uint)]

def _nvml_load():
    """NVML 初始化（懒加载缓存）；失败按 nvmlReturn_t/异常分类记录 err，供降级路径区分。
    错误码语义：12=LIBRARY_NOT_FOUND / 9=DRIVER_NOT_LOADED（初始化失败）；6=NOT_FOUND（无设备）。"""
    if _nvml_state["lib"] is not None or _nvml_state["err"]:
        return _nvml_state["lib"] is not None
    try:
        lib = ctypes.CDLL("libnvidia-ml.so.1")
    except OSError:
        _nvml_state["err"] = "lib_missing"        # 库缺失 → 整体降级 nvidia-smi
        return False
    _nvml_state["lib"] = lib
    try:
        fn = lib.nvmlInit_v2
        fn.restype = ctypes.c_int
        if fn() != 0:
            raise RuntimeError("nvmlInit_v2 rc!=0")
    except (AttributeError, RuntimeError):
        _nvml_state["err"] = "init_failed"         # 初始化失败（含 12/9 语义） → 整体降级
        return False
    try:
        fnh = lib.nvmlDeviceGetHandleByIndex_v2
        fnh.restype = ctypes.c_int
        fnh.argtypes = [ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
        h = ctypes.c_void_p()
        if fnh(0, ctypes.byref(h)) != 0:
            raise RuntimeError("getHandle rc!=0")
    except (AttributeError, RuntimeError):
        _nvml_state["err"] = "no_device"           # 无设备/驱动未加载（6/9 语义） → 整体降级
        return False
    _nvml_state["handle"] = h.value
    return True

def _nvml_read_once():
    """NVML 读一次 (util, used_MiB, total_MiB) 或 None（任一 rc≠0/异常 → None →
    该样本无效，整体落 nvidia-smi 兜底）。"""
    if not _nvml_load():
        return None
    lib, h = _nvml_state["lib"], _nvml_state["handle"]
    try:
        fu = lib.nvmlDeviceGetUtilizationRates
        fu.restype = ctypes.c_int
        fu.argtypes = [ctypes.c_void_p, ctypes.POINTER(_NvmlUtilization)]
        util = _NvmlUtilization()
        if fu(h, ctypes.byref(util)) != 0:
            return None
        fm = lib.nvmlDeviceGetMemoryInfo_v2
        fm.restype = ctypes.c_int
        fm.argtypes = [ctypes.c_void_p, ctypes.POINTER(_NvmlMemoryV2)]
        mem = _NvmlMemoryV2()
        mem.version = NVML_MEM_V2_VERSION
        if fm(h, ctypes.byref(mem)) != 0:
            return None
        return (util.gpu, mem.used // (1024 * 1024), mem.total // (1024 * 1024))
    except Exception:
        return None

def _smi_read_once():
    """nvidia-smi 兜底读一次 (util, used_MiB, total_MiB) 或 None；
    直接取 nvidia-smi 自身 rc（避免 shell 管道污染 $?），输出不可解析 → None。"""
    rc, out = run("nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total "
                  "--format=csv,noheader,nounits 2>/dev/null", timeout=15)
    if rc != 0:
        return None
    for line in out.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            gu, mu, mtot = [int(x.strip()) for x in line.split(",")[:3]]
            return (gu, mu, mtot)
        except (ValueError, IndexError):
            return None
    return None

def _gpu_samples():
    """GPU 利用率/显存多源采样：1s 窗口内采样 3 次取最大（避开瞬时 0）；
    主源 NVML（nvml）→ nvidia-smi 兜底；返回 (util, used_MiB, total_MiB, src) 或 None。
    gpu_src 三值：nvml / nvidia-smi / none（none 在 collect_usage 中 fallback 处理）。"""
    src = "nvml" if _nvml_load() else "nvidia-smi"
    read = _nvml_read_once if src == "nvml" else _smi_read_once
    best = None
    for i in range(3):
        r = read()
        if r and (best is None or r[0] > best[0]):
            best = r
        if i < 2:
            time.sleep(0.4)
    if best:
        return (best[0], best[1], best[2], src)
    # 主源失败 → 另一源整体兜底（NVML 不可用/单指标失败；禁用 v1，宁缺毋滥）
    if src == "nvml":
        best = None
        for i in range(3):
            r = _smi_read_once()
            if r and (best is None or r[0] > best[0]):
                best = r
            if i < 2:
                time.sleep(0.4)
        if best:
            return (best[0], best[1], best[2], "nvidia-smi")
    return None

_gpu_driver_val = None

def _gpu_driver():
    """GPU 驱动版本：NVML nvmlSystemGetDriverVersion 优先（不依赖 nvidia-smi），失败回退
    nvidia-smi --query-gpu=driver_version；驱动为静态信息 → 模块级缓存，不每心跳重取。"""
    global _gpu_driver_val
    if _gpu_driver_val is not None:
        return _gpu_driver_val
    v = None
    if _nvml_load():                     # t49 NVML 直连（ctypes，不依赖 nvidia-smi）
        lib = _nvml_state["lib"]
        try:
            fn = lib.nvmlSystemGetDriverVersion
            fn.restype = ctypes.c_int
            buf = ctypes.create_string_buffer(256)
            if fn(buf, ctypes.c_uint(256)) == 0:
                v = buf.value.decode("utf-8", "replace").strip()
        except Exception:
            pass
    if not v:
        rc, out = run("nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null", timeout=15)
        if rc == 0:
            for line in out.strip().splitlines():
                line = line.strip()
                if line:
                    v = line.split(",")[0].strip()
                    break
    if v:
        _gpu_driver_val = v
    return v

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
        gu, mu, mtot, gpu_src = gpu
        u["gpu_src"] = gpu_src
        u["gpu_util_pct"] = gu
        u["gpu_mem_used_mb"] = mu
        u["gpu_mem_total_mb"] = mtot
        u["gpu_mem_pct"] = round(100.0 * mu / mtot, 1) if mtot else 0
        u["gpu_note"] = "模型已加载" if mu >= 256 else "模型未加载（空闲自动卸载，属正常）"
    else:
        # 双源皆败：如实标记来源，不写 gpu_util_pct/gpu_mem_used_mb（缺失语义，UI 不显示为 0）
        u["gpu_src"] = "none"
    u["gpu_driver"] = _gpu_driver()   # 驱动版本（静态，缓存，NVML 优先）
    return u

# ---------------------------------------------------------------- 云端交互

def register():
    st, js, raw = http("POST", "/api/device/register", {"device": collect_device_info()})
    if st == 200 and js and js.get("ok"):
        log("registered, device_id=%s" % js.get("device_id"))
        return True
    log("register failed: %s %s" % (st, raw[:300]))
    return False

def _sha8(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:8]
    except Exception:
        return None

def _version_line(path):
    """脚本头部 # Version: X.Y.Z 版本行（缺省返回 None）"""
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                if line.startswith("# Version:"):
                    return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return None

_layers_cache = {"ts": 0.0, "data": None}

def collect_layers(force=False):
    """L1/L2 分层脚本状态（心跳 device.layers 用，与 usage 同级）。

    L1：本机 install.sh / provision.sh 的版本行 + sha256 前 8；systemd 两单元
        （cybercafe-agent.service / cybercafe-provision.service）active/enabled。
    L2：agent 自身 VERSION + sha256 前 8；更新通道状态（batch.code 或 config.env
        BATCH_CODE 存在=armed；/etc/cybercafe/self_update=off=off；否则 dormant）；
        脚本最近更新时间（install.sh/provision.sh/agent 文件 mtime 最大值）。
    节流：systemctl 是子进程重操作，60s 缓存；agent 启动与 update_managed_scripts
    更新脚本后 force 刷新（避免每 10s 心跳明显开销）。"""
    global _layers_cache
    now = time.time()
    if not force and _layers_cache["data"] is not None and now - _layers_cache["ts"] < 60:
        return _layers_cache["data"]
    paths = [
        ("install", "/opt/cybercafe/install.sh"),
        ("provision", "/opt/cybercafe/provision.sh"),
        ("agent", os.path.abspath(__file__)),
    ]
    scripts, mt = {}, 0.0
    for key, p in paths:
        ver = VERSION if key == "agent" else _version_line(p)
        sha = _sha8(p)
        try:
            mt = max(mt, os.path.getmtime(p))
        except Exception:
            pass
        scripts[key] = {"version": ver, "sha8": sha}
    units = {}
    for u in ("cybercafe-agent.service", "cybercafe-provision.service"):
        rc_a, out_a = run("systemctl is-active %s" % u, timeout=15)
        rc_e, out_e = run("systemctl is-enabled %s" % u, timeout=15)
        units[u] = {"active": out_a.strip() if rc_a == 0 else "inactive",
                    "enabled": out_e.strip() if rc_e == 0 else "disabled"}
    if _self_update_off():
        channel = "off"
    elif _is_batch_machine():
        channel = "armed"
    else:
        channel = "dormant"
    data = {"install": scripts["install"], "provision": scripts["provision"],
            "agent": scripts["agent"], "units": units, "channel": channel,
            "last_update": int(mt) if mt > 0 else None}
    _layers_cache = {"ts": now, "data": data}
    return data

def heartbeat(extra=None):
    ocr = _ocr_state()
    h3 = _h3_state()
    components = {}
    if ocr:
        components["ocr"] = ocr
    if h3:
        components["h3"] = h3
    payload = {"device": {"device_id": device_id(), "agent_version": VERSION,
                          "last_seen": int(time.time()), "usage": collect_usage(),
                          "layers": collect_layers(),
                          "components": components}}
    # t78 唯一部署模型：组件部署的 deploy 状态随心跳上报（H3 running/installed、
    # OCR installed 常驻），deploy.state 与 components.* 一致；引擎 deploy 仍走 L3 上报
    if _component_deploy:
        payload["device"]["deploy"] = dict(_component_deploy)
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
                          "type": "engine",   # t78 唯一部署槽：类型权威字段
                          "engine": engine, "model": model,
                          "version": None,    # t85 F2：失败/成功都清陈旧组件 version，防「vocr-x · failed」残留
                          "tunnel_url": tunnel_url,
                          "model_api_key": api_key, "ts": int(time.time())}}
    # 结果心跳为单次投递：真机偶发 TLS 握手超时（t4 实测复现）会整包丢失，
    # 导致云管 deploy 记录缺 Key/隧道 → UI 聊天失效。重试 3 次直至成功。
    for attempt in range(3):
        if heartbeat(payload):
            return
        log("deploy 结果上报失败（第 %d 次），3s 后重试" % (attempt + 1))
        time.sleep(3)

# ---------------------------------------------------------------- 首启单元兜底（旧镜像救活，t33）

BOOTSTRAP_INTERVAL = 600        # 每 10 分钟自检一次（不每心跳查）

def _cfg_val(path, key):
    """读 KEY=VALUE 配置（config.env 风格）；空/占位符视为无"""
    try:
        with open(path) as f:
            for line in f:
                if line.startswith(key + "="):
                    v = line.split("=", 1)[1].strip().strip("'\"")
                    if v and not v.startswith("__"):
                        return v
    except Exception:
        pass
    return ""

def _is_batch_machine():
    """武装条件：批次/镜像机 = /etc/cybercafe/batch.code 存在 或 config.env 的 BATCH_CODE 非空
    （旧版一键命令只写了 config.env 的 BATCH_CODE，两个都要读）"""
    try:
        with open("/etc/cybercafe/batch.code") as f:
            if f.read().strip():
                return True
    except Exception:
        pass
    return bool(_cfg_val("/opt/cybercafe/config.env", "BATCH_CODE"))

def _self_update_off():
    """显式熄火开关：/etc/cybercafe/self_update 内容为 off 时全部跳过"""
    try:
        with open("/etc/cybercafe/self_update") as f:
            return f.read().strip() == "off"
    except Exception:
        return False

def _fetch_extra(name):
    """拉云端 install-extra 白名单文件（公开，无需 key）；失败返回 None"""
    req = urllib.request.Request(API_BASE.rstrip("/") + "/install-extra?name=" + name)
    req.add_header("User-Agent", RAW_UA)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status != 200:
                return None
            return resp.read().decode("utf-8", "replace")
    except Exception as e:
        log("拉取 %s 失败: %s" % (name, e))
        return None

def _atomic_write(path, content, mode=0o644):
    """原子写：临时文件 + os.replace，避免半截文件"""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write(content)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
        return True
    except Exception as e:
        log("写 %s 失败: %s" % (path, e))
        return False

def _unit_enabled():
    rc, _ = run("systemctl is-enabled cybercafe-provision.service", timeout=15)
    return rc == 0

def update_managed_scripts():
    """统一脚本更新管理（L2，t45）：低频跑、幂等、全程 fail-open。
    - 清单 MANAGED_SCRIPTS 覆盖 agent 自身 / install.sh / provision.sh / service / L3；
    - agent 自身走 self_update（心跳路径、服务端版本号比对）；
    - install.sh / provision.sh / service：install-extra 下发 → sha256 比对 → 原子替换，
      仅批次/镜像机武装（单机休眠：零文件替换、零 enable）；
    - L3（cybercafe-deploy.py）走特殊路径：**每次下发部署指令时由云端重取最新并校验执行**，
      不参与低频清单比对（避免机器端缓存旧版）。
    - /etc/cybercafe/self_update=off → 全部跳过（熄火）。"""
    if _self_update_off():
        log("自更新熄火（/etc/cybercafe/self_update=off），跳过")
        return
    if not _is_batch_machine():
        if not update_managed_scripts._dormant_logged:
            log("自更新通道未武装（非批次机），跳过")
            update_managed_scripts._dormant_logged = True
        return
    for item in MANAGED_SCRIPTS:
        try:
            if item["kind"] in ("self", "l3-deploy"):
                continue  # self→心跳 self_update；l3→每次部署重取特殊路径
            src = _fetch_extra(item["name"])
            if src is None:
                log("清单更新 %s 拉取失败（fail-open，跳过本轮）" % item["name"])
                continue
            local = item["local"]
            cur = ""
            try:
                with open(local) as f:
                    cur = f.read()
            except Exception:
                pass
            if cur == src:
                continue
            if _atomic_write(local, src, item.get("mode", 0o644)):
                log("脚本已更新: %s（sha256 %s…）" % (item["name"], hashlib.sha256(src.encode("utf-8", "replace")).hexdigest()[:8]))
                collect_layers(force=True)   # 脚本更新后强制刷新 L1/L2（避免 60s 缓存陈旧）
                if item["name"] == "provision.sh":
                    _ensure_provision_unit()
        except Exception as e:
            log("清单更新 %s 异常: %s" % (item["name"], e))
update_managed_scripts._dormant_logged = False

def _ensure_provision_unit():
    """provision.sh 更新/补齐后：确保首启单元存在、enable、daemon-reload，并当场触发一次注册（旧镜像救活）"""
    unit = "/etc/systemd/system/cybercafe-provision.service"
    unit_src = _fetch_extra("cybercafe-provision.service")
    if unit_src is not None:
        _atomic_write(unit, unit_src, 0o644)
    try:
        os.makedirs("/etc/cybercafe", exist_ok=True)
        bc = _cfg_val("/opt/cybercafe/config.env", "BATCH_CODE")
        ab = _cfg_val("/opt/cybercafe/config.env", "API_BASE")
        if bc and not os.path.exists("/etc/cybercafe/batch.code"):
            _atomic_write("/etc/cybercafe/batch.code", bc + "\n", 0o644)
        if ab and not os.path.exists("/etc/cybercafe/api_base"):
            _atomic_write("/etc/cybercafe/api_base", ab + "\n", 0o644)
    except Exception as e:
        log("写批次码/API 失败: %s" % e)
    rc, out = run("systemctl enable cybercafe-provision.service", timeout=30)
    if rc != 0:
        try:
            w = "/etc/systemd/system/multi-user.target.wants"
            os.makedirs(w, exist_ok=True)
            link = os.path.join(w, "cybercafe-provision.service")
            if not os.path.islink(link):
                os.symlink(unit, link)
        except Exception as e:
            log("enable 兜底失败: %s" % e)
    run("systemctl daemon-reload", timeout=30)
    rc, out = run("systemctl start cybercafe-provision.service", timeout=60)
    if rc == 0:
        log("已当场触发首启注册（systemctl start cybercafe-provision.service ✓）")
    else:
        log("触发首启注册失败（rc=%s，fail-open）: %s" % (rc, out[-200:]))

# ---------------------------------------------------------------- L3 模型脚本（t45：每次下发重取 + 校验 + 执行）

# 统一脚本清单（L2 管理全部下发脚本）：L3 走特殊路径（kind=l3-deploy，每次部署重取）
MANAGED_SCRIPTS = [
    {"name": "cybercafe-agent.py",             "local": None,   "kind": "self"},
    {"name": "install.sh",                     "local": "/opt/cybercafe/install.sh",                      "kind": "agent-scope", "mode": 0o755},
    {"name": "provision.sh",                   "local": "/opt/cybercafe/provision.sh",                    "kind": "agent-scope", "mode": 0o755},
    {"name": "cybercafe-provision.service",    "local": "/etc/systemd/system/cybercafe-provision.service", "kind": "agent-scope", "mode": 0o644},
    {"name": "cybercafe-deploy.py",            "local": "/opt/cybercafe/cybercafe-deploy.py",              "kind": "l3-deploy"},
]
L3_NAME = "cybercafe-deploy.py"
L3_PATH = "/opt/cybercafe/cybercafe-deploy.py"
L3_SENTINEL = "def deploy("   # 内容哨兵：静态通道对不存在文件可能回吐 200 兜底文本，不能只看 HTTP 200

def fetch_l3():
    """每次部署指令都从云端重取最新 L3；内容校验（哨兵+长度+shebang），失败返回 None。"""
    src = _fetch_extra(L3_NAME)
    if not src or len(src) < 64 or L3_SENTINEL not in src or not src.lstrip().startswith("#!/usr/bin/env python3"):
        log("L3 重取校验失败（缺失/过短/哨兵不符）: len=%s" % (len(src) if src else 0))
        return None
    return src

def verify_python(text):
    """执行前校验可解析（用户语义③）：python3 -m py_compile 等价"""
    fd, tmp = __import__("tempfile").mkstemp(suffix=".py")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        rc, out = run("python3 -m py_compile %s" % tmp, timeout=30)
        if rc != 0:
            log("L3 py_compile 校验失败: %s" % out[-300:])
            return False
        return True
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass

def run_l3(mode, cmd):
    """取最新 L3 → 校验 → 落盘 → 执行。任一步失败抛异常（调用方如实上报 fail，绝不回退旧版）。"""
    src = fetch_l3()
    if src is None:
        raise RuntimeError("L3 重取校验失败，拒绝执行（不静默回退旧版）")
    if not verify_python(src):
        raise RuntimeError("L3 校验不过（py_compile 失败），拒绝执行")
    _atomic_write(L3_PATH, src, 0o755)
    env = dict(os.environ)
    env["API_BASE"] = API_BASE
    env["DEVICE_KEY"] = DEVICE_KEY
    env["CYBERCAFE_CMD_JSON"] = json.dumps(cmd, ensure_ascii=False)
    log("L3 执行 mode=%s（sha256 %s…）" % (mode, hashlib.sha256(src.encode("utf-8", "replace")).hexdigest()[:8]))
    p = subprocess.Popen([sys.executable, L3_PATH, mode], env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, errors="replace", bufsize=1)
    last_ts = 0.0
    while True:
        line = p.stdout.readline()
        if not line and p.poll() is not None:
            break
        if line:
            line = line.rstrip()
            if line:
                log("[l3] " + line[-400:])
                if time.time() - last_ts > DEPLOY_HEARTBEAT_INTERVAL:
                    last_ts = time.time()
                    report_progress("command", "running", "L3 执行中: " + line[-120:])
    rc = p.wait()
    log("L3 退出码: %d" % rc)
    return rc

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

_ocr_marker = "/opt/cybercafe-ocr/.ocr-state"

def _ocr_state():
    """components.ocr：读本机 OCR 安装状态标记（install/uninstall 流程写）；缺标记不报。"""
    try:
        with open(_ocr_marker) as f:
            return json.loads(f.read())
    except Exception:
        return None

def _fetch_ocr(script_name, out_path, mode=0o755):
    src = _fetch_extra(script_name)
    if not src or len(src) < 64:
        raise RuntimeError("OCR 脚本 %s 拉取失败/长度异常（%d 字节）" % (script_name, len(src or "")))
    if not (src.startswith("#!") or "#!/" in src[:2]):
        raise RuntimeError("OCR 脚本 %s 校验失败（缺 shebang）" % script_name)
    _atomic_write(out_path, src, mode)
    return src

def run_ocr(action):
    """OCR 安装/卸载：云端拉取 install.sh/ocr.py/uninstall.sh → 校验 → 执行 → 状态回传。
    与 L3 同纪律：拉不到/校验不过 → 如实 fail，绝不静默成功。"""
    import json as _json
    ocr_dir = "/opt/cybercafe-ocr"      # 安装目标（venv/服务/数据）
    src_dir = "/opt/cybercafe-ocr-src"  # 脚本源目录（与 OCR_DIR 分离：install.sh 用
    #  cp 装 ocr.py 到 OCR_DIR，若 SCRIPT_DIR==OCR_DIR 会 cp 同文件触发 set -e 中止）
    os.makedirs(src_dir, exist_ok=True)
    if action == "install":
        _fetch_ocr("ocr/ocr.py", src_dir + "/ocr.py")
        _fetch_ocr("ocr/install.sh", src_dir + "/install.sh")
        st = {"state": "installing", "ts": int(time.time())}
        _atomic_write(_ocr_marker, _json.dumps(st))
        report_progress("ocr", "running", "OCR 安装执行中（venv+pip+服务，首次较久）")
        # stdout/stderr 重定向到日志文件：install.sh 后台启动的 ocr.py 服务会继承管道 fd，
        # 若用 PIPE 捕获，run() 会因管道不关闭而挂到超时（服务一直活着）；重定向后管道随
        # 子 shell 退出即关闭，run() 正常返回，日志留痕供失败时诊断。
        logp = ocr_dir + "/ocr-install.log"
        rc, out = run("bash " + src_dir + "/install.sh > " + logp + " 2>&1", timeout=600)
        if rc != 0:
            try:
                tail = open(logp).read()[-300:]
            except Exception:
                tail = out[-100:]
            raise RuntimeError("OCR 安装失败: " + tail)
        import hashlib as _h
        try:
            ver = "ocr-" + _h.sha256(open(ocr_dir + "/ocr.py", "rb").read()).hexdigest()[:8]
        except Exception:
            ver = None
        _atomic_write(_ocr_marker, _json.dumps({"state": "installed", "version": ver, "ts": int(time.time())}))
        # t78：OCR 常驻 8820，建机器隧道暴露 /ocr（页面可直接使用）并写唯一部署状态
        url = _start_component_tunnel(8820)
        _set_component_deploy({"type": "ocr", "state": "installed", "version": ver,
                               "tunnel_url": url, "ts": int(time.time())})
        report_progress("ocr", "ok", "OCR 安装完成（" + str(ver) + "）")
        return 0
    if action == "uninstall":
        _fetch_ocr("ocr/uninstall.sh", src_dir + "/uninstall.sh")
        st = {"state": "uninstalling", "ts": int(time.time())}
        _atomic_write(_ocr_marker, _json.dumps(st))
        report_progress("ocr", "running", "OCR 卸载执行中")
        logp = ocr_dir + "/ocr-uninstall.log"
        rc, out = run("bash " + src_dir + "/uninstall.sh > " + logp + " 2>&1", timeout=300)
        if rc != 0:
            try:
                tail = open(logp).read()[-300:]
            except Exception:
                tail = out[-100:]
            raise RuntimeError("OCR 卸载失败: " + tail)
        _atomic_write(_ocr_marker, _json.dumps({"state": "uninstalled", "ts": int(time.time())}))
        _clear_component_deploy()   # t78：卸载后唯一部署槽回「无」
        _stop_tunnel()
        report_progress("ocr", "ok", "OCR 已卸载")
        return 0
    raise RuntimeError("未知 OCR action: %s" % action)

# ---------------------------------------------------------------- H3 组件（t74）

_h3_marker = "/opt/minimax-h3/.version"
_H3_DIR = "/opt/minimax-h3"           # 安装目标（权重/编译产物/日志；模块级常量便于沙箱覆盖）
_H3_SRC_DIR = "/opt/cybercafe-h3-src" # 脚本源目录（与 H3_ROOT 分离，避免 cp 同文件）
_H3_ACTIONS = ("install", "uninstall", "start", "stop", "status")

def _h3_state():
    """components.h3：读本机 H3 安装状态标记（install.sh 子命令/主流程写 .version）。"""
    try:
        with open(_h3_marker) as f:
            st = json.loads(f.read())
        return st if isinstance(st, dict) and st.get("state") else None
    except Exception:
        return None

def _fetch_h3(script_name, out_path, mode=0o755):
    src = _fetch_extra(script_name)
    if not src or len(src) < 64:
        raise RuntimeError("H3 脚本 %s 拉取失败/长度异常（%d 字节）" % (script_name, len(src or "")))
    if not (src.startswith("#!") or "#!/" in src[:2]):
        raise RuntimeError("H3 脚本 %s 校验失败（缺 shebang）" % script_name)
    _atomic_write(out_path, src, mode)
    return src

def run_h3(action):
    """H3 安装/卸载/启停：云端拉取 minimax-h3 脚本 → 校验 → 执行 → .version 状态回传。
    install/uninstall 走主流程；start/stop/status 走 install.sh 子命令。
    与 L3/OCR 同纪律：拉不到/校验不过/执行失败 → 如实 fail，绝不静默成功。"""
    import json as _json
    h3_dir = _H3_DIR
    src_dir = _H3_SRC_DIR                  # 脚本源目录（与 H3_ROOT 分离，避免 cp 同文件）
    os.makedirs(src_dir, exist_ok=True)
    if action == "install":
        _fetch_h3("minimax-h3/install.sh", src_dir + "/install.sh")
        st = {"state": "installing", "ts": int(time.time())}
        _atomic_write(_h3_marker, _json.dumps(st))
        report_progress("h3", "running", "H3 安装执行中（编译 sd.cpp + 拉 ~27GB 权重 + 冒烟，约 10-20 分钟）")
        # stdout/stderr 重定向日志文件：install.sh 后台启动的 sd-server 会继承管道 fd，
        # 用 PIPE 捕获会因服务存活导致 run() 挂到超时（与 OCR 同陷阱，t71 已修）
        logp = h3_dir + "/h3-install.log"
        os.makedirs(h3_dir, exist_ok=True)
        rc, out = run("bash " + src_dir + "/install.sh > " + logp + " 2>&1", timeout=1800)
        if rc != 0:
            try:
                tail = open(logp).read()[-300:]
            except Exception:
                tail = out[-100:]
            raise RuntimeError("H3 安装失败: " + tail)
        st = _h3_state()   # install.sh 已写 .version（state=running/installed）
        if not st:
            st = {"state": "installed", "ts": int(time.time())}
            _atomic_write(_h3_marker, _json.dumps(st))
        # t78：H3 安装后若已在运行 → 建机器隧道（11435 OpenAI 兼容）暴露
        url = _start_component_tunnel(11435) if st.get("state") == "running" else None
        _set_component_deploy({"type": "h3", "state": st.get("state", "installed"),
                               "version": st.get("version"), "tunnel_url": url,
                               "ts": int(time.time())})
        report_progress("h3", "ok", "H3 安装完成（" + str(st.get("state", "?")) + "）")
        return 0
    if action == "uninstall":
        _fetch_h3("minimax-h3/uninstall.sh", src_dir + "/uninstall.sh")
        st = {"state": "uninstalling", "ts": int(time.time())}
        _atomic_write(_h3_marker, _json.dumps(st))
        report_progress("h3", "running", "H3 卸载执行中")
        logp = h3_dir + "/h3-uninstall.log"
        os.makedirs(h3_dir, exist_ok=True)
        rc, out = run("bash " + src_dir + "/uninstall.sh > " + logp + " 2>&1", timeout=600)
        if rc != 0:
            try:
                tail = open(logp).read()[-300:]
            except Exception:
                tail = out[-100:]
            raise RuntimeError("H3 卸载失败: " + tail)
        # uninstall.sh 已 rm -rf H3_ROOT（含 .version）→ 状态回到未安装
        _clear_component_deploy()
        _stop_tunnel()
        report_progress("h3", "ok", "H3 已卸载")
        return 0
    if action in ("start", "stop", "status"):
        _fetch_h3("minimax-h3/install.sh", src_dir + "/install.sh")
        report_progress("h3", "running", "H3 %s 执行中" % action)
        rc, out = run("bash " + src_dir + "/install.sh " + action, timeout=300)
        if rc != 0:
            raise RuntimeError("H3 %s 失败: %s" % (action, out[-300:]))
        st = _h3_state() or {}
        if action == "start":
            # t78：H3 启动后建机器隧道（11435 OpenAI 兼容 /v1/models，可直接聊天）
            url = _start_component_tunnel(11435)
            _set_component_deploy({"type": "h3", "state": "running",
                                   "version": st.get("version"), "tunnel_url": url,
                                   "ts": int(time.time())})
        elif action == "stop":
            _stop_tunnel()
            _set_component_deploy({"type": "h3", "state": "installed",
                                   "version": st.get("version"), "tunnel_url": "",
                                   "ts": int(time.time())})
        report_progress("h3", "ok", "H3 %s 完成" % action)
        return 0
    raise RuntimeError("未知 H3 action: %s" % action)

_component_deploy = None   # 组件唯一部署状态 {type,state,version,tunnel_url,ts}（t78 唯一部署模型）

def _set_component_deploy(dep):
    global _component_deploy
    _component_deploy = dep

def _clear_component_deploy():
    global _component_deploy
    _component_deploy = None

def _stop_engine_containers():
    """互斥：停引擎容器 + 网关/隧道（L3 cmd_stop 同款清单，best-effort）"""
    # t91（F1）：互斥停引擎容器名清单——【同步维护点】必须以 agent/cybercafe-deploy.py 的
    # L3 ENGINES 表为单一事实源（ENGINES = {ollama:{container:"ollama"}, vllm:{container:"vllm"},
    # sglang:{container:"sglang"}} + chatgw + cloudflared 隧道容器）。任何引擎容器名改动须同步
    # 此处并与 L3 对齐（t86 真机捕获：旧清单 'vllm-openai' 与实际 'vllm' 不一致致互斥失效）。
    run("docker rm -f ollama vllm sglang cloudflared chatgw 2>/dev/null || true", timeout=60)

def _stop_ocr_server():
    """互斥：停 OCR 服务——真机为 systemd 单元（t92：systemctl stop 优先），pkill 兜底"""
    run("systemctl stop cybercafe-ocr.service 2>/dev/null || true; "
        "if [ -f /opt/cybercafe-ocr/ocr.pid ]; then kill -9 $(cat /opt/cybercafe-ocr/ocr.pid) 2>/dev/null || true; fi; "
        "pkill -9 -f 'ocr.py --serve' 2>/dev/null || true", timeout=30)

def _stop_h3_process():
    """互斥：停 H3 进程——真机 systemd 单元优先（t92），install.sh stop 子命令兜底"""
    run("systemctl stop minimax-h3.service 2>/dev/null || true; "
        "systemctl stop cybercafe-h3.service 2>/dev/null || true", timeout=30)
    if os.path.exists(_H3_SRC_DIR + "/install.sh"):
        run("bash " + _H3_SRC_DIR + "/install.sh stop >/dev/null 2>&1 || true", timeout=120)

def _stop_tunnel():
    run("pkill -9 -f 'cloudflared tunnel' 2>/dev/null || true", timeout=30)

def _stop_other_deployments(target):
    """唯一部署互斥：下发 target 前停掉该机其它部署（引擎容器/OCR 服务/H3 进程/隧道）。
    一台机器同时最多一个部署；引擎↔OCR↔H3 可来回切换（t78）。"""
    if target != "engine":
        _stop_engine_containers()
    if target != "ocr":
        _stop_ocr_server()
    if target != "h3":
        _stop_h3_process()
    if target != "engine":
        _stop_tunnel()
    log("互斥清理完成（target=%s，其余部署已停）" % target)

def _start_component_tunnel(port):
    """组件部署建机器隧道（trycloudflare）暴露组件 API（H3=11435 / OCR=8820）；
    限时等待 URL（40s 硬上限），取不到如实返回 None（部署状态照常写入，UI 显示无隧道）。
    t93：镜像 L3 step_tunnel 用 docker cloudflared（真机 cloudflared 以 docker 形态运行，
    裸二进制不存在）；无 docker 环境（沙箱）回退裸二进制。"""
    _stop_tunnel()
    url = None
    has_docker = run("docker info >/dev/null 2>&1", timeout=15)[0] == 0
    if has_docker:
        run("docker rm -f cloudflared 2>/dev/null || true", timeout=30)
        rc, out = run("docker run -d --name cloudflared --network host --restart unless-stopped "
                      "cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://127.0.0.1:%d" % port,
                      timeout=120)
        if rc == 0:
            deadline = time.time() + 40
            while time.time() < deadline:
                t, out2 = run("docker logs --tail 50 cloudflared 2>&1", timeout=15)
                m = __import__("re").search(r"https://[a-z0-9-]+\.trycloudflare\.com", out2)
                if m:
                    url = m.group(0)
                    break
                time.sleep(3)
        else:
            log("组件隧道 docker cloudflared 启动失败: %s" % out[-120:])
    else:
        rc, out = run("command -v cloudflared >/dev/null 2>&1", timeout=10)
        if rc == 0:   # 沙箱回退：裸二进制
            run("cloudflared tunnel --no-autoupdate --url http://127.0.0.1:%d >> /tmp/cc-tunnel.log 2>&1 &" % port, timeout=10)
            deadline = time.time() + 40
            while time.time() < deadline:
                try:
                    with open("/tmp/cc-tunnel.log") as f:
                        for line in f:
                            i = line.find("https://")
                            if i >= 0 and "trycloudflare.com" in line[i:]:
                                url = line[i:].strip().split()[0]
                                break
                except Exception:
                    pass
                if url:
                    break
                time.sleep(2)
        else:
            log("组件隧道不可用：无 docker 且无 cloudflared 二进制")
    if not url:
        log("组件隧道启动超时（40s 未取到 trycloudflare URL）")
    return url


# ---------- t97：磁盘滚动回收（部署前自动 + 手动命令） ----------
def _disk_free_gb(path="/opt"):
    """当前磁盘余量（GB）：取文件系统可用块，失败返回 0.0 并如实（宁不部署不误判）"""
    rc, out = run("df -m %s | tail -1 | awk '{print $4}'" % path, timeout=20)
    try:
        return float(out.strip()) / 1024.0
    except Exception:
        return 0.0

def _estimate_deploy_needs(engine, model):
    """部署前容量估算（GB 量级，含镜像+权重）：不足目标值由回收补齐"""
    base = {"ollama": 4.0, "vllm": 9.0, "sglang": 9.0, "strata": 6.0}.get(engine or "", 6.0)
    return base

def _lru_recycle(target_gb):
    """滚动回收（LRU 最旧先清）：① docker 悬空/构建缓存 → ② 非当前部署的旧引擎镜像
    （含 mirror 前缀）→ ③ 非当前模型的 HF 缓存/旧权重 → ④ 旧组件残留。
    红线段绝不碰：当前正在运行的部署、agent 自身/systemd/KEEP_PATHS。返回 (freed_gb, items)。"""
    free_0 = _disk_free_gb()
    freed = 0.0
    items = []
    def df_now():
        return _disk_free_gb()
    def note(kind, detail):
        items.append("%s:%s" % (kind, detail))
    def __delta():
        nonlocal freed
        freed = _disk_free_gb() - free_0   # 增量：实际腾出（GB）
    # 当前运行部署的保留集（引擎容器镜像 + 当前组件目录）
    keep_img = set()
    rc, out = run("docker ps --format {{.Image}} 2>/dev/null", timeout=20)
    for ln in out.splitlines():
        if ln.strip():
            keep_img.add(ln.strip())
    keep_paths = {"/opt/cybercafe-agent", "/opt/cybercafe-ocr", "/opt/minimax-h3"}

    if freed < target_gb:
        rc1, o1 = run("docker image prune -f 2>/dev/null | tail -1", timeout=120)
        rc2, o2 = run("docker builder prune -f 2>/dev/null >/dev/null 2>&1; echo done", timeout=120)
        freed_d = df_now()
        note("docker-cache", "image/builder prune")
        __delta()
    # ② 旧引擎镜像（保留当前运行镜像；t97【LRU 序】同级按 CreatedAt 升序=最旧先清）
    if freed < target_gb:
        rc, out = run("docker images -a --format '{{.ID}}\t{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}'", timeout=30)
        rows = []
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            img = parts[2].strip()
            if not img or img in keep_img or not any(k in img for k in
                    ("ollama", "vllm", "sglang", "strata", "minimax", "cloudflared", "chatgw", "ghcr", "mirror")):
                continue
            rows.append((parts[1].strip(), img))   # (CreatedAt, image)
        rows.sort(key=lambda r: r[0])              # 升序 → 最近最少使用（最旧）优先
        gone = 0
        for _, img in rows:
            if freed >= target_gb:
                break
            run("docker rmi -f %s >/dev/null 2>&1" % img, timeout=120)
            gone += 1
            freed = df_now()
            note("old-image", img)
        __delta()
        if gone == 0:
            note("old-image", "无")
    # ③ HF 缓存非当前模型（粗粒度：清 .cache/huggingface 中非最新权重子目录，保守只清空大文件）
    if freed < target_gb:
        rc, out = run("du -sm /root/.cache/huggingface 2>/dev/null | awk '{print $1}'", timeout=20)
        try:
            hf_mb = int(out.strip() or "0")
        except Exception:
            hf_mb = 0
        if hf_mb > 512:
            run("find /root/.cache/huggingface -type f -size +200M -not -path '*%s*' -delete 2>/dev/null || true" % "", timeout=60)
            note("hf-cache", "清权重大文件")
        __delta()
    # ④ 旧组件残留（非当前组件的 venv/目录大文件，保守：只清 .venv/venv 构建残留于非当前组件根）
    if freed < target_gb:
        run("find /opt -maxdepth 2 -name 'venv' -o -maxdepth 2 -name '.cache' 2>/dev/null | grep -v -E '%s' | xargs -r rm -rf 2>/dev/null || true" % "|".join(sorted(keep_paths)), timeout=60)
        freed = df_now()
        note("old-component", "残留 venv/cache")
        __delta()
    return freed, items

def _ensure_disk_before_deploy(engine, model):
    """部署前磁盘保障：余量足 → 直接过；不足 → 自动滚动回收；回收后仍不足 → 如实失败。
    返回 (ok, free_gb, freed_gb, items)。"""
    need = _estimate_deploy_needs(engine, model)
    free0 = _disk_free_gb()
    if free0 >= need + 1.0:
        return (True, free0, 0.0, [])
    log("磁盘余量不足：free=%.1fGB 需≈%.1fGB，启动滚动回收" % (free0, need))
    freed, items = _lru_recycle(need - free0 + 1.0)
    free1 = _disk_free_gb()
    ok = free1 >= need + 0.5
    detail = "磁盘检查: 前 %.1fGB 后 %.1fGB 回收 %.1fGB[%s]" % (free0, free1, freed, ",".join(items or ["无"]))
    report_progress("disk", "ok" if ok else "fail", detail)
    return (ok, free1, freed, items)

def handle_command(cmd):
    ctype = cmd.get("type")
    log("收到指令: %s" % json.dumps(cmd, ensure_ascii=False))
    try:
        if ctype in ("deploy", "stop", "restart_tunnel"):
            if ctype == "deploy":
                _stop_other_deployments("engine")   # t78 唯一部署互斥：引擎下发前停 OCR/H3
                _clear_component_deploy()            # t78：引擎接管唯一部署槽，停止心跳重发旧组件块
                report_progress("command", "running", "下发最新 L3 并部署 %s %s" % (cmd.get("engine"), cmd.get("model")))
                # t97：部署前磁盘保障——不足自动滚动回收，仍不足如实取消（不假成功）
                ok_d, free_gb, freed_gb, items = _ensure_disk_before_deploy(cmd.get("engine"), cmd.get("model"))
                if not ok_d:
                    report_progress("command", "fail",
                        "磁盘空间不足（free=%.1fGB 需≈%.1fGB 回收后仍不足%s）——如实取消部署" %
                        (free_gb, _estimate_deploy_needs(cmd.get("engine"), cmd.get("model")),
                         ("[清:" + ",".join(items) + "]") if items else ""))
                    report_deploy_result(False, model=cmd.get("model", ""))
                    return
            else:
                report_progress("command", "running", "下发最新 L3 执行 %s" % ctype)
            rc = run_l3(ctype, cmd)
            if rc != 0:
                # L3 已自行上报 fail；此处兜底补报（防上报链路偶发丢失），字段与既有契约一致
                log("L3 执行失败（rc=%d），结果已如实上报 fail（不回退旧版）" % rc)
                report_deploy_result(False, model=cmd.get("model", ""))
            else:
                log("L3 执行完成（rc=0，结果由 L3 上报）")
                # t78：引擎接管唯一部署槽——重写 deploy.type=engine（merge 会保留 L3 的
                # engine/model/tunnel_url，但清掉残留组件 type/version 字段）
                heartbeat({"deploy": {"type": "engine", "state": "online",
                                      "ts": int(time.time())}})
        elif ctype == "recycle":
            # t97 手动触发：回收 target_gb（默认 5GB），事件进设备日志（页面日志 tab 可见）
            target = float(cmd.get("target_gb") or 5.0)
            report_progress("disk", "running", "手动滚动回收（目标 %.1fGB）" % target)
            freed, items = _lru_recycle(target)
            report_progress("disk", "ok", "手动回收完成: 清理 %d 项 腾出 %.1fGB [%s]" %
                            (len(items), freed, ",".join(items[:8])))
            log("手动回收完成: freed=%.1fGB items=%s" % (freed, ",".join(items[:8])))
        elif ctype == "ocr":
            action = cmd.get("action", "install")
            if action == "install":
                _stop_other_deployments("ocr")      # t78 唯一部署互斥：OCR 安装前停引擎/H3
            report_progress("ocr", "running", "OCR 指令: %s" % action)
            rc = run_ocr(action)
            if rc != 0:
                report_progress("ocr", "fail", "OCR %s 失败（rc=%d）" % (action, rc))
                # t85 F2：失败后唯一部署槽显示本次失败目标（type=ocr + failed，version 清空）
                _clear_component_deploy()
                heartbeat({"deploy": {"type": "ocr", "state": "failed", "version": None,
                                      "ts": int(time.time())}})
            else:
                log("OCR %s 完成" % action)
        elif ctype == "h3":
            action = cmd.get("action", "install")
            if action not in _H3_ACTIONS:
                raise RuntimeError("未知 H3 action: %s" % action)
            if action in ("install", "start"):
                _stop_other_deployments("h3")       # t78 唯一部署互斥：H3 安装/启动前停引擎/OCR
            report_progress("h3", "running", "H3 指令: %s" % action)
            rc = run_h3(action)
            if rc != 0:
                report_progress("h3", "fail", "H3 %s 失败（rc=%d）" % (action, rc))
                # t85 F2：失败后唯一部署槽显示本次失败目标（type=h3 + failed，version 清空）
                _clear_component_deploy()
                heartbeat({"deploy": {"type": "h3", "state": "failed", "version": None,
                                      "ts": int(time.time())}})
            else:
                log("H3 %s 完成" % action)
        else:
            log("未知指令类型: %s" % ctype)
    except Exception as e:
        # 取不到/校验不过/执行启动失败 → 如实回报失败，不静默回退旧版（用户语义②③）
        log("指令执行失败: %s" % e)
        traceback.print_exc()
        report_progress("command", "fail", str(e)[:300])
        # t85 F2：异常路径按指令类型如实上报失败槽位（引擎/OCR/H3），version 清空；
        # 引擎专用 report_deploy_result 仅在 deploy 指令时调用（避免覆盖 h3/ocr 的失败类型）
        fail_type = "engine" if ctype == "deploy" else (ctype if ctype in ("ocr", "h3") else "engine")
        _clear_component_deploy()
        heartbeat({"deploy": {"type": fail_type, "state": "failed", "version": None,
                              "ts": int(time.time())}})
        if ctype == "deploy":
            report_deploy_result(False, model=cmd.get("model", ""))

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
    collect_layers(force=True)   # 启动强制刷新 L1/L2（预热 60s 缓存，首心跳即上报最新状态）
    last_boot = 0.0            # 统一脚本更新：启动即检一次，此后每 10 分钟低频自检
    poll = HEARTBEAT_INTERVAL
    while True:
        try:
            if time.time() - last_boot >= BOOTSTRAP_INTERVAL:
                last_boot = time.time()
                update_managed_scripts()
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
