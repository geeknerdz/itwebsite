const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const SITE_DIR = path.join(ROOT, 'site');
const DATA_DIR = path.join(ROOT, process.env.SITE_DATA_DIR || 'site-data');
const CONTACT_DB_PATH = path.join(DATA_DIR, process.env.CONTACT_DB_FILE || 'contact-submissions.sqlite3');
const LEGACY_SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.ndjson');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const CONTACT_TO_EMAIL = process.env.CONTACT_TO_EMAIL || 'info@geeknerdz.com';
const CONTACT_FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || 'info@geeknerdz.com';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number.parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

let smtpTransporter;
let contactDb;

function cleanHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSmtpTransporter() {
  if (smtpTransporter) return smtpTransporter;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    requireTLS: true,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
    tls: {
      servername: SMTP_HOST,
      minVersion: 'TLSv1.2',
    },
  });

  return smtpTransporter;
}

function getContactDb() {
  if (contactDb) return contactDb;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  contactDb = new Database(CONTACT_DB_PATH);
  contactDb.pragma('journal_mode = WAL');
  contactDb.pragma('foreign_keys = ON');
  contactDb.exec(`
    CREATE TABLE IF NOT EXISTS contact_submissions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      message TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      delivery_status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_contact_submissions_created_at
      ON contact_submissions(created_at DESC);
  `);

  return contactDb;
}

function importLegacySubmissions(db) {
  if (db.prepare('SELECT COUNT(*) AS count FROM contact_submissions').get().count > 0) {
    return 0;
  }

  if (!fs.existsSync(LEGACY_SUBMISSIONS_FILE)) return 0;

  const raw = fs.readFileSync(LEGACY_SUBMISSIONS_FILE, 'utf8').trim();
  if (!raw) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO contact_submissions
      (id, created_at, name, email, message, user_agent, ip, delivery_status)
    VALUES
      (@id, @createdAt, @name, @email, @message, @userAgent, @ip, @deliveryStatus)
  `);

  const insertMany = db.transaction((records) => {
    let count = 0;
    for (const record of records) {
      insert.run(record);
      count += 1;
    }
    return count;
  });

  const records = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((record) => ({
      ...record,
      deliveryStatus: record.deliveryStatus || 'stored-only',
    }));

  return insertMany(records);
}

function saveSubmissionToDb(submission) {
  const db = getContactDb();
  const stmt = db.prepare(`
    INSERT INTO contact_submissions
      (id, created_at, name, email, message, user_agent, ip, delivery_status)
    VALUES
      (@id, @createdAt, @name, @email, @message, @userAgent, @ip, @deliveryStatus)
  `);

  stmt.run(submission);
}

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

async function sendContactEmail(submission) {
  const transporter = getSmtpTransporter();
  if (!transporter) {
    throw new Error('SMTP is not configured');
  }

  const subjectName = cleanHeader(submission.name) || 'Website visitor';
  const subject = `[Geeknerdz Contact] ${subjectName}`;
  const plainText = [
    'New website contact form submission',
    '',
    `Name: ${submission.name}`,
    `Email: ${submission.email}`,
    '',
    'Message:',
    submission.message,
    '',
    `Submitted at: ${submission.createdAt}`,
    `Submission ID: ${submission.id}`,
  ].join('\n');

  const html = `
    <h2>New website contact form submission</h2>
    <p><strong>Name:</strong> ${escapeHtml(submission.name)}</p>
    <p><strong>Email:</strong> ${escapeHtml(submission.email)}</p>
    <p><strong>Submitted at:</strong> ${escapeHtml(submission.createdAt)}</p>
    <p><strong>Submission ID:</strong> ${escapeHtml(submission.id)}</p>
    <h3>Message</h3>
    <pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(submission.message)}</pre>
  `;

  await transporter.sendMail({
    from: `Geeknerdz Website <${CONTACT_FROM_EMAIL}>`,
    to: CONTACT_TO_EMAIL,
    replyTo: cleanHeader(submission.email),
    subject,
    text: plainText,
    html,
  });
}

async function sendAutoReplyEmail(submission) {
  const transporter = getSmtpTransporter();
  if (!transporter) {
    throw new Error('SMTP is not configured');
  }

  const subject = 'We have received your message';
  const bodyLines = [
    `Hello ${submission.name},`,
    '',
    'Thank you for contacting Geeknerdz. We have received your message and appreciate the opportunity to assist you.',
    'A member of our team will review your inquiry and respond within 24 to 48 hours.',
    '',
    'If your request is time-sensitive, please reply to this email with any additional details so we can prioritize it appropriately.',
    '',
    'Best regards,',
    'Administrator',
    'Geeknerdz',
  ];
  const plainText = bodyLines.join('\n');
  const html = `
    <p>Hello ${escapeHtml(submission.name)},</p>
    <p>Thank you for contacting Geeknerdz. We have received your message and appreciate the opportunity to assist you.</p>
    <p>A member of our team will review your inquiry and respond within <strong>24 to 48 hours</strong>.</p>
    <p>If your request is time-sensitive, please reply to this email with any additional details so we can prioritize it appropriately.</p>
    <p>Best regards,<br>
    <strong>Administrator</strong><br>
    Geeknerdz</p>
  `;

  await transporter.sendMail({
    from: `Geeknerdz Support <${CONTACT_FROM_EMAIL}>`,
    to: cleanHeader(submission.email),
    replyTo: CONTACT_TO_EMAIL,
    subject,
    text: plainText,
    html,
  });
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
    deliveryStatus: 'pending',
  };

  try {
    await sendContactEmail(submission);
    submission.deliveryStatus = 'emailed';

    try {
      await sendAutoReplyEmail(submission);
    } catch (error) {
      console.error('Failed to send auto-reply email:', error);
    }
  } catch (error) {
    submission.deliveryStatus = 'stored-only';
    console.error('Failed to deliver contact email:', error);
  }

  try {
    saveSubmissionToDb(submission);
  } catch (error) {
    console.error('Failed to store submission:', error);
    sendJson(res, 500, { ok: false, error: 'Could not save submission' });
    return;
  }

  if (submission.deliveryStatus === 'emailed') {
    sendJson(res, 200, { ok: true, message: 'Thanks for reaching out. We received your message and emailed it to the team.' });
    return;
  }

  sendJson(res, 202, { ok: true, message: 'Thanks for reaching out. We received your message and will review it shortly.' });
}

async function main() {
  await ensureRuntimeDirs();
  const imported = importLegacySubmissions(getContactDb());
  if (imported > 0) {
    console.log(`Imported ${imported} legacy contact submissions into SQLite.`);
  }

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
