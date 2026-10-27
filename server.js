// Local / Docker runner only. On Vercel, public/ is served statically and api/game.js runs as a function.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/game.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/game')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      req.body = body ? JSON.parse(body) : {};
    } catch {
      req.body = '{';
    }
    const shim = {
      setHeader(name, value) { res.setHeader(name, value); },
      status(code) { res.statusCode = code; return shim; },
      json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); },
    };
    return handler(req, shim);
  }
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('Not Found');
  }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache'); // local runs: always check for a fresh copy
  return fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 8080, () => console.log('GrowX cards on http://localhost:' + (process.env.PORT || 8080)));
