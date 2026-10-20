// docsys 本地预览服务器：静态服务 dist/。用法：node docsys/framework/serve.mjs [port]（默认 8891）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const PORT = Number(process.argv[2]) || 8891
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' }

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(String(req.url || '/').split('?')[0])
  let file = path.join(DIST_DIR, urlPath)
  if (!file.startsWith(DIST_DIR)) { res.writeHead(403); res.end(); return }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(PORT, () => console.log(`docsys 预览：http://127.0.0.1:${PORT}/（先执行 npm run docsys:build）`))
