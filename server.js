'use strict';

/**
 * FreshCatch — server entry.
 * Static dashboard + JSON API + live SSE scan progress + daily scheduler.
 * Zero framework: Node built-ins only (plus optional @libsql/client in cloud mode).
 *
 * Start:            npm start        → http://127.0.0.1:8787
 * One-off scan:     npm run scan     (runs a scan, prints summary, exits)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./lib/db');
const { runScan, activeHubs } = require('./lib/scan');
const ai = require('./lib/ai');
const telegram = require('./lib/telegram');
const autocomplete = require('./lib/sources/autocomplete');
const redditSrc = require('./lib/sources/reddit');
const newsSrc = require('./lib/sources/news');
const githubSrc = require('./lib/sources/github');
const hnSrc = require('./lib/sources/hn');
const trendsSrc = require('./lib/sources/trends');

// Minimal .env loader — keeps keys out of the repo while local runs pick them up.
try {
  const envRaw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envRaw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
} catch {}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const DASH_USERNAME = process.env.DASH_USERNAME || '';
const DASH_PASSWORD = process.env.DASH_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const LOGIN_ENABLED = !!(DASH_USERNAME && DASH_PASSWORD);
const AUTH_REQUIRED = LOGIN_ENABLED || !!ACCESS_CODE;
const SESSION_COOKIE = 'fc_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCAN_HOUR = Number.isFinite(Number(process.env.SCAN_HOUR)) ? Number(process.env.SCAN_HOUR) : 8;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ------------------------------ helpers ------------------------------ */

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ------------------------------ auth ------------------------------ */

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sessionSecret() {
  if (SESSION_SECRET) return SESSION_SECRET;
  return crypto.createHash('sha256').update(`freshcatch|${DASH_USERNAME}|${DASH_PASSWORD}|${ACCESS_CODE}`).digest('hex');
}

