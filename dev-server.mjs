/**
 * 本地预览服务器：模拟 Vercel 的「静态文件 + /api 函数」路由
 * 用途：没有 Vercel 登录态时，本地也能完整跑通页面与接口
 *
 * 启动：npm run dev:local     → http://localhost:3000
 */
import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** 读取请求体并解析 JSON，对齐 Vercel 默认的 bodyParser 行为 */
async function attachBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return;
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try {
      req.body = JSON.parse(raw);
    } catch {
      req.body = raw;
    }
  } else {
    req.body = raw;
  }
}

/** 简易 res.status().json() 辅助，Vercel 也提供同名方法 */
function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

async function serveStatic(req, res, pathname) {
  let filePath = normalize(join(ROOT, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not Found');
  }
}

/** /api/xxx → ./api/xxx.js（与 Vercel 的文件路由保持一致，新增接口无需改这里） */
function loadApi(pathname) {
  const name = pathname.replace(/^\/api\//, '');
  if (!/^[a-z0-9_-]+$/i.test(name)) return null;
  return import(`./api/${name}.js`).then((m) => m.default);
}

const server = http.createServer(async (req, res) => {
  decorate(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  const apiPath = pathname.replace(/\/+$/, '') || '/';
  if (apiPath.startsWith('/api/')) {
    try {
      await attachBody(req);
      const handler = await loadApi(apiPath);
      if (handler) return handler(req, res);
      res.statusCode = 404;
      return res.json({ error: `Not found: ${pathname}` });
    } catch (err) {
      console.error('[dev] api error:', err);
      if (!res.headersSent) res.status(500).json({ error: err?.message || 'server error' });
      else res.end();
      return;
    }
  }

  if (pathname.startsWith('/api/')) {
    res.statusCode = 404;
    return res.json({ error: `Not found: ${pathname}` });
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`\n  ➜ 本地预览:  http://localhost:${PORT}`);
  console.log(`  ➜ 接口地址:  http://localhost:${PORT}/api/name  (POST)\n`);
  const missing = ['DOUBAO_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'KIMI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']
    .filter((k) => !process.env[k]);
  if (missing.length) console.warn(`  ⚠ 缺少环境变量: ${missing.join(', ')} → 相关模型会被标注为未配置\n`);
});
