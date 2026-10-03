#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CyberCafe OCR 服务（RapidOCR / onnxruntime，轻量 CPU 方案）
- 模型随 rapidocr_onnxruntime pip 包内置（det/rec/cls），无需额外下载权重；
  首次运行提取缓存（~/.cache/rapidocr 或工作目录 models/）。
- 使用方式：
  CLI   : ocr-text <图片路径|URL>            → 终端输出识别文字
  HTTP  : ocr-text --serve --port 8820       → POST /ocr 识别
          curl -X POST http://127.0.0.1:8820/ocr -H 'Content-Type: application/json' \
               -d '{"url":"https://example.com/img.png"}'
          curl -X POST http://127.0.0.1:8820/ocr -d '{"image_base64":"<base64>"}'
  GET /health → {"ok":true,"version":...}
- 响应: {"ok":true,"text":"...","lines":[{text,score}...],"elapsed_ms":123}
仅依赖 venv 内 rapidocr_onnxruntime；目标机 Python 3.12。
"""

import base64
import json
import os
import sys
import tempfile
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("OCR_PORT", "8820"))
MAX_BODY = 32 * 1024 * 1024

_engine = None

def get_engine():
    global _engine
    if _engine is None:
        import rapidocr_onnxruntime as rapidocr
        _engine = rapidocr.RapidOCR()
    return _engine

def _fetch_url(url, tmpdir):
    """下载远程图片到临时文件（目标机出网可达；源不可达时报错并给出提示）"""
    path = os.path.join(tmpdir, "ocr_remote.png")
    urllib.request.urlretrieve(url, path)
    return path

def _to_float(v):
    """rapidocr 各版本 score 可能是 float / list / ndarray，统一取数值"""
    try:
        return round(float(v), 3)
    except (TypeError, ValueError):
        try:
            return round(float(v[0][0]), 3)
        except Exception:
            return None

def _norm_result(result):
    """兼容 rapidocr 各版本返回结构：
    A) [boxes, txts, scores]（三个独立列表，新版 1.4.x）
    B) [[box, text, score], ...]（每元素三元组，旧版）
    """
    if not result:
        return []
    if (len(result) == 3 and isinstance(result[1], list) and result[1]
            and all(isinstance(x, str) for x in result[1])):
        # 结构 A
        boxes, txts, scores = result
        lines = []
        for i, txt in enumerate(txts):
            sc = scores[i] if i < len(scores) else None
            lines.append({"text": str(txt), "score": _to_float(sc)})
        return lines
    # 结构 B
    lines = []
    for it in result:
        try:
            lines.append({"text": str(it[1]), "score": _to_float(it[2])})
        except Exception:
            continue
    return lines

def ocr_image(path_or_url):
    """识别单张图片（本地路径或 http(s) URL），返回 (text, lines, elapsed_ms)"""
    tmpdir = tempfile.mkdtemp(prefix="cybercafe-ocr-")
    try:
        if str(path_or_url).startswith(("http://", "https://")):
            path_or_url = _fetch_url(path_or_url, tmpdir)
        if not os.path.exists(path_or_url):
            return f"ERROR: 文件不存在: {path_or_url}", [], 0
        t0 = time.time()
        res = get_engine()(path_or_url)
        elapsed = round((time.time() - t0) * 1000, 1)
    except Exception as e:
        return f"ERROR: {type(e).__name__}: {e}", [], 0
    finally:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
    # 旧版可能返回 (result, elapse) 元组
    if isinstance(res, tuple):
        result = res[0]
    else:
        result = res
    lines = _norm_result(result)
    text = "\n".join(l["text"] for l in lines)
    return text, lines, elapsed

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静默访问日志（systemd journal 已够）
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            try:
                from importlib.metadata import version as _v
                ver = _v("rapidocr_onnxruntime")
            except Exception:
                ver = "unknown"
            self._send(200, {"ok": True, "service": "cybercafe-ocr", "rapidocr": ver})
        else:
            self._send(404, {"ok": False, "error": "not found; try POST /ocr"})

    def do_POST(self):
        if self.path != "/ocr":
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > MAX_BODY:
                return self._send(400, {"ok": False, "error": "bad Content-Length"})
            raw = self.rfile.read(length)
            req = json.loads(raw.decode("utf-8", "replace"))
        except Exception as e:
            return self._send(400, {"ok": False, "error": f"bad request: {e}"})
        src = None
        tmp = tempfile.NamedTemporaryFile(prefix="cybercafe-ocr-body-", suffix=".png", delete=False)
        try:
            if req.get("url"):
                src = req["url"]
            elif req.get("image_base64") or req.get("image"):
                b64 = req.get("image_base64") or req.get("image")
                tmp.write(base64.b64decode(b64))
                tmp.close()
                src = tmp.name
            else:
                return self._send(400, {"ok": False, "error": "需要 url 或 image_base64 字段"})
            text, lines, elapsed = ocr_image(src)
            self._send(200, {"ok": not text.startswith("ERROR:"),
                             "text": text, "lines": lines, "elapsed_ms": elapsed})
        except Exception as e:
            self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})
        finally:
            try:
                os.unlink(tmp.name)
            except Exception:
                pass

def serve():
    srv = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[cybercafe-ocr] HTTP 服务已启动: http://127.0.0.1:{PORT}  (POST /ocr, GET /health)",
          flush=True)
    srv.serve_forever()

def main():
    args = sys.argv[1:]
    if args and args[0] == "--serve":
        serve()
        return
    if not args:
        print(__doc__)
        sys.exit(1)
    text, lines, elapsed = ocr_image(args[0])
    if text.startswith("ERROR:"):
        print(text, file=sys.stderr)
        sys.exit(1)
    print(text)
    if os.environ.get("OCR_VERBOSE"):
        print(f"[elapsed {elapsed}ms, {len(lines)} lines]", file=sys.stderr)

if __name__ == "__main__":
    main()
