'use strict';

/* FreshCatch dashboard logic. */

const $ = (s) => document.querySelector(s);

const state = {
  hubs: [],
  filter: { hub: 'all', tier: 'all', q: '', starred: false },
  lastVisit: Number(localStorage.getItem('fc_last_visit') || 0),
  authMode: 'open',
  user: null,
  authed: false,
  serverless: false,
  scanning: false,
  view: 'radar',
  protected: false,
  library: null,
};

/* ------------------------------ helpers ------------------------------ */

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function queryPath(extra = {}) {
  const params = new URLSearchParams();
  const f = { ...state.filter, ...extra };
  if (f.hub && f.hub !== 'all') params.set('hub', f.hub);
  if (f.tier && f.tier !== 'all') params.set('tier', f.tier);
  if (f.q) params.set('q', f.q);
  if (f.starred) params.set('starred', '1');
  if (f.since) params.set('since', String(f.since));
  return params.toString();
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/* ------------------------------ rendering ------------------------------ */

const TIER_LABEL = {
  hot_week: '🔥 Hot week',
  fresh_month: '🌱 This month',
  within_5mo: '✅ Under 5 mo',
  dormant: '💤 Dormant',
};
const VERDICT_LABEL = {
  'window-open': 'Window open',
  rising: 'Rising',
  closing: 'Closing',
  watch: 'Watch',
};

function fillClass(value, invert) {
  const v = invert ? 100 - value : value;
  return v >= 70 ? '' : v >= 40 ? 'mid' : 'low';
}

function oppClass(v) {
  return v >= 70 ? 'good' : v >= 40 ? 'mid' : 'low';
}

function cardHTML(r) {
  const engines = safeJson(r.engines, []);
  const sources = safeJson(r.sources, []);
  const isNew = state.lastVisit && Number(r.first_seen_at) > state.lastVisit;
  const hubLabel = (state.hubs.find((h) => h.id === r.hub) || {}).label || r.hub;

  return `
  <article class="card ${isNew ? 'is-new' : ''} ${r.starred ? 'is-starred' : ''}" data-hub="${esc(r.hub)}" data-kw="${esc(r.keyword)}">
    <div class="card-head">
      <div>
        <h3 class="kw">${esc(r.keyword)}</h3>
        <div class="meta">
          <span class="badge hub">${esc(hubLabel)}</span>
          <span class="badge tier-${esc(r.tier)}">${TIER_LABEL[r.tier] || esc(r.tier)}</span>
          <span class="badge verdict-${esc(r.verdict)}">${VERDICT_LABEL[r.verdict] || esc(r.verdict)}</span>
          ${isNew ? '<span class="badge new">New</span>' : ''}
        </div>
      </div>
      <div class="opp ${oppClass(r.opportunity)}"><b>${r.opportunity}</b><span>opp</span></div>
    </div>

    <div class="bars">
      ${barHTML('Demand', r.demand, false)}
      ${barHTML('Freshness', r.freshness, false)}
      ${barHTML('Saturation', r.saturation, true)}
    </div>

    <div class="evidence">
      <span>💬 ${r.intent_posts} buyer posts</span>
      <span>🛰 ${r.mentions} mentions</span>
      <span>📰 ${r.news_count} news</span>
      <span>🔎 ${engines.length}/4 engines</span>
      ${sources.length ? `<span>· ${sources.map(esc).join(' · ')}</span>` : ''}
    </div>

    <div class="card-actions">
      <button class="mini act-copy" type="button">Copy keyword</button>
      <button class="mini act-star ${r.starred ? 'starred' : ''}" type="button">${r.starred ? '★ Shortlisted' : '☆ Shortlist'}</button>
    </div>
  </article>`;
}

function barHTML(label, value, invert) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return `
  <div class="bar">
    <label>${label}</label>
    <div class="track"><div class="fill ${fillClass(v, invert)}" style="width:${v}%"></div></div>
    <span class="val">${v}</span>
  </div>`;
}

