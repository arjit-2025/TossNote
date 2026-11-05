'use strict';
// Tossnote: a self-hosted, unlimited text & file sharing server.
// Zero runtime dependencies beyond Node.js >= 18.

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_BODY = Number(process.env.MAX_BODY_MB || 100) * 1024 * 1024;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const PASTES = path.join(DATA, 'pastes');
const PUB = path.join(__dirname, 'public');
const NM = path.join(__dirname, 'node_modules');

fs.mkdirSync(PASTES, { recursive: true });

// ---------- helpers ----------
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const SYNTAX_RE = /^[a-z0-9+#._-]{1,30}$/;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no look-alikes

function randomId(len = 8) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(24).toString('base64url');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || !stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Serialize mutations per paste so burn/max-view counting is exact.
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}

// ---------- storage ----------
const recPath = (id) => path.join(PASTES, `${id}.json`);
const filesPath = (id) => path.join(PASTES, `${id}.files.json`);
const isExpired = (r) => r.expiresAt != null && Date.now() >= r.expiresAt;

async function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
async function load(id) {
  if (!ID_RE.test(id)) return null;
  try {
    const r = JSON.parse(await fsp.readFile(recPath(id), 'utf8'));
    if (isExpired(r)) { await remove(id); return null; }
    return r;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function loadFiles(id) {
  try { return JSON.parse(await fsp.readFile(filesPath(id), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
const save = (r) => writeAtomic(recPath(r.id), JSON.stringify(r));
const saveFiles = (id, files) => files.length
  ? writeAtomic(filesPath(id), JSON.stringify(files))
  : fsp.rm(filesPath(id), { force: true });
async function remove(id) {
  await Promise.all([fsp.rm(recPath(id), { force: true }), fsp.rm(filesPath(id), { force: true })]);
  notify(id, 'gone', {});
  for (const [t, v] of viewTokens) if (v.id === id) viewTokens.delete(t);
}

// ---------- live updates (Server-Sent Events) ----------
const subscribers = new Map(); // id -> Set<res>
function notify(id, event, data) {
  const set = subscribers.get(id);
  if (!set) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}

// Viewer tokens let an already-authorized viewer refresh after a live edit
// without re-entering the password or consuming another view.
const viewTokens = new Map(); // token -> { id, exp }
const VIEW_TTL = 24 * 3600 * 1000;

// ---------- validation ----------
function parseExpiry(v) {
  if (v == null || v === '') return 7 * 24 * 60; // default 1 week
  if (v === 'never' || v === 0 || v === '0') return 0;
  if (typeof v === 'number') return v;
  const m = /^(\d+)\s*(m|min|h|d|w|y)?$/i.exec(String(v).trim());
  if (!m) throw new HttpError(400, 'Invalid expiry');
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  return n * ({ m: 1, min: 1, h: 60, d: 1440, w: 10080, y: 525960 })[unit];
}

function buildRecord(input) {
  const content = input.content == null ? '' : input.content;
  if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
  if (content.includes('\0') && !input.encrypted) throw new HttpError(400, 'Text cannot contain NUL characters');
  const files = Array.isArray(input.files) ? input.files : [];
  for (const f of files) {
    if (!f || typeof f.data !== 'string') throw new HttpError(400, 'Each file needs base64 data');
  }
  if (!content.trim() && files.length === 0) throw new HttpError(400, 'Nothing to share');

  const minutes = parseExpiry(input.expiry);
  if (!Number.isFinite(minutes) || minutes < 0) throw new HttpError(400, 'Invalid expiry');
  const title = input.title == null ? '' : String(input.title).slice(0, 200);
  const syntax = input.syntax && SYNTAX_RE.test(input.syntax) ? input.syntax : 'auto';
  let maxViews = null;
  if (input.maxViews != null && input.maxViews !== '') {
    maxViews = Number(input.maxViews);
    if (!Number.isInteger(maxViews) || maxViews < 1) throw new HttpError(400, 'maxViews must be a positive integer');
  }
  const editToken = token();
  const now = Date.now();
  const record = {
    id: null,
    title: input.encrypted ? '' : title,
    content,
    syntax,
    createdAt: now,
    updatedAt: now,
    expiresAt: minutes === 0 ? null : now + minutes * 60000,
    burn: Boolean(input.burn),
    maxViews,
    views: 0,
    encrypted: Boolean(input.encrypted),
    passwordHash: input.password ? hashPassword(String(input.password)) : null,
    editTokenHash: sha256(editToken),
    fileCount: files.length,
    version: 1,
  };
  const cleanFiles = files.map((f) => (record.encrypted
    ? { data: f.data }
    : { name: String(f.name || 'file').slice(0, 255), type: String(f.type || 'application/octet-stream').slice(0, 120), size: Number(f.size) || 0, data: f.data }));
  return { record, files: cleanFiles, editToken };
}

async function createPaste(input) {
  const { record, files, editToken } = buildRecord(input);
  if (input.slug) {
    const slug = String(input.slug).toLowerCase();
    if (!ID_RE.test(slug)) throw new HttpError(400, 'Custom link must be 3-40 lowercase letters, digits or hyphens');
    record.id = slug;
  } else {
    record.id = randomId();
  }
  return withLock(record.id, async () => {
    if (await load(record.id)) {
      if (input.slug) throw new HttpError(409, 'That custom link is taken');
      record.id = randomId(10);
    }
    await saveFiles(record.id, files);
    await save(record);
    return { id: record.id, editToken, expiresAt: record.expiresAt };
  });
}

function publicMeta(r) {
  return {
    id: r.id,
    title: r.passwordHash ? '' : r.title,
    syntax: r.syntax,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
    burn: r.burn,
    maxViews: r.maxViews,
    views: r.views,
    encrypted: r.encrypted,
    needPassword: Boolean(r.passwordHash),
    fileCount: r.fileCount,
    version: r.version,
  };
}

async function openPaste(id, { password, viewToken }) {
  return withLock(id, async () => {
    const r = await load(id);
    if (!r) throw new HttpError(404, 'This note does not exist, has expired, or was already read');
    const vt = viewToken && viewTokens.get(viewToken);
    const refresh = vt && vt.id === id && vt.exp > Date.now();
    if (!refresh) {
      if (r.passwordHash && !verifyPassword(password, r.passwordHash)) {
        throw new HttpError(403, password ? 'Wrong password' : 'Password required');
      }
      r.views += 1;
    }
    const files = r.fileCount ? await loadFiles(id) : [];
    const consumed = r.burn || (r.maxViews != null && r.views >= r.maxViews);
    const out = { ...publicMeta(r), title: r.title, content: r.content, files, consumed };
    if (consumed) {
      await remove(id);
    } else {
      if (!refresh) await save(r);
      const t = refresh ? viewToken : token();
      viewTokens.set(t, { id, exp: Date.now() + VIEW_TTL });
      out.viewToken = t;
    }
    return out;
  });
}

async function requireEditor(id, req) {
  const r = await load(id);
  if (!r) throw new HttpError(404, 'Not found');
  if (!safeEqualHex(sha256(String(req.headers['x-edit-token'] || '')), r.editTokenHash)) {
    throw new HttpError(403, 'Invalid edit token');
  }
  return r;
}

// ---------- HTTP plumbing ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, `Upload is larger than the server limit (${MAX_BODY / 1048576} MB)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0];
  return `${proto}://${req.headers.host}`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const VENDOR = {
  '/vendor/highlight.js': path.join(NM, '@highlightjs/cdn-assets/highlight.min.js'),
  '/vendor/hl-dark.css': path.join(NM, '@highlightjs/cdn-assets/styles/github-dark.min.css'),
  '/vendor/hl-light.css': path.join(NM, '@highlightjs/cdn-assets/styles/github.min.css'),
  '/vendor/qrcode.js': path.join(NM, 'qrcode-generator/qrcode.js'),
};

async function serveFile(res, file, cache = 'no-cache') {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache, ...SECURITY_HEADERS });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  // --- JSON API ---
  if (p === '/api/pastes' && m === 'POST') {
    return send(res, 201, await createPaste(await readJson(req)));
  }
  let mm = /^\/api\/pastes\/([^/]+)(\/open|\/events)?$/.exec(p);
  if (mm) {
    const id = mm[1].toLowerCase();
    const sub = mm[2];
    if (!sub && m === 'GET') {
      const r = await load(id);
      if (!r) throw new HttpError(404, 'This note does not exist, has expired, or was already read');
      return send(res, 200, publicMeta(r));
    }
    if (sub === '/open' && m === 'POST') {
      return send(res, 200, await openPaste(id, await readJson(req)));
    }
    if (sub === '/events' && m === 'GET') {
      if (!(await load(id))) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SECURITY_HEADERS });
      res.write('retry: 3000\n\n');
      if (!subscribers.has(id)) subscribers.set(id, new Set());
      subscribers.get(id).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        const set = subscribers.get(id);
        if (set) { set.delete(res); if (!set.size) subscribers.delete(id); }
      });
      return;
    }
    if (!sub && m === 'PUT') {
      const body = await readJson(req);
      return send(res, 200, await withLock(id, async () => {
        const r = await requireEditor(id, req);
        if (r.burn) throw new HttpError(409, 'Burn-after-reading notes cannot be edited');
        if (typeof body.content !== 'string') throw new HttpError(400, 'content must be a string');
        r.content = body.content;
        if (!r.encrypted && body.title != null) r.title = String(body.title).slice(0, 200);
        if (body.syntax && SYNTAX_RE.test(body.syntax)) r.syntax = body.syntax;
        r.version += 1;
        r.updatedAt = Date.now();
        await save(r);
        notify(id, 'update', { version: r.version });
        return { ok: true, version: r.version };
      }));
    }
    if (!sub && m === 'DELETE') {
      return send(res, 200, await withLock(id, async () => {
        await requireEditor(id, req);
        await remove(id);
        return { ok: true };
      }));
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // --- curl-friendly API ---
  if (p === '/api/raw' && m === 'POST') {
    const body = await readBody(req);
    const q = url.searchParams;
    const out = await createPaste({
      content: body.toString('utf8'),
      title: q.get('title') || '',
      syntax: q.get('syntax') || 'auto',
      expiry: q.get('expiry') || undefined,
      burn: ['1', 'true', 'yes'].includes(q.get('burn') || ''),
      maxViews: q.get('views') || undefined,
      slug: q.get('slug') || undefined,
      password: req.headers['x-password'] || undefined,
    });
    return send(res, 201, `${baseUrl(req)}/${out.id}\n`, 'text/plain; charset=utf-8', { 'X-Edit-Token': out.editToken, 'X-Note-Id': out.id });
  }
  mm = /^\/r\/([^/]+)$/.exec(p);
  if (mm && m === 'GET') {
    const id = mm[1].toLowerCase();
    const r = await load(id);
    if (!r) throw new HttpError(404, 'Not found');
    if (r.encrypted) throw new HttpError(400, 'This note is end-to-end encrypted; open it in a browser with its full link');
    const out = await openPaste(id, { password: req.headers['x-password'] || url.searchParams.get('password') || undefined });
    return send(res, 200, out.content, 'text/plain; charset=utf-8');
  }

  // --- pages & assets ---
  if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  if (p === '/' ) return serveFile(res, path.join(PUB, 'index.html'));
  if (VENDOR[p]) return serveFile(res, VENDOR[p], 'public, max-age=86400');
  if (p.startsWith('/assets/')) {
    const file = path.normalize(path.join(PUB, p));
    if (!file.startsWith(path.join(PUB, 'assets') + path.sep)) throw new HttpError(404, 'Not found');
    return serveFile(res, file);
  }
  if (p === '/favicon.svg' || p === '/manifest.json') return serveFile(res, path.join(PUB, p));
  const idm = /^\/([a-z0-9-]{3,40})$/i.exec(p);
  if (idm) return serveFile(res, path.join(PUB, 'view.html'));
  throw new HttpError(404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) { res.end(); return; }
    const msg = status === 500 ? 'Internal server error' : err.message;
    if ((req.url || '').startsWith('/api/raw') || (req.url || '').startsWith('/r/')) send(res, status, `${msg}\n`, 'text/plain; charset=utf-8');
    else send(res, status, { error: msg });
  });
});

// ---------- expiry sweeper ----------
async function sweep() {
  const now = Date.now();
  for (const [t, v] of viewTokens) if (v.exp <= now) viewTokens.delete(t);
  let names;
  try { names = await fsp.readdir(PASTES); } catch { return; }
  for (const name of names) {
    const full = path.join(PASTES, name);
    if (name.endsWith('.tmp')) {
      const st = await fsp.stat(full).catch(() => null);
      if (st && now - st.mtimeMs > 3600000) await fsp.rm(full, { force: true });
      continue;
    }
    if (!name.endsWith('.json') || name.endsWith('.files.json')) continue;
    const id = name.slice(0, -5);
    await withLock(id, () => load(id)).catch(() => {}); // load() deletes expired notes
  }
}
setInterval(sweep, 60000).unref();

if (require.main === module) {
  sweep();
  server.listen(PORT, HOST, () => console.log(`Tossnote listening on http://${HOST}:${PORT}  (data: ${DATA})`));
}
module.exports = { server };
