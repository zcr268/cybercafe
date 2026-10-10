#!/usr/bin/env bash
# Version: 1.0.2
# CyberCafe 安装脚本（由云管理端动态注入 __API_BASE__ / __DEVICE_KEY__ 后下发）
# 用法:
#   单机模式: curl -fsSL "<云管理地址>/install.sh?key=<设备KEY>" | bash
#   批次模式（基础镜像批量装机）: bash install.sh --batch <批次码>   （或环境变量 PROVISION_CODE）
#     批次模式下 API 地址取 PROVISION_API_BASE 环境变量 / /etc/cybercafe/api_base /
#     provision.sh 已写入的 /opt/cybercafe/config.env；设备密钥由云端 /api/device/provision 颁发
#   镜像预置模式（刻录基础镜像前执行，仅预置批次码+首启注册逻辑，不装 agent）:
#     bash install.sh --image-prep --batch <批次码> --api-base <云管理地址>
#     等价于: 写 /etc/cybercafe/batch.code + /etc/cybercafe/api_base → 安装
#     provision.sh + cybercafe-provision.service（oneshot, enable）→ 镜像每实例首启自动注册
#     （--root <目录> 可指定目标根，供构建器/临时目录 dry-run 验证）
set -euo pipefail

API_BASE="__API_BASE__"
DEVICE_KEY="__DEVICE_KEY__"
INSTALL_DIR="/opt/cybercafe"
SERVICE_NAME="cybercafe-agent"
BATCH_CODE="${PROVISION_CODE:-}"
IMAGE_PREP=""
IMAGE_ROOT=""