function renderRows(rows) {
  const list = $('#list');
  if (rows.length) {
    $('#empty').classList.add('hidden');
  } else {
    emptyState(
      'No catch yet',
      "Press <b>Scan Now</b> to dig this week's fresh micro keywords out of your niches — or wait for the daily automatic scan."
    );
  }
  list.innerHTML = rows.map(cardHTML).join('');
}

async function loadKeywords(opts = {}) {
  const data = await api('/api/keywords?' + queryPath(opts));
  $('#list').classList.remove('library-mode');
  renderRows(data.rows || []);
  return data.rows || [];
}

/* ------------------------------ keyword library ------------------------------ */

function emptyState(title, text) {
  $('#emptyTitle').textContent = title;
  $('#emptyText').innerHTML = text;
  $('#empty').classList.remove('hidden');
}

function hubLabelOf(hubId) {
  return (state.hubs.find((h) => h.id === hubId) || {}).label || hubId;
}

function formatDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function earliestOf(items) {
  return items.reduce((min, r) => {
    const n = Number(r.first_seen_at) || Infinity;
    return n < min ? n : min;
  }, Infinity);
}

function renderLibrary() {
  const list = $('#list');
  list.classList.add('library-mode');
  const all = state.library || [];
  let rows = all;

  const q = state.filter.q.toLowerCase();
  if (q) rows = rows.filter((r) => String(r.keyword).toLowerCase().includes(q));
  if (state.filter.starred) rows = rows.filter((r) => r.starred);

  if (!rows.length) {
    list.innerHTML = '';
    if (all.length) {
      emptyState(
        'No match in the library',
        'Nothing stored matches this filter — clear the search or shortlist filter to see everything again.'
      );
    } else {
      emptyState(
        'Library is empty',
        'Every keyword a scan catches is stored here permanently. Run a scan to stock it up.'
      );
    }
    return;
  }

  $('#empty').classList.add('hidden');

  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.hub)) groups.set(r.hub, []);
    groups.get(r.hub).push(r);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  const niches = new Set(all.map((r) => r.hub)).size;
  const stars = all.filter((r) => r.starred).length;
  const oldest = earliestOf(all);

  list.innerHTML =
    `<div class="lib-summary">
       <b>${all.length}</b> keyword${all.length === 1 ? '' : 's'} stored across <b>${niches}</b> niche${niches === 1 ? '' : 's'}
       ${stars ? ` · <b>${stars}</b> shortlisted` : ''}
       ${Number.isFinite(oldest) ? ` · catching since ${esc(formatDate(oldest))}` : ''}
       <div class="dim">Full archive — keywords are kept between scans and visits. Search filters it live; stars work here too.</div>
     </div>` +
    ordered
      .map(([hub, items]) => {
        const earliest = earliestOf(items);
        return `<section class="lib-group">
          <div class="lib-group-head">
            <h2>${esc(hubLabelOf(hub))}</h2>
            <span>${items.length} keyword${items.length === 1 ? '' : 's'}${Number.isFinite(earliest) ? ` · since ${esc(formatDate(earliest))}` : ''}</span>
          </div>
          <div class="cards">${items.map(cardHTML).join('')}</div>
        </section>`;
      })
      .join('');
}

async function loadLibrary() {
  if (!state.library) {
    const data = await api('/api/keywords?limit=1000');
    state.library = data.rows || [];
  }
  renderLibrary();
}

function switchViewUI(view) {
  state.view = view;
  [...$('#viewTabs').querySelectorAll('.viewtab')].forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view)
  );
  const library = view === 'library';
  $('#hubChips').classList.toggle('hidden', library);
  $('#tierChips').classList.toggle('hidden', library);
  $('#search').value = '';
  state.filter.q = '';
  state.filter.starred = false;
  $('#starBtn').classList.remove('active');
}

