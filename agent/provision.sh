#!/usr/bin/env bash
# Version: 1.0.2
# CyberCafe 首启 provision + 克隆自愈（由 cybercafe-provision.service 每次开机触发）
# 流程：
#   0) 解析批次码 / API 地址（本地，不联网）
#   1) F·自更新：拉云端最新 provision.sh，不同则替换自身并 exec 新副本（哨兵防递归；失败 fail-open）
#   2) G·单元自更新：拉云端最新 cybercafe-provision.service，不同则写入 + daemon-reload
#   3) 硬件指纹：物理网卡 MAC 排序 → sha256 前 12 位；无物理口回退 sha256(machine-id)
#   4) marker 判定：
#      · 存在且 fp 相同        → 直接 exit 0（不重新领码、不消耗配额）
#      · 存在但 fp 不同        → 克隆自愈：重新领码（hardware_id=新指纹）→ 重写 config.env
#                               → H·install.sh 总取云端最新 → 装机 → 写新 marker
#      · 存在但 legacy（无fp=）→ 视为同机补写 fp，不重新领码
#      · 不存在                → 首启：领码 → config.env → install.sh → 写 marker
#   5) 领码失败重试 3 次（间隔 5/15/30s）；仍失败 exit 非 0（单元保持 enabled 下次开机重试；
#      单元为软依赖，不阻塞 agent 启动）
set -euo pipefail

INSTALL_DIR="/opt/cybercafe"
MARKER="$INSTALL_DIR/.provisioned"
UNIT_PATH="/etc/systemd/system/cybercafe-provision.service"
log() { echo "[cybercafe-provision] $*"; }

# ---------- 硬件指纹（install.sh 与 provision.sh 各一份、必须逐字相同；t39 三级回退） ----------
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

if [ "$(id -u)" != "0" ]; then log "ERROR: 需要 root" >&2; exit 1; fi

# ---------- 0) 批次码 / API 地址（本地解析；config.env 供克隆自愈沿用原 API/批次） ----------
BATCH_CODE="${PROVISION_CODE:-}"
if [ -f /etc/cybercafe/batch.code ] && [ -z "$BATCH_CODE" ]; then BATCH_CODE="$(head -1 /etc/cybercafe/batch.code)"; fi
if [ -f "$INSTALL_DIR/batch.code" ] && [ -z "$BATCH_CODE" ]; then BATCH_CODE="$(head -1 "$INSTALL_DIR/batch.code")"; fi
API_BASE="${PROVISION_API_BASE:-}"
if [ -f /etc/cybercafe/api_base ] && [ -z "$API_BASE" ]; then API_BASE="$(head -1 /etc/cybercafe/api_base)"; fi
if [ -f "$INSTALL_DIR/api_base" ] && [ -z "$API_BASE" ]; then API_BASE="$(head -1 "$INSTALL_DIR/api_base")"; fi
if [ -f "$INSTALL_DIR/config.env" ]; then
  [ -z "$BATCH_CODE" ] && BATCH_CODE="$(grep -o "^BATCH_CODE='[^']*'" "$INSTALL_DIR/config.env" 2>/dev/null | head -1 | cut -d"'" -f2 || true)"
  [ -z "$API_BASE" ] && API_BASE="$(grep -o "^API_BASE='[^']*'" "$INSTALL_DIR/config.env" 2>/dev/null | head -1 | cut -d"'" -f2 || true)"
