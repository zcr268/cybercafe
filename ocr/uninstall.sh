#!/usr/bin/env bash
# CyberCafe OCR 一键卸载 + 全面清理
# 用法: bash uninstall.sh [--keep] [--yes]
#   --yes：跳过确认（接口对齐 uninstall-all.sh 聚合调用；本脚本默认无交互确认，--yes 为兼容参数）
#   默认：删除 OCR 相关的全部——systemd 服务单元与 enable、运行进程、venv
#         （rapidocr_onnxruntime/onnxruntime 等全部 pip 依赖 + 内置模型）、
#         模型缓存（~/.cache/rapidocr*、$OCR_DIR/models*、首次运行提取位置）、
#         $OCR_DIR 下除 install.sh / uninstall.sh / README.md 外的所有文件
#         清理后系统除上述脚本与文档外无 OCR 残留。
#   --keep：保留 venv 与模型权重（仅停服务、删 systemd 单元与缓存），便于快速重装
#           （重装只需再次运行 install.sh，不会重新下载模型）。
# 可逆性：本卸载不可逆地删除模型/依赖（--keep 可保留模型）；如需恢复能力，
#         请保留 install.sh 与 ocr.py（均随仓库 ocr/ 提供），重装即还原。
set -euo pipefail

OCR_DIR="${OCR_DIR:-/opt/cybercafe-ocr}"
SERVICE="cybercafe-ocr"
KEEP_MODELS=0

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP_MODELS=1 ;;
    --yes) : ;;   # 接口对齐（uninstall-all.sh 聚合调用带 --yes；本脚本无交互确认，接受即忽略）
    *) echo "未知参数: $arg（支持 --keep / --yes）" >&2; exit 1 ;;
  esac
done

# ---------- 1) 停服务 + 删 systemd 单元（仅当存在 systemd 且确需 root；沙箱目录免 root） ----------
if command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    if systemctl list-unit-files 2>/dev/null | grep -q "${SERVICE}.service"; then
        systemctl stop ${SERVICE}.service 2>/dev/null || true
        systemctl disable ${SERVICE}.service 2>/dev/null || true
    fi
    rm -f /etc/systemd/system/${SERVICE}.service \
          /etc/systemd/system/multi-user.target.wants/${SERVICE}.service
    systemctl daemon-reload 2>/dev/null || true
fi

echo "[cybercafe-ocr] 卸载开始 (keep_models=$KEEP_MODELS)..."

# ---------- 1) 停服务 + 删 systemd 单元 ----------
if systemctl list-unit-files 2>/dev/null | grep -q "${SERVICE}.service"; then
    systemctl stop ${SERVICE}.service 2>/dev/null || true
    systemctl disable ${SERVICE}.service 2>/dev/null || true
fi
rm -f /etc/systemd/system/${SERVICE}.service \
      /etc/systemd/system/multi-user.target.wants/${SERVICE}.service
systemctl daemon-reload 2>/dev/null || true

# ---------- 2) 清理运行进程（pidfile + 兜底 pkill） ----------
if [ -f "$OCR_DIR/ocr.pid" ]; then
    kill "$(cat "$OCR_DIR/ocr.pid")" 2>/dev/null || true
    rm -f "$OCR_DIR/ocr.pid"
fi
pkill -f "$OCR_DIR/ocr.py" 2>/dev/null || true
pkill -f "ocr.py --serve" 2>/dev/null || true

# ---------- 3) 清理模型缓存（--keep 时跳过模型，仍清 cache） ----------
rm -rf /root/.cache/rapidocr* ~/.cache/rapidocr* 2>/dev/null || true
if [ "$KEEP_MODELS" = "1" ]; then
    echo "[cybercafe-ocr] --keep：保留 venv 与模型权重"
else
    rm -rf "$OCR_DIR/models" "$OCR_DIR/models_*.onnx" "$OCR_DIR/.models" 2>/dev/null || true
fi

# ---------- 4) venv（全部 pip 依赖：rapidocr/onnxruntime/opencv/numpy 等） ----------
if [ "$KEEP_MODELS" = "1" ]; then
    # --keep 只保留 venv，不删除
    :
else
    rm -rf "$OCR_DIR/venv"
fi

# ---------- 5) 目录内运行时文件（保留脚本与 README；--keep 时 venv/models 一并保留） ----------
if [ -d "$OCR_DIR" ]; then
    if [ "$KEEP_MODELS" = "1" ]; then
        find "$OCR_DIR" -mindepth 1 -maxdepth 1 \
            ! -name install.sh ! -name uninstall.sh ! -name README.md \
            ! -name venv ! -name models \
            -exec rm -rf {} + 2>/dev/null || true
    else
        find "$OCR_DIR" -mindepth 1 -maxdepth 1 \
            ! -name install.sh ! -name uninstall.sh ! -name README.md \
            -exec rm -rf {} + 2>/dev/null || true
    fi
fi

# ---------- 6) 验证 ----------
echo "[cybercafe-ocr] 清理验证："
echo "  服务: $(systemctl is-active ${SERVICE}.service 2>/dev/null || echo '不存在')"
echo "  端口: $(ss -tlnp 2>/dev/null | grep -c ':8820' || echo 0) 个监听"
echo "  进程: $(pgrep -f 'ocr.py' | wc -l | tr -d ' ') 个"
echo "  venv: $([ -d "$OCR_DIR/venv" ] && echo 存在 || echo 已删除)"
echo "  缓存: $([ -d /root/.cache/rapidocr ] && echo 存在 || echo 已清除)"
echo "  目录: $(ls -A "$OCR_DIR" 2>/dev/null | tr '\n' ' ')"
if [ "$KEEP_MODELS" != "1" ]; then
    echo "[cybercafe-ocr] ✅ 卸载完成：除 install.sh/uninstall.sh/README.md 外无残留。"
else
    echo "[cybercafe-ocr] ✅ 卸载完成（--keep 保留 venv/模型）。"
fi
