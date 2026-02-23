import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const port = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
};

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (!req.url) return send(res, 400, 'Bad request');
  const url = new URL(req.url, `http://localhost:${port}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  if (pathname === '/') pathname = '/index.html';

  const diskPath = path.resolve(rootDir, `.${pathname}`);
  if (!diskPath.startsWith(`${rootDir}${path.sep}`)) return send(res, 403, 'Forbidden');
  fs.stat(diskPath, (err, stats) => {
    if (!err && stats.isFile()) return sendFile(res, diskPath);

    // SPA fallback for permalinks (e.g. /c/CERT-ID/agent-name) and other extensionless routes.
    if (!path.extname(pathname)) return sendFile(res, path.join(rootDir, 'index.html'));

    return send(res, 404, 'Not found');
  });
});

server.listen(port, () => {
  console.log(`[dmv] dev server listening on http://localhost:${port}`);
});
