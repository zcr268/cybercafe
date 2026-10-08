#!/usr/bin/env python3
# CyberCafe H3 NVML 采样器（t48 验收：不依赖 nvidia-smi，ctypes 直读 libnvidia-ml）
# 依据真机 nvml.h（驱动自带）：nvmlDeviceGetMemoryInfo_v2(device, nvmlMemory_v2_t*)
#   nvmlMemory_v2_t = { uint version(=2), u64 total, u64 reserved, u64 free, u64 used }
# 用法：python3 nvml_monitor.py <秒数> [采样间隔秒]
import ctypes, time, sys

n = ctypes.CDLL("libnvidia-ml.so.1")
n.nvmlInit_v2()
h = ctypes.c_void_p()
n.nvmlDeviceGetHandleByIndex_v2(0, ctypes.byref(h))

class UtilRates(ctypes.Structure):
    _fields_ = [("gpu", ctypes.c_uint), ("memory", ctypes.c_uint)]

# nvmlMemory_v2_t（字段顺序见 nvml.h：version, total, reserved, free, used；
#   version 必须 = NVML_STRUCT_VERSION(Memory, 2) = 0x02000028，填 2 会返回 FUNCTION_NOT_FOUND）
class MemV2(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint),
                ("total", ctypes.c_uint64),
                ("reserved", ctypes.c_uint64),
                ("free", ctypes.c_uint64),
                ("used", ctypes.c_uint64)]

NVML_MEMORY_V2 = 0x02000028   # NVML_STRUCT_VERSION(Memory, 2) = (2<<24)|sizeof=40

fn_mem = n.nvmlDeviceGetMemoryInfo_v2
fn_mem.argtypes = [ctypes.c_void_p, ctypes.POINTER(MemV2)]
fn_mem.restype = ctypes.c_int

fn_util = n.nvmlDeviceGetUtilizationRates
fn_util.argtypes = [ctypes.c_void_p, ctypes.POINTER(UtilRates)]
fn_util.restype = ctypes.c_int

dur = float(sys.argv[1]) if len(sys.argv) > 1 else 90.0
interval = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
t0 = time.time()
end = t0 + dur
peak_used = 0
nonzero = 0
samples = 0
while time.time() < end:
    m = MemV2()
    m.version = NVML_MEMORY_V2   # 0x02000028
    rc = fn_mem(h, ctypes.byref(m))
    u = UtilRates()
    rc2 = fn_util(h, ctypes.byref(u))
    used_mb = m.used // (1024 * 1024)
    peak_used = max(peak_used, used_mb)
    if u.gpu > 0:
        nonzero += 1
    samples += 1
    print("NVML t=%ds used=%dMB util_gpu=%d%% util_mem=%d%% (rc=%d/%d)" %
          (int(time.time() - t0), used_mb, u.gpu, u.memory, rc, rc2), flush=True)
    time.sleep(interval)
print("RESULT: samples=%d peak_used_MB=%d nonzero_gpu_util_samples=%d" %
      (samples, peak_used, nonzero))