function setView(view) {
  switchViewUI(view);
  if (view === 'library') loadLibrary().catch((err) => toast(err.message));
  else loadKeywords().catch((err) => toast(err.message));
}

async function refreshStoredCount() {
  try {
    const data = await api('/api/keywords?limit=1');
    const n = Number(data.total) || 0;
    $('#storedCount').textContent = n ? `${n} stored` : 'nothing stored yet';
  } catch {}
  try {
    const starred = await api('/api/keywords?starred=1&limit=1');
    $('#starCount').textContent = Number(starred.total) || 0;
  } catch {}
}

function renderHubChips() {
  const nav = $('#hubChips');
  const chips = [{ id: 'all', label: 'All niches' }, ...state.hubs];
  nav.innerHTML = chips
    .map(
      (h) =>
        `<button class="chip ${state.filter.hub === h.id ? 'active' : ''}" data-hub="${esc(h.id)}" type="button">${esc(h.label)}</button>`
    )
    .join('');
}

/* ------------------------------ state / boot ------------------------------ */

async function loadState() {
  const s = await api('/api/state');
  state.hubs = (s.hubs || []).map((h) => ({ ...h }));
  renderHubChips();
  $('#starCount').textContent = '';
  renderIntegrations(s);
  return s;
}

function renderIntegrations(s) {
  const items = [
    ['Database', s.dbMode === 'turso' ? 'Turso (cloud)' : s.dbEphemeral ? 'Local SQLite (ephemeral)' : 'Local SQLite', true],
    ['Telegram alerts', s.telegram ? 'connected' : 'not set', s.telegram],
    ['AI layer', s.ai ? 'active' : 'not set', s.ai],
    ['Daily auto-scan', `hour ${s.scanHour}`, true],
    ['Scan scheduler', s.serverless ? 'Vercel cron' : 'running', true],
  ];
  $('#integrationList').innerHTML = items
    .map(
      ([label, value, on]) =>
        `<li><span>${esc(label)}</span><span class="pill ${on ? 'on' : 'off'}">${esc(value)}</span></li>`
    )
    .join('');
  const hint = $('#storageHint');
  if (hint) hint.classList.toggle('hidden', !s.dbEphemeral);
  renderCustomHubs();
}

function renderCustomHubs() {
  const customs = state.hubs.filter((h) => h.custom);
  $('#customHubs').innerHTML = customs.length
    ? customs
        .map((h) => `<div class="custom-hub"><span>${esc(h.label)}</span><button data-remove="${esc(h.id)}" type="button" title="Remove">🗑</button></div>`)
        .join('')
    : '<p class="hint">No custom niches yet.</p>';
}

function renderAccount() {
  const box = $('#accountBox');
  if (state.protected) {
    const method = state.authMode === 'password' ? 'username + password' : 'access code';
    const who = state.user ? `signed in as ${esc(state.user)}` : 'signed in';
    box.innerHTML = `
      <div class="account-row"><span>Session</span><span class="pill on">${who}</span></div>
      <div class="account-row"><span>Method</span><span class="pill on">${method}</span></div>
      <button class="logout-wide" type="button" data-logout>Log out of this device</button>`;
  } else {
    box.innerHTML = `
      <div class="account-row"><span>Session</span><span class="pill off">open access</span></div>
      <p class="hint">No <code>DASH_USERNAME</code> / <code>DASH_PASSWORD</code> is set on the server, so sign-in is off. Set them in the host's environment variables to require the login screen.</p>`;
  }
}

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {}
  state.authed = false;
  state.user = null;
  state.library = null;
  state.filter = { hub: 'all', tier: 'all', q: '', starred: false };
  $('#search').value = '';
  $('#settings').classList.add('hidden');
  $('#scanPanel').classList.add('hidden');
  showGate();
  $('#gateInput').value = '';
  $('#gateUser').value = '';
  $('#gateInput').focus();
}