# 硬件指纹（install.sh 与 provision.sh 各一份、必须逐字相同；t39 三级回退）：
#   ① GPU UUID（/proc 优先 → nvidia-smi，多卡 UUID 排序 join）→ ② 物理网卡 MAC → ③ machine-id
# 输出格式：`<fp> <source>`（caller 用 read HW_FP FP_SOURCE 解析；$( ) 子壳内改不了外部变量）
FP_SOURCE="gpu"
hw_fingerprint() {
  local macs=() dev name mac joined id nvidia_bin out src fp uuid uuids=()
  # ---- ① GPU UUID（/proc 优先 → nvidia-smi 兜底；仅接受 ^GPU-[0-9A-Fa-f-]+$，否则降级 MAC）----
  # 【边界】「身份走 /proc、负载走 NVML」：/proc/driver/nvidia 只有身份字段
  # （gpus/*/information 仅 Model/IRQ/GPU UUID/Video BIOS/Bus Location 等），无 memory/utilization——
  # /proc 只用于取 UUID（t49 新增不依赖 nvidia-smi 的优先源），禁止把它当显存/利用率源。
  # 无卡机 gpus/ 为空 → 自然落到 nvidia-smi/MAC。格式校验修 t40 缺陷#4：
  # 'No devices were found' 等文本/小写 gpu- 前缀一律拒绝（fullmatch 语义）。
  src="gpu"
  uuids=()
  for inf in /proc/driver/nvidia/gpus/*/information; do
    [ -f "$inf" ] || continue
    while IFS= read -r uuid; do
      [ -z "$uuid" ] && continue
      if printf '%s\n' "$uuid" | grep -Eq '^GPU-[0-9A-Fa-f-]+$'; then uuids+=("$uuid"); fi
    done < <(sed -n 's/^GPU UUID:[[:space:]]*//p' "$inf")
  done
  if [ "${#uuids[@]}" -gt 0 ]; then
    joined="$(printf '%s\n' "${uuids[@]}" | sort | paste -sd'|' -)"
    if command -v sha256sum >/dev/null 2>&1; then
      fp="$(printf '%s' "$joined" | sha256sum | cut -c1-12)"
    else
      fp="$(printf '%s' "$joined" | cksum | awk '{print $1}' | cut -c1-12)"
    fi
    echo "$fp $src"
    return 0
  fi
  # nvidia-smi 兜底（同 fullmatch 校验；输出空/异常/非 GPU- 一律不写入指纹）
  nvidia_bin=""
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia_bin="$(command -v nvidia-smi)"
  else
    for p in /usr/bin/nvidia-smi /usr/local/bin/nvidia-smi /usr/lib/wsl/lib/nvidia-smi; do
      if [ -x "$p" ]; then nvidia_bin="$p"; break; fi
    done
  fi
  uuids=()
  if [ -n "$nvidia_bin" ]; then
    out="$($nvidia_bin --query-gpu=uuid --format=csv,noheader 2>/dev/null || true)"
    while IFS= read -r uuid; do
      [ -z "$uuid" ] && continue
      if printf '%s\n' "$uuid" | grep -Eq '^GPU-[0-9A-Fa-f-]+$'; then uuids+=("$uuid"); fi
    done <<< "$out"
  fi
  if [ "${#uuids[@]}" -gt 0 ]; then
    joined="$(printf '%s\n' "${uuids[@]}" | sort | paste -sd'|' -)"
    if command -v sha256sum >/dev/null 2>&1; then
      fp="$(printf '%s' "$joined" | sha256sum | cut -c1-12)"
    else
      fp="$(printf '%s' "$joined" | cksum | awk '{print $1}' | cut -c1-12)"
    fi
    echo "$fp $src"
    return 0
  fi
  # ---- ② 物理网卡 MAC（排除列表/全零 MAC 同 t33；排序后 sha256 前 12 位）----
  src="mac"
  for dev in /sys/class/net/*; do
    name="$(basename "$dev")"
    case "$name" in
      lo|docker*|veth*|br-*|virbr*|tun*|tap*|tailscale*|zt*|wg*|bond*|dummy*|sit*|ip6tnl*) continue ;;
    esac
    [ -f "$dev/address" ] || continue
    mac="$(cat "$dev/address")"
    [ -n "$mac" ] && [ "$mac" != "00:00:00:00:00:00" ] || continue
    macs+=("$mac")
  done
  if [ "${#macs[@]}" -gt 0 ]; then
    joined="$(printf '%s\n' "${macs[@]}" | sort | paste -sd'|' -)"
    if command -v sha256sum >/dev/null 2>&1; then
      fp="$(printf '%s' "$joined" | sha256sum | cut -c1-12)"
    else
      fp="$(printf '%s' "$joined" | cksum | awk '{print $1}' | cut -c1-12)"
    fi
    echo "$fp $src"
    return 0
  fi
  # ---- ③ machine-id 兜底 ----
  src="machine-id"
  id="$( { cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || hostname; } )"
  if command -v sha256sum >/dev/null 2>&1; then
    fp="$(printf '%s' "$id" | sha256sum | cut -c1-12)"
  else
    fp="$(printf '%s' "$id" | cksum | awk '{print $1}' | cut -c1-12)"
  fi
  echo "$fp $src"
}

# 参数: --batch <code> | --image-prep | --api-base <url> | --root <dir>
while [ $# -gt 0 ]; do
  case "$1" in
    --batch) BATCH_CODE="${2:-}"; shift 2 ;;
    --batch=*) BATCH_CODE="${1#--batch=}"; shift ;;
    --image-prep) IMAGE_PREP=1; shift ;;
    --api-base) PROVISION_API_BASE="${2:-}"; shift 2 ;;
    --api-base=*) PROVISION_API_BASE="${1#--api-base=}"; shift ;;
    --root) IMAGE_ROOT="${2:-}"; shift 2 ;;
    --root=*) IMAGE_ROOT="${1#--root=}"; shift ;;
    *) echo "[cybercafe] ERROR: 未知参数: $1（支持 --batch <批次码> / --image-prep / --api-base <url> / --root <dir>）" >&2; exit 1 ;;
  esac
done

echo "[cybercafe] 安装开始 (API=$API_BASE)"

# root 检查：--image-prep --root <临时目录> 验证场景允许非 root（写的是临时根，非系统路径）
if [ -z "$IMAGE_PREP" ] || [ -z "$IMAGE_ROOT" ]; then
    if [ "$(id -u)" != "0" ]; then
        echo "[cybercafe] ERROR: 需要 root 运行" >&2
        exit 1
    fi
fi
# 注意：占位符拆分拼接，避免云端注入时把校验逻辑本身也替换掉
PH_KEY="__DEVICE_""KEY__"
PH_API="__API_""BASE__"

# ---------- 镜像预置模式（仅基础镜像构建/刻录前使用，exit 后不进入正常安装流程） ----------
if [ -n "$IMAGE_PREP" ]; then
    API_BASE="${PROVISION_API_BASE:-}"
    P="${IMAGE_ROOT:-}"
    if [ -z "$BATCH_CODE" ]; then
        echo "[cybercafe] ERROR: --image-prep 需要 --batch <批次码>" >&2
        exit 1
    fi
    if [ -z "$API_BASE" ]; then
        echo "[cybercafe] ERROR: --image-prep 需要 --api-base <云管理地址> 或环境变量 PROVISION_API_BASE" >&2
        exit 1
    fi
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ ! -f "$SCRIPT_DIR/provision.sh" ] || [ ! -f "$SCRIPT_DIR/cybercafe-provision.service" ]; then
        echo "[cybercafe] ERROR: 需要与 install.sh 同目录的 provision.sh 与 cybercafe-provision.service（来自仓库 agent/）" >&2
        exit 1
    fi
    mkdir -p "${P}/etc/cybercafe" "${P}${INSTALL_DIR}" "${P}/etc/systemd/system/multi-user.target.wants"
    printf '%s\n' "$BATCH_CODE" > "${P}/etc/cybercafe/batch.code"
    printf '%s\n' "$API_BASE"    > "${P}/etc/cybercafe/api_base"
    cp "$SCRIPT_DIR/provision.sh" "${P}${INSTALL_DIR}/provision.sh"
    chmod 755 "${P}${INSTALL_DIR}/provision.sh"
    cp "$SCRIPT_DIR/cybercafe-provision.service" "${P}/etc/systemd/system/cybercafe-provision.service"
    # enable 的实质（构建期可能无 systemd 运行，systemctl 不可用）：wants symlink
    ln -sf /etc/systemd/system/cybercafe-provision.service "${P}/etc/systemd/system/multi-user.target.wants/cybercafe-provision.service"
    echo "[cybercafe] ✅ 镜像预置完成（root=${P}）"
    echo "  - 批次码:   $(cat "${P}/etc/cybercafe/batch.code")"
    echo "  - API:      $(cat "${P}/etc/cybercafe/api_base")"
    echo "  - provision: ${INSTALL_DIR}/provision.sh + cybercafe-provision.service（oneshot, enabled）"
    echo "  镜像每实例首启将自动执行: machine-id → POST /api/device/provision → 领 cck- key → install.sh --batch → .provisioned"
    exit 0
fi

mkdir -p "$INSTALL_DIR"

# 批次模式：从 config.env（provision.sh 已写）或云端 provision API 取得 API_BASE/DEVICE_KEY
if [ -n "$BATCH_CODE" ]; then
    echo "[cybercafe] 批次模式: batch=$BATCH_CODE"
    read HW_FP FP_SOURCE <<< "$(hw_fingerprint)"
    FP_SOURCE="${FP_SOURCE:-gpu}"
    echo "[cybercafe] 硬件指纹: $HW_FP（来源: $FP_SOURCE）"
    if [ -f "$INSTALL_DIR/config.env" ]; then . "$INSTALL_DIR/config.env"; fi
    if [ -z "${API_BASE:-}" ] || [ "$API_BASE" = "$PH_API" ]; then
        API_BASE="${PROVISION_API_BASE:-}"
        if [ -f /etc/cybercafe/api_base ]; then API_BASE="$(head -1 /etc/cybercafe/api_base)"; fi
    fi
    if [ -z "$API_BASE" ] || [ "$API_BASE" = "$PH_API" ]; then
        echo "[cybercafe] ERROR: 批次模式需要 API 地址（PROVISION_API_BASE 或 /etc/cybercafe/api_base）" >&2
        exit 1
    fi
    if [ -z "${DEVICE_KEY:-}" ] || [ "$DEVICE_KEY" = "$PH_KEY" ]; then
        MACHINE_ID="$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo "unknown-$(hostname)")"
        echo "[cybercafe] 向云端申请设备密钥 (machine=$MACHINE_ID, fp=$HW_FP) ..."
        PROV_JSON="$(curl -sS --max-time 60 -X POST "$API_BASE/api/device/provision" \
            -H "Content-Type: application/json" \
            -d "{\"batch_code\":\"$BATCH_CODE\",\"machine_id\":\"$MACHINE_ID\",\"hardware_id\":\"$HW_FP\",\"hw_source\":\"$FP_SOURCE\",\"device\":{\"hostname\":\"$(hostname | tr -d '"')\",\"os\":\"$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' | head -1)\"}}" 2>&1 || true)"
        DEVICE_KEY="$(echo "$PROV_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("device_key",""))' 2>/dev/null || true)"
        [ -z "$DEVICE_KEY" ] && { echo "[cybercafe] ERROR: 批次申请密钥失败: $PROV_JSON" >&2; exit 1; }
        RESP_API="$(echo "$PROV_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_base",""))' 2>/dev/null || true)"
        [ -n "$RESP_API" ] && API_BASE="$RESP_API"
    fi
    MACHINE_ID="${MACHINE_ID:-$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo "unknown-$(hostname)")}"
fi

if [ -z "$DEVICE_KEY" ] || [ "$DEVICE_KEY" = "$PH_KEY" ] || [ "$API_BASE" = "$PH_API" ]; then
    echo "[cybercafe] ERROR: 参数未注入，请从云管理端复制完整安装命令" >&2
    exit 1
fi

# 依赖：python3 + curl
need_apt=0
command -v python3 >/dev/null 2>&1 || need_apt=1
command -v curl   >/dev/null 2>&1 || need_apt=1
if [ "$need_apt" = "1" ]; then
    echo "[cybercafe] 安装依赖 python3/curl ..."
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 curl
fi

echo "[cybercafe] 从云管理端拉取最新控制脚本 ..."
curl -fsSL -H "X-Device-Key: $DEVICE_KEY" "$API_BASE/api/agent/latest" -o "$INSTALL_DIR/cybercafe-agent.py"
chmod +x "$INSTALL_DIR/cybercafe-agent.py"

AGENT_VER=$(grep -m1 '^VERSION = ' "$INSTALL_DIR/cybercafe-agent.py" | cut -d'"' -f2)
echo "[cybercafe] 控制脚本版本: $AGENT_VER"

cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=CyberCafe Local Control Agent
After=network-online.target docker.service cybercafe-provision.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $INSTALL_DIR/cybercafe-agent.py
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

# ---------- 3.5) docker-prep 框架落位（t104：A 脚本 base+模板+资产，供 L1 预装/L3 兜底） ----------
if [ -d "$(dirname "$INSTALL_DIR")/deploy/docker" ]; then
    mkdir -p "$INSTALL_DIR/docker-prep"
    cp -r "$(dirname "$INSTALL_DIR")/deploy/docker/." "$INSTALL_DIR/docker-prep/"
    # t107：引擎 docker-prep（独立目录 deploy/docker-prep/）一并落位（docker-prep.<engine>.sh）
    if [ -d "$(dirname "$INSTALL_DIR")/deploy/docker-prep" ]; then
        cp -r "$(dirname "$INSTALL_DIR")/deploy/docker-prep/." "$INSTALL_DIR/docker-prep/"
    fi
    chmod +x "$INSTALL_DIR"/docker-prep/*.sh
    echo "[cybercafe] docker-prep 框架已落位（$INSTALL_DIR/docker-prep/docker-prep-base.sh + 引擎脚本）"
elif [ -d "$INSTALL_DIR/docker-prep" ]; then
    echo "[cybercafe] docker-prep 框架已存在（跳过拷贝）"
else
    echo "[cybercafe] ⚠️ 未找到 deploy/docker 目录（docker-prep 框架不落位；不影响 agent 主流程）" >&2
fi

# ---------- 3.6) 装机默认执行当下所有 docker-prep（t105：一次装齐源/toolkit/runtime/预构建镜像） ----------
# 幂等：各 docker-prep 脚本内部均已幂等（已有源/已装 toolkit/已注册 runtime/镜像已存在均跳过）；
# 单个失败不阻断装机（记日志继续，L3 运行时兜底补）。顺序：base 先行（字母序 glob），模板随后
# （模板各自再调 base，幂等无害）。
if [ -d "$INSTALL_DIR/docker-prep" ]; then
    echo "[cybercafe] docker-prep 装机预装（遍历 docker-prep*.sh，幂等；单失败不阻断）..."
    for P in "$INSTALL_DIR"/docker-prep/docker-prep*.sh; do
        [ -f "$P" ] || continue
        NAME=$(basename "$P")
        LOG=/tmp/docker-prep-${NAME%.sh}.log
        if bash "$P" >"$LOG" 2>&1; then
            echo "[cybercafe] docker-prep 完成: $NAME"
        else
            echo "[cybercafe] ⚠️ docker-prep 未完成（$NAME，rc=$?；见 $LOG；L3 运行时兜底补）" >&2
        fi
    done
fi

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}.service
# 克隆自愈场景（provision.sh 内调用本脚本，CYBERCAFE_FROM_PROVISION=1）时 provision 单元正在运行，
# agent 的 After=cybercafe-provision.service 会让同步 start 与 provision 互相等待 → 死锁。
# 故此时用 --no-block 异步启动（systemd 会在 provision 结束后按 ordering 自动拉起 agent）；
# 其余场景保持同步启动语义不变。
if [ "${CYBERCAFE_FROM_PROVISION:-}" = "1" ]; then
    systemctl start --no-block ${SERVICE_NAME}.service
else
    systemctl start ${SERVICE_NAME}.service
fi

# 克隆机重装场景：enable/start 对已运行的 agent 不重启，必须显式 restart 让新 key/新代码生效
if [ -n "$BATCH_CODE" ]; then
    if [ "${CYBERCAFE_FROM_PROVISION:-}" = "1" ]; then
        systemctl restart --no-block ${SERVICE_NAME}.service 2>/dev/null || true
    else
        systemctl restart ${SERVICE_NAME}.service 2>/dev/null || echo "[cybercafe] ⚠️ 服务重启失败，请检查: journalctl -u ${SERVICE_NAME} -n 20" >&2
    fi
fi

# 批次模式：补装首启自检单元（换机开机自动注册/自愈；curl|bash 场景 $SCRIPT_DIR 不可靠 → 从云端拉）
if [ -n "$BATCH_CODE" ]; then
    provision_ok=1
    curl -fsSL --max-time 30 "$API_BASE/install-extra?name=provision.sh" -o "$INSTALL_DIR/provision.sh" 2>/dev/null || provision_ok=0
    curl -fsSL --max-time 30 "$API_BASE/install-extra?name=cybercafe-provision.service" -o /etc/systemd/system/cybercafe-provision.service 2>/dev/null || provision_ok=0
    if [ "$provision_ok" = "1" ]; then
        chmod 755 "$INSTALL_DIR/provision.sh"
        if command -v systemctl >/dev/null 2>&1; then
            systemctl daemon-reload || true
            systemctl enable cybercafe-provision.service >/dev/null 2>&1 || true
        else
            mkdir -p /etc/systemd/system/multi-user.target.wants
            ln -sf /etc/systemd/system/cybercafe-provision.service /etc/systemd/system/multi-user.target.wants/cybercafe-provision.service
        fi
        echo "[cybercafe] ✅ 首启自检单元已安装（provision.sh + cybercafe-provision.service，每次开机自检/克隆自愈）"
    else
        echo "[cybercafe] ⚠️ 警告: 首启自检单元拉取失败（install-extra），镜像将缺少换机自动注册能力；请检查 $API_BASE/install-extra" >&2
    fi
fi

sleep 3
if systemctl is-active --quiet ${SERVICE_NAME}.service; then
    if [ -n "$BATCH_CODE" ]; then
        # 持久化配置 + 首启标记（provision.sh / 重复 install 复用，防重复注册）
        cat > "$INSTALL_DIR/config.env" << EOF
API_BASE='$API_BASE'
DEVICE_KEY='$DEVICE_KEY'
BATCH_CODE='$BATCH_CODE'
MACHINE_ID='$MACHINE_ID'
EOF
        chmod 600 "$INSTALL_DIR/config.env"
        echo "provisioned $(date -u +%Y-%m-%dT%H:%M:%SZ) batch=$BATCH_CODE machine=$MACHINE_ID fp=$HW_FP" > "$INSTALL_DIR/.provisioned"
        echo "[cybercafe] ✅ 批次注册完成（.provisioned 已写入，含硬件指纹 fp=$HW_FP，防止重复注册/支持克隆自愈）"
    fi
    echo "[cybercafe] ✅ 安装完成，服务已启动（开机自启 + 崩溃自动重启 + 云端自更新）"
    echo "[cybercafe] 查看日志: journalctl -u ${SERVICE_NAME} -f"
elif [ "${CYBERCAFE_FROM_PROVISION:-}" = "1" ]; then
    # provision 场景：agent 的 start/restart 被 systemd ordering 排队到 provision 单元结束后执行，
    # 健康检查窗口内可能尚未 active —— 属预期，不阻塞首启（marker 由 provision.sh 写入；agent 随后自动拉起）
    echo "[cybercafe] ⚠️ agent 将在 provision 完成后自动启动（FROM_PROVISION 模式，健康检查放行）" >&2
else
    echo "[cybercafe] ⚠️ 服务未正常启动，请查看: journalctl -u ${SERVICE_NAME} -n 50" >&2
    exit 1
fi
