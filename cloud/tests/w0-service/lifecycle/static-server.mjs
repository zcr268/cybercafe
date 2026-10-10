// W0 验证辅助：本地静态文件服务器（真实 HTTP，等价生产 compose 的 public/_agent 与 /_repo 只读挂载）
// 用法: node static-server.mjs <根目录> <端口>
// 行为: GET /<相对路径> → 200 text/plain 读盘返回；缺失/目录 → 404；越界（..）→ 403
// 这是真实网络传输的真实外部依赖（loopback HTTP），不是 mock。
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, isAbsolute } from "node:path";

const [dir, port] = process.argv.slice(2);
if (!dir || !port) { console.error("usage: node static-server.mjs <dir> <port>"); process.exit(2); }
const root = normalize(isAbsolute(dir) ? dir : join(process.cwd(), dir));

const server = http.createServer((req, res) => {
  let pathname = "/";
  try { pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname); } catch { /* 保持 / */ }
  const p = normalize(join(root, pathname));
  if (p !== root && !p.startsWith(root + "/")) { res.writeHead(403); res.end("forbidden"); return; }
  stat(p).then((s) => {
    if (s.isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    const rs = createReadStream(p);
    rs.on("error", () => { res.destroy(); });
    rs.pipe(res);
  }).catch(() => { res.writeHead(404); res.end("not found"); });
});

server.listen(Number(port), "127.0.0.1", () => {
  console.log(`static-server ${root} on 127.0.0.1:${port}`);
});