fi
if [ $# -ge 1 ] && [ -n "${1:-}" ]; then BATCH_CODE="$1"; fi
if [ -z "$BATCH_CODE" ]; then log "ERROR: 批次码未配置（PROVISION_CODE / /etc/cybercafe/batch.code / config.env）" >&2; exit 1; fi
if [ -z "$API_BASE" ]; then log "ERROR: API 地址未配置（PROVISION_API_BASE / /etc/cybercafe/api_base / config.env）" >&2; exit 1; fi

# ---------- 武装/熄火：批次/镜像机才启用更新通道；self_update=off 时全部休眠 ----------
SELF_UPDATE_OFF=0
[ -f /etc/cybercafe/self_update ] && [ "$(head -1 /etc/cybercafe/self_update 2>/dev/null)" = "off" ] && SELF_UPDATE_OFF=1
[ "$SELF_UPDATE_OFF" = "1" ] && log "自更新熄火开关（/etc/cybercafe/self_update=off）已生效，跳过 F/G/H 通道"

# ---------- 1) F·provision.sh 自更新（旧镜像固化副本 → 云端最新；哨兵防递归；失败 fail-open） ----------
SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "$0")"
if [ "$SELF_UPDATE_OFF" != "1" ] && [ "${CYBERCAFE_PROV_REEXEC:-}" != "1" ]; then
  LATEST="$(curl -fsSL --max-time 30 "$API_BASE/install-extra?name=provision.sh" 2>/dev/null || true)"
  if [ -n "$LATEST" ]; then
    if ! printf '%s' "$LATEST" | cmp -s - "$SELF" 2>/dev/null; then
      if tmp="$(mktemp "$SELF.XXXXXX")" && printf '%s' "$LATEST" > "$tmp" && chmod 755 "$tmp" && mv -f "$tmp" "$SELF"; then
        log "自更新：本脚本已升级为云端最新版，用新版本重跑"
        CYBERCAFE_PROV_REEXEC=1 exec bash "$SELF" "$@"
      else
        log "WARN: 自更新原子替换失败，继续使用本地副本（fail-open）"
      fi
    fi
  else
    log "WARN: 拉取云端 provision.sh 失败，使用本地副本继续（fail-open）"
  fi
fi

# ---------- 2) G·首启单元自更新（旧镜像甩掉 ConditionPathExists 的唯一途径；失败 fail-open） ----------
if [ "$SELF_UPDATE_OFF" = "1" ]; then
  LATEST_UNIT=""
else
  LATEST_UNIT="$(curl -fsSL --max-time 30 "$API_BASE/install-extra?name=cybercafe-provision.service" 2>/dev/null || true)"
fi
if [ -n "$LATEST_UNIT" ]; then
  if [ ! -f "$UNIT_PATH" ] || ! printf '%s' "$LATEST_UNIT" | cmp -s - "$UNIT_PATH" 2>/dev/null; then
    if printf '%s' "$LATEST_UNIT" > "$UNIT_PATH.tmp" 2>/dev/null && mv -f "$UNIT_PATH.tmp" "$UNIT_PATH"; then
      systemctl daemon-reload 2>/dev/null || true
      systemctl enable cybercafe-provision.service >/dev/null 2>&1 || true
      log "首启单元已更新（$UNIT_PATH）"
    else
      log "WARN: 单元原子替换失败，继续使用现有单元（fail-open）"
    fi
  fi
else
  log "WARN: 拉取云端单元失败，使用本地/现有单元（fail-open）"
fi
mkdir -p "$INSTALL_DIR"

# ---------- 3) 硬件指纹 ----------
read HW_FP FP_SOURCE <<< "$(hw_fingerprint)"
FP_SOURCE="${FP_SOURCE:-gpu}"
log "硬件指纹: $HW_FP（来源: ${FP_SOURCE}）"

# ---------- 4) marker 判定 ----------
MARKER_FP=""; MARKER_BATCH=""
if [ -f "$MARKER" ]; then
  MARKER_FP="$(grep -o 'fp=[0-9a-f]\+' "$MARKER" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  MARKER_BATCH="$(grep -o 'batch=[^ ]\+' "$MARKER" 2>/dev/null | head -1 | cut -d= -f2 || true)"
fi

MODE="first"
if [ -f "$MARKER" ]; then
  if [ -n "$MARKER_FP" ]; then
    if [ "$MARKER_FP" = "$HW_FP" ]; then
      log "指纹一致（$HW_FP），已 provision，跳过（幂等，不联网）"
      exit 0
    fi
    log "指纹变化（marker=$MARKER_FP → 本机=$HW_FP）：克隆自愈"
    MODE="heal"
  else
    log "legacy marker（无 fp=）：视为同机，补写指纹，不重新领码"
    sed -i -E "s/[[:space:]]*$/ fp=$HW_FP/" "$MARKER"
    exit 0
  fi
fi
if [ "$MODE" = "heal" ] && [ -n "$MARKER_BATCH" ]; then
  BATCH_CODE="$MARKER_BATCH"
  log "沿用模板批次: $BATCH_CODE"
fi