async function boot() {
  let s;
  try {
    s = await loadState();
  } catch (e) {
    if (e.message !== 'unauthorized') toast('Could not load state: ' + e.message);
    return;
  }
  state.protected = !!s.accessProtected;
  state.authMode = s.authMode || (s.accessProtected ? 'code' : 'open');
  state.user = s.user || null;
  state.serverless = !!s.serverless;
  state.authed = true;
  $('#logoutBtn').classList.toggle('hidden', !state.protected);
  renderAccount();
  $('#accessGate').classList.add('hidden');
  $('#app').classList.remove('hidden');

  // "New since your last visit" banner
  if (state.lastVisit) {
    try {
      const fresh = await api('/api/keywords?' + queryPath({ since: state.lastVisit, limit: '500' }));
      const n = (fresh.rows || []).length;
      if (n > 0) {
        $('#newBannerText').innerHTML = `<b>${n} new micro keyword${n === 1 ? '' : 's'}</b> since your last visit.`;
        $('#newBanner').classList.remove('hidden');
      }
    } catch {}
  }

  try {
    await loadKeywords();
  } catch (e) {
    toast('Could not load keywords: ' + e.message);
  }

  refreshStoredCount();
  localStorage.setItem('fc_last_visit', String(Date.now()));
}

/* ------------------------------ interactions ------------------------------ */

$('#viewTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.viewtab');
  if (btn && btn.dataset.view !== state.view) setView(btn.dataset.view);
});

$('#hubChips').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  state.filter.hub = btn.dataset.hub;
  renderHubChips();
  loadKeywords().catch((err) => toast(err.message));
});

$('#tierChips').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  state.filter.tier = btn.dataset.tier;
  [...$('#tierChips').children].forEach((c) => c.classList.toggle('active', c === btn));
  loadKeywords().catch((err) => toast(err.message));
});

let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filter.q = e.target.value.trim();
    if (state.view === 'library') renderLibrary();
    else loadKeywords().catch(() => {});
  }, 250);
});

$('#newBannerBtn').addEventListener('click', () => {
  if (state.view === 'library') switchViewUI('radar');
  loadKeywords({ since: state.lastVisit, hub: 'all', tier: 'all', starred: false })
    .then((rows) => {
      toast(`Showing ${rows.length} new keywords — clear filters to go back.`);
    })
    .catch((err) => toast(err.message));
});

$('#starBtn').addEventListener('click', () => {
  state.filter.starred = !state.filter.starred;
  $('#starBtn').classList.toggle('active', state.filter.starred);
  if (state.view === 'library') renderLibrary();
  else loadKeywords().catch((err) => toast(err.message));
});

$('#list').addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const hub = card.dataset.hub;
  const kw = card.dataset.kw;

  if (e.target.closest('.act-copy')) {
    try {
      await navigator.clipboard.writeText(kw);
      toast(`Copied “${kw}”`);
    } catch {
      toast('Copy failed — long-press to copy manually');
    }
    return;
  }

  const starBtn = e.target.closest('.act-star');
  if (starBtn) {
    const starred = !starBtn.classList.contains('starred');
    try {
      await api('/api/keywords/star', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hub, keyword: kw, value: starred }),
      });
      starBtn.classList.toggle('starred', starred);
      starBtn.textContent = starred ? '★ Shortlisted' : '☆ Shortlist';
      card.classList.toggle('is-starred', starred);
      if (state.library) {
        const row = state.library.find((r) => r.hub === hub && r.keyword === kw);
        if (row) row.starred = starred ? 1 : 0;
      }
      toast(starred ? `Shortlisted “${kw}”` : `Removed “${kw}” from shortlist`);
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#exportBtn').addEventListener('click', async () => {
  try {
    const qp = state.view === 'library' ? '' : queryPath();
    const res = await fetch('/api/export.csv?' + qp);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'freshcatch-keywords.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast('CSV downloaded');
  } catch (err) {
    toast('Export failed: ' + err.message);
  }
});

/* ------------------------------ settings drawer ------------------------------ */