function signPayload(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

function issueSession(user) {
  const payload = `${Date.now() + SESSION_TTL_MS}.${Buffer.from(String(user)).toString('base64url')}`;
  return `${payload}.${signPayload(payload)}`;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function readSession(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const given = Buffer.from(parts[2]);
  const expected = Buffer.from(signPayload(payload));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  try {
    return { user: Buffer.from(parts[1], 'base64url').toString() || 'user', exp };
  } catch {
    return null;
  }
}

function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, token) {
  res.setHeader(
    'Set-Cookie',
    [
      `${SESSION_COOKIE}=${token}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      isHttps(req) ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ')
  );
}

function clearSessionCookie(req, res) {
  res.setHeader(
    'Set-Cookie',
    [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0', isHttps(req) ? 'Secure' : '']
      .filter(Boolean)
      .join('; ')
  );
}

function authorized(req, url) {
  if (!AUTH_REQUIRED) return true;
  if (readSession(req)) return true;
  if (!ACCESS_CODE) return false;
  const header = req.headers['x-access-code'] || '';
  const queryCode = url.searchParams.get('code') || '';
  return timingSafeEqualStr(header, ACCESS_CODE) || timingSafeEqualStr(queryCode, ACCESS_CODE);
}

function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (rec.resetAt < Date.now()) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else rec.count += 1;
}

function handleAuthInfo(req, res) {
  const session = readSession(req);
  sendJSON(res, 200, {
    required: AUTH_REQUIRED,
    mode: LOGIN_ENABLED ? 'password' : ACCESS_CODE ? 'code' : 'open',
    user: session ? session.user : null,
    signedIn: !!session,
  });
}

async function handleLogin(req, res) {
  if (!AUTH_REQUIRED) return sendJSON(res, 200, { ok: true, user: 'open' });
  const ip = req.socket.remoteAddress || 'unknown';
  if (loginBlocked(ip)) {
    return sendJSON(res, 429, { error: 'Too many attempts — wait a few minutes and try again.' });
  }
  const body = await readBody(req);
  let user = null;
  if (
    LOGIN_ENABLED &&
    timingSafeEqualStr(body.username || '', DASH_USERNAME) &&
    timingSafeEqualStr(body.password || '', DASH_PASSWORD)
  ) {
    user = DASH_USERNAME;
  } else if (ACCESS_CODE && timingSafeEqualStr(body.code || body.password || '', ACCESS_CODE)) {
    user = 'access';
  }
  if (!user) {
    recordFailedLogin(ip);
    return sendJSON(res, 401, { error: 'Wrong username or password.' });
  }
  loginAttempts.delete(ip);
  setSessionCookie(req, res, issueSession(user));
  sendJSON(res, 200, { ok: true, user });
}

function handleLogout(req, res) {
  clearSessionCookie(req, res);
  sendJSON(res, 200, { ok: true });
}

/* ------------------------------ API routes ------------------------------ */

async function handleState(req, res) {
  const hubs = await activeHubs();
  const lastScans = await db
    .query('SELECT * FROM scans ORDER BY id DESC LIMIT 5')
    .catch(() => []);
  const counts = await db
    .query('SELECT COUNT(*) AS n FROM keywords')
    .catch(() => [{ n: 0 }]);
  sendJSON(res, 200, {
    name: 'FreshCatch',
    version: '1.0.0',
    dbMode: db.mode,
    telegram: telegram.configured(),
    ai: ai.configured(),
    accessProtected: AUTH_REQUIRED,
    authMode: LOGIN_ENABLED ? 'password' : ACCESS_CODE ? 'code' : 'open',
    user: (readSession(req) || {}).user || null,
    scanHour: SCAN_HOUR,
    publicUrl: process.env.PUBLIC_URL || null,
    hubs: hubs.map((h) => ({ id: h.id, label: h.label, custom: !h.builtin })),
    lastScans,
    keywordCount: Number(counts[0]?.n || 0),
  });
}

function keywordWhere(url) {
  const params = [];
  const clauses = [];
  const hub = url.searchParams.get('hub');
  if (hub && hub !== 'all') {
    clauses.push('hub = ?');
    params.push(hub);
  }
  const tier = url.searchParams.get('tier');
  if (tier && tier !== 'all') {
    clauses.push('tier = ?');
    params.push(tier);
  }
  const verdict = url.searchParams.get('verdict');
  if (verdict && verdict !== 'all') {
    clauses.push('verdict = ?');
    params.push(verdict);
  }
  const q = url.searchParams.get('q');
  if (q) {
    clauses.push('keyword LIKE ?');
    params.push(`%${q.replace(/[%_]/g, '')}%`);
  }
  const since = Number(url.searchParams.get('since'));
  if (Number.isFinite(since) && since > 0) {
    clauses.push('first_seen_at >= ?');
    params.push(since);
  }
  if (url.searchParams.get('starred') === '1') {
    clauses.push('starred = 1');
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

async function handleKeywords(res, url) {
  const { where, params } = keywordWhere(url);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
  const rows = await db.query(
    `SELECT hub, entity, keyword, tier, opportunity, demand, freshness, saturation, verdict,
            intent_posts, mentions, news_count, engines, sources, starred, first_seen_at, last_scan_at
     FROM keywords ${where} ORDER BY opportunity DESC, first_seen_at DESC LIMIT ${limit}`,
    params
  );
  const totals = await db
    .query(`SELECT COUNT(*) AS n FROM keywords ${where}`, params)
    .catch(() => []);
  sendJSON(res, 200, { rows, total: totals.length ? Number(totals[0].n) : rows.length });
}

async function handleExportCSV(res, url) {
  const { where, params } = keywordWhere(url);
  const rows = await db.query(
    `SELECT keyword, hub, entity, tier, verdict, opportunity, demand, freshness, saturation,
            intent_posts, mentions, news_count, engines, sources, starred, first_seen_at
     FROM keywords ${where} ORDER BY opportunity DESC LIMIT 1000`,
    params
  );
  const cols = [
    'keyword', 'hub', 'entity', 'tier', 'verdict', 'opportunity', 'demand', 'freshness',
    'saturation', 'intent_posts', 'mentions', 'news_count', 'engines', 'sources', 'starred', 'first_seen_at',
  ];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [
    cols.join(','),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(',')),
  ].join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="freshcatch-keywords.csv"',
  });
  res.end(csv);
}

async function handleStar(req, res) {
  const body = await readBody(req);
  const keyword = String(body.keyword || '').slice(0, 100);
  const hub = String(body.hub || '').slice(0, 50);
  const value = body.value ? 1 : 0;
  if (!keyword || !hub) return sendJSON(res, 400, { error: 'keyword and hub required' });
  await db.run('UPDATE keywords SET starred = ? WHERE hub = ? AND keyword = ?', [value, hub, keyword]);
  sendJSON(res, 200, { ok: true });
}

async function handleHubs(req, res) {
  const body = await readBody(req);

  if (body.remove) {
    const rows = await db.query('SELECT value FROM settings WHERE key = ?', ['custom_hubs']);
    const custom = rows.length ? JSON.parse(rows[0].value) : [];
    const next = custom.filter((h) => h.id !== String(body.remove));
    await db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['custom_hubs', JSON.stringify(next)]
    );
    return sendJSON(res, 200, { ok: true, hubs: await activeHubs() });
  }

  const label = String(body.label || '').trim().slice(0, 60);
  const subreddits = String(body.subreddits || '')
    .split(',')
    .map((s) => s.trim().replace(/^\/?r\//i, ''))
    .filter(Boolean)
    .slice(0, 6);
  const searchPhrases = String(body.searchPhrases || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!label || !subreddits.length) {
    return sendJSON(res, 400, { error: 'label and at least one subreddit required' });
  }
  const id = 'custom-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const rows = await db.query('SELECT value FROM settings WHERE key = ?', ['custom_hubs']);
  const custom = rows.length ? JSON.parse(rows[0].value) : [];
  custom.push({
    id,
    label,
    subreddits,
    searchPhrases: searchPhrases.length ? searchPhrases : [label.toLowerCase()],
    githubTopics: [],
    verbs: ['setup', 'custom', 'help', 'integration', 'template', 'fix'],
  });
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['custom_hubs', JSON.stringify(custom)]
  );
  sendJSON(res, 200, { ok: true, hubs: await activeHubs() });
}

async function handleSourcesHealth(res) {
  const settled = await Promise.allSettled([
    redditSrc.subredditTop('test', 'week'),
    newsSrc.buzz('freelance'),
    githubSrc.searchRepos('topic:javascript stars:>1000'),
    hnSrc.searchByDate('ai', 1),
    trendsSrc.daily(),
  ]);
  const ids = ['reddit', 'news', 'github', 'hn', 'trends'];
  const sources = ids.map((id, i) => ({ id, online: settled[i].status === 'fulfilled' }));
  const engines = await autocomplete.health().catch(() => []);
  sendJSON(res, 200, { sources, engines });
}

/* ------------------------- SSE generation route ------------------------- */

let scanning = false;

function handleScanSSE(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 10000);
  const send = (event) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      closed = true;
    }
  };

  if (scanning) {
    send({ type: 'error', message: 'A scan is already running — it will finish on its own.' });
    clearInterval(heartbeat);
    return res.end();
  }
  scanning = true;
  const hubIds = url.searchParams.get('hubs');
  runScan({
    trigger: 'manual',
    hubIds: hubIds ? hubIds.split(',').filter(Boolean) : null,
    onEvent: send,
  })
    .catch((e) => send({ type: 'error', message: String((e && e.message) || e) }))
    .finally(() => {
      scanning = false;
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {}
    });
}

/* ------------------------------ main server ------------------------------ */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJSON(res, 400, { error: 'bad request' });
  }
  const p = url.pathname;

  try {
    if (p === '/api/ping') return sendJSON(res, 200, { ok: true, name: 'FreshCatch' });
    if (p === '/api/auth') return handleAuthInfo(req, res);
    if (p === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (p === '/api/logout' && req.method === 'POST') return handleLogout(req, res);

    if (p.startsWith('/api/')) {
      if (!authorized(req, url)) return sendJSON(res, 401, { error: 'unauthorized' });
      if (p === '/api/state') return await handleState(req, res);
      if (p === '/api/keywords') return await handleKeywords(res, url);
      if (p === '/api/keywords/star' && req.method === 'POST') return await handleStar(req, res);
      if (p === '/api/hubs' && req.method === 'POST') return await handleHubs(req, res);
      if (p === '/api/sources/health') return await handleSourcesHealth(res);
      if (p === '/api/export.csv') return await handleExportCSV(res, url);
      if (p === '/api/scan') return handleScanSSE(req, res, url);
      return sendJSON(res, 404, { error: 'unknown api route' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { error: 'GET only' });
    }
    serveStatic(res, p);
  } catch (err) {
    sendJSON(res, 500, { error: String((err && err.message) || err) });
  }
});

/* ------------------------------ background ------------------------------ */

// Daily scheduler — fires at SCAN_HOUR even if the dashboard is never opened.
let lastScheduledDay = null;
setInterval(
  () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === SCAN_HOUR && lastScheduledDay !== day && !scanning) {
      lastScheduledDay = day;
      runScan({ trigger: 'scheduled' }).catch((e) =>
        console.error('scheduled scan failed:', e && e.message)
      );
    }
  },
  5 * 60 * 1000
);

// Keep-alive self-ping — stops the free host from sleeping between scans.
if (process.env.PUBLIC_URL) {
  setInterval(
    () => fetch(`${process.env.PUBLIC_URL}/api/ping`).catch(() => {}),
    10 * 60 * 1000
  );
}

/* ------------------------------ boot ------------------------------ */

async function boot() {
  const info = await db.init();
  console.log(`FreshCatch · database: ${info.mode}`);
  server.listen(PORT, HOST, () => {
    console.log(`FreshCatch running →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Daily scan at hour ${SCAN_HOUR} · Telegram ${telegram.configured() ? 'ON' : 'off'} · AI ${ai.configured() ? 'ON' : 'off'}`);
    console.log(
      AUTH_REQUIRED
        ? `Login: ON — ${LOGIN_ENABLED ? `user "${DASH_USERNAME}"` : 'access code'}`
        : 'Login: OFF (dashboard is open)'
    );
  });

  if (process.argv.includes('--scan-once')) {
    console.log('Running one-off scan…');
    const summary = await runScan({ trigger: 'manual' });
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }
}

boot().catch((e) => {
  console.error('boot failed:', e);
  process.exit(1);
});
