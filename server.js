const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const SITE_DIR = path.join(ROOT, 'site');
const DATA_DIR = path.join(ROOT, process.env.SITE_DATA_DIR || 'site-data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.ndjson');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream'
  );
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function ensureRuntimeDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(SITE_DIR, { recursive: true });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function safeJoin(baseDir, requestPath) {
  const resolved = path.normalize(path.join(baseDir, requestPath));
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) return null;
  return resolved;
}

async function serveStatic(req, res, pathname) {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const filePath = safeJoin(SITE_DIR, normalized);
  if (!filePath) {
    send(res, 400, 'Bad request');
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html');
      const indexStat = await fsp.stat(indexPath);
      if (indexStat.isFile()) {
        const data = await fsp.readFile(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
        return;
      }
    }

    if (!stat.isFile()) {
      send(res, 404, 'Not found');
      return;
    }

    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(data);
  } catch {
    if (pathname !== '/' && !path.extname(pathname)) {
      return serveStatic(req, res, '/index.html');
    }
    send(res, 404, 'Not found');
  }
}

async function appendSubmission(entry) {
  const line = JSON.stringify(entry) + '\n';
  await fsp.appendFile(SUBMISSIONS_FILE, line, 'utf8');
}

async function handleContact(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const raw = await readBody(req);
  let data = {};
  const contentTypeHeader = (req.headers['content-type'] || '').toLowerCase();
  if (contentTypeHeader.includes('application/json')) {
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
      return;
    }
  } else {
    const params = new URLSearchParams(raw);
    for (const [key, value] of params.entries()) data[key] = value;
  }

  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim();
  const message = String(data.message || '').trim();

  if (!name || !email || !message) {
    sendJson(res, 400, { ok: false, error: 'Name, email, and message are required' });
    return;
  }

  const submission = {
    id: `sub_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    name,
    email,
    message,
    userAgent: req.headers['user-agent'] || '',
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString(),
  };

  try {
    await appendSubmission(submission);
    sendJson(res, 200, { ok: true, message: 'Thanks for reaching out. We received your message.' });
  } catch (error) {
    console.error('Failed to store submission:', error);
    sendJson(res, 500, { ok: false, error: 'Could not save submission' });
  }
}

async function main() {
  await ensureRuntimeDirs();

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'geeknerdz-itwebsite',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (requestUrl.pathname === '/api/contact') {
        await handleContact(req, res);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
      }

      await serveStatic(req, res, requestUrl.pathname);
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Geeknerdz website listening on http://${HOST}:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