$('#settingsBtn').addEventListener('click', () => $('#settings').classList.remove('hidden'));
$('#settingsClose').addEventListener('click', () => $('#settings').classList.add('hidden'));

$('#customHubs').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  try {
    const data = await api('/api/hubs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove: btn.dataset.remove }),
    });
    state.hubs = data.hubs || [];
    renderHubChips();
    renderCustomHubs();
    toast('Niche removed');
  } catch (err) {
    toast(err.message);
  }
});

$('#hubForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/hubs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: $('#hubLabel').value,
        subreddits: $('#hubSubs').value,
        searchPhrases: $('#hubPhrases').value,
      }),
    });
    state.hubs = data.hubs || [];
    renderHubChips();
    renderCustomHubs();
    $('#hubForm').reset();
    toast('Niche added — it joins the next scan');
  } catch (err) {
    toast(err.message);
  }
});

/* ------------------------------ scan (SSE) ------------------------------ */

$('#scanBtn').addEventListener('click', () => startScan());
$('#scanClose').addEventListener('click', () => $('#scanPanel').classList.add('hidden'));

function scanLogLine(text, cls = '') {
  const log = $('#scanLog');
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  if (log.children.length > 120) log.removeChild(log.firstChild);
}

function startScan() {
  if (state.scanning) {
    $('#scanPanel').classList.remove('hidden');
    return;
  }
  state.scanning = true;
  $('#scanBtn').disabled = true;
  $('#scanLog').innerHTML = '';
  $('#scanTitle').textContent = 'Scanning the waters…';
  $('#scanProgress').textContent = 'warming up';
  $('#scanPanel').classList.remove('hidden');

  const single = state.filter.hub && state.filter.hub !== 'all' ? state.filter.hub : '';

  // Serverless functions get killed at a hard time limit, so there we scan one
  // hub per request (each fits comfortably) and chain them from the browser.
  if (state.serverless) {
    const queue = single
      ? [{ id: single, label: hubLabelOf(single) }]
      : state.hubs.map((h) => ({ id: h.id, label: h.label }));
    scanQueue(queue).catch((err) => {
      scanLogLine(`✖ ${err.message}`, 'err');
      finishScan(true);
    });
    return;
  }

  scanStream(single, true)
    .then((res) => finishScan(!res.ok))
    .catch((err) => {
      scanLogLine(`✖ ${err.message}`, 'err');
      finishScan(true);
    });
}

// One SSE scan request. Resolves with { ok, summary } when the stream ends.
function scanStream(hubParam, isFinal) {
  return new Promise((resolve) => {
    const params = new URLSearchParams();
    if (hubParam) params.set('hubs', hubParam);

    const es = new EventSource('/api/scan?' + params.toString());
    let settled = false;
    const settle = (ok, summary) => {
      if (settled) return;
      settled = true;
      es.close();
      resolve({ ok, summary });
    };

    es.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (data.type) {
        case 'start':
          scanLogLine(`scan #${data.scanId} started · ${data.hubs.length} niche hub(s)`);
          $('#scanProgress').textContent = `${data.hubs.length} hubs queued`;
          break;
        case 'hub-start':
          scanLogLine(`▸ ${data.label}: digging…`);
          $('#scanProgress').textContent = `scanning ${data.label}`;
          break;
        case 'log':
          scanLogLine(`  ${data.msg}`);
          break;
        case 'hub-done':
          scanLogLine(`✔ ${data.label}: ${data.names} names · ${data.keywords} keywords · ${data.new} new`, 'ok');
          $('#scanProgress').textContent = `${data.label} done — ${data.new} new`;
          break;
        case 'done': {
          const s = data.summary;
          if (isFinal) {
            scanLogLine(
              `✔ scan finished in ${Math.round(s.ms / 1000)}s — ${s.totalKeywords} keywords, ${s.newKeywords} new`,
              'ok'
            );
            $('#scanTitle').textContent = 'Catch of the day is in';
            $('#scanProgress').textContent = `${s.newKeywords} new · ${s.totalKeywords} total`;
          }
          settle(true, s);
          break;
        }
        case 'error':
          scanLogLine(`✖ ${data.message}`, 'err');
          settle(false, null);
          break;
      }
    };

    es.onerror = () => {
      // Stream ended or dropped; if the server is still scanning that's fine.
      if (es.readyState === EventSource.CLOSED) settle(false, null);
    };
  });
}