# ---------- 5) 领码（hardware_id=<指纹>；云端 prov:hw 去重；重试 3 次 5/15/30s） ----------
MACHINE_ID="$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || echo "unknown-$(hostname)")"
provision_once() {
  curl -sS --max-time 60 -X POST "$API_BASE/api/device/provision" \
    -H "Content-Type: application/json" \
    -d "{\"batch_code\":\"$BATCH_CODE\",\"machine_id\":\"$MACHINE_ID\",\"hardware_id\":\"$HW_FP\",\"hw_source\":\"$FP_SOURCE\",\"device\":{\"hostname\":\"$(hostname | tr -d '"')\",\"os\":\"$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' | head -1)\"}}" 2>/dev/null || true
}
PROV_JSON=""; DEVICE_KEY=""
for i in 1 2 3; do
  log "向云端领码（$i/3, batch=$BATCH_CODE, fp=$HW_FP）..."
  PROV_JSON="$(provision_once)"
  if [ -n "$PROV_JSON" ] && command -v python3 >/dev/null 2>&1; then
    DEVICE_KEY="$(echo "$PROV_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("device_key",""))' 2>/dev/null || true)"
  else
    DEVICE_KEY="$(echo "$PROV_JSON" | grep -o '"device_key":"[^"]*"' 2>/dev/null | head -1 | cut -d'"' -f4 || true)"
  fi
  if [ -n "$DEVICE_KEY" ]; then break; fi
  log "WARN: 领码失败（第 $i 次）: $PROV_JSON"
  if [ "$i" -lt 3 ]; then
    if [ "$i" = 1 ]; then sleep 5; else sleep 15; fi
  fi
done
if [ -z "$DEVICE_KEY" ]; then
  log "ERROR: 领码失败（重试 3 次后仍失败）。单元保持 enabled，下次开机重试；不阻塞 agent 启动" >&2
  exit 1
fi
if command -v python3 >/dev/null 2>&1; then
  RESP_API="$(echo "$PROV_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_base",""))' 2>/dev/null || true)"
else
  RESP_API="$(echo "$PROV_JSON" | grep -o '"api_base":"[^"]*"' 2>/dev/null | head -1 | cut -d'"' -f4 || true)"
fi
[ -n "$RESP_API" ] && API_BASE="$RESP_API"

# ---------- 6) 重写配置（新 key；克隆自愈场景为新指纹对应 key） ----------
cat > "$INSTALL_DIR/config.env" << EOF
API_BASE='$API_BASE'
DEVICE_KEY='$DEVICE_KEY'
BATCH_CODE='$BATCH_CODE'
MACHINE_ID='$MACHINE_ID'
EOF
chmod 600 "$INSTALL_DIR/config.env"
log "已写入 $INSTALL_DIR/config.env（API_BASE + DEVICE_KEY）"

# ---------- 7) H·install.sh 总取云端最新（镜像固化副本不追新；失败回退本地副本；熄火时只用本地） ----------
if [ "$SELF_UPDATE_OFF" = "1" ]; then
  log "熄火模式：使用本地 install.sh（若存在）"
fi
if [ "$SELF_UPDATE_OFF" != "1" ] && curl -fsSL --max-time 60 "$API_BASE/install.sh?key=$DEVICE_KEY" -o "$INSTALL_DIR/install.sh" 2>/dev/null; then
  log "install.sh 已从云端更新（注入新 key）"
else
  if [ "$SELF_UPDATE_OFF" != "1" ]; then log "WARN: 云端 install.sh 拉取失败，回退本地副本（fail-open）"; fi
  if [ ! -f "$INSTALL_DIR/install.sh" ]; then
    log "ERROR: 本地 install.sh 也不存在" >&2
    exit 1
  fi
fi
chmod +x "$INSTALL_DIR/install.sh"

# ---------- 8) 装机（install.sh --batch 读 config.env，跳过重复领码）
# CYBERCAFE_FROM_PROVISION=1：让 install.sh 以 --no-block 启动/重启 agent，
# 避免「provision 单元正在运行 ↔ agent 单元 After=provision」的 systemd 同步死锁 ----------
CYBERCAFE_FROM_PROVISION=1 bash "$INSTALL_DIR/install.sh" --batch "$BATCH_CODE"

# ---------- 9) 新 marker（含指纹与来源；clone 场景为新指纹） ----------
echo "provisioned $(date -u +%Y-%m-%dT%H:%M:%SZ) batch=$BATCH_CODE machine=$MACHINE_ID fp=$HW_FP" > "$MARKER"
log "✅ 首启/克隆自愈完成（mode=$MODE, batch=$BATCH_CODE, fp=$HW_FP, device_key=$DEVICE_KEY）"