async function scanQueue(queue) {
  const startedAt = Date.now();
  let newTotal = 0;
  let grandTotal = 0;

  for (let i = 0; i < queue.length; i += 1) {
    const hub = queue[i];
    $('#scanProgress').textContent = `hub ${i + 1}/${queue.length} — ${hub.label}`;
    const res = await scanStream(hub.id, false);
    if (!res.ok) return finishScan(true);
    newTotal += res.summary.newKeywords || 0;
    grandTotal = res.summary.totalKeywords || grandTotal;
  }

  const ms = Date.now() - startedAt;
  scanLogLine(
    `✔ scan finished in ${Math.round(ms / 1000)}s — ${grandTotal} keywords, ${newTotal} new`,
    'ok'
  );
  $('#scanTitle').textContent = 'Catch of the day is in';
  $('#scanProgress').textContent = `${newTotal} new · ${grandTotal} total`;
  finishScan(false);
}

function finishScan(isError) {
  if (!state.scanning) return;
  state.scanning = false;
  $('#scanBtn').disabled = false;
  state.library = null;
  refreshStoredCount();
  if (state.view === 'library') loadLibrary().catch(() => {});
  else loadKeywords().catch(() => {});
  if (!isError) toast('Scan complete — fresh keywords loaded');
}

/* ------------------------------ login / logout ------------------------------ */

function showGate(errorMsg) {
  $('#app').classList.add('hidden');
  $('#settings').classList.add('hidden');
  $('#scanPanel').classList.add('hidden');
  const err = $('#gateError');
  if (errorMsg) {
    err.textContent = errorMsg;
    err.classList.remove('hidden');
  } else {
    err.textContent = '';
    err.classList.add('hidden');
  }
  $('#accessGate').classList.remove('hidden');
}

function handleUnauthorized() {
  const expired = state.authed;
  state.authed = false;
  state.library = null;
  showGate(expired ? 'Your session expired — sign in again.' : '');
}

function configureGate(auth) {
  state.authMode = auth.mode || 'open';
  state.protected = !!auth.required;
  const userField = $('#gateUser');
  const passField = $('#gateInput');
  if (state.authMode === 'password') {
    userField.classList.remove('hidden');
    passField.placeholder = 'Password';
    $('#gateCopy').textContent = 'Enter your username and password to open the dashboard.';
  } else {
    userField.classList.add('hidden');
    passField.placeholder = 'Access code';
    $('#gateCopy').textContent = 'Enter your access code to open the dashboard.';
  }
}

async function init() {
  localStorage.removeItem('fc_access_code'); // legacy storage from the old access-code gate
  try {
    const res = await fetch('/api/auth');
    if (res.ok) configureGate(await res.json());
  } catch {}
  boot();
}

$('#gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#gateUser').value.trim();
  const password = $('#gateInput').value;
  if (!password) return;
  if (state.authMode === 'password' && !username) {
    showGate('Enter your username too.');
    return;
  }
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, code: password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showGate(data.error || 'Sign-in failed — check your credentials.');
      return;
    }
  } catch {
    showGate('Could not reach the server — try again.');
    return;
  }
  $('#accessGate').classList.add('hidden');
  $('#gateInput').value = '';
  boot();
});

$('#logoutBtn').addEventListener('click', logout);
$('#accountBox').addEventListener('click', (e) => {
  if (e.target.closest('[data-logout]')) logout();
});

/* ------------------------------ PWA ------------------------------ */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
