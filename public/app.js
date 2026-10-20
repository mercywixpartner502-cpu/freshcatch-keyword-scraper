'use strict';

/* FreshCatch dashboard logic. */

const $ = (s) => document.querySelector(s);

const state = {
  hubs: [],
  filter: { hub: 'all', tier: 'all', q: '', starred: false },
  lastVisit: Number(localStorage.getItem('fc_last_visit') || 0),
  code: localStorage.getItem('fc_access_code') || '',
  scanning: false,
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
  const headers = { ...(opts.headers || {}) };
  if (state.code) headers['x-access-code'] = state.code;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    showGate();
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
  $('#empty').classList.toggle('hidden', rows.length > 0);
  list.innerHTML = rows.map(cardHTML).join('');
}

async function loadKeywords(opts = {}) {
  const data = await api('/api/keywords?' + queryPath(opts));
  renderRows(data.rows || []);
  return data.rows || [];
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
    ['Database', s.dbMode === 'turso' ? 'Turso (cloud)' : 'Local SQLite', true],
    ['Telegram alerts', s.telegram ? 'connected' : 'not set', s.telegram],
    ['AI layer', s.ai ? 'active' : 'not set', s.ai],
    ['Daily auto-scan', `hour ${s.scanHour}`, true],
    ['Scan scheduler', 'running', true],
  ];
  $('#integrationList').innerHTML = items
    .map(
      ([label, value, on]) =>
        `<li><span>${esc(label)}</span><span class="pill ${on ? 'on' : 'off'}">${esc(value)}</span></li>`
    )
    .join('');
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

async function boot() {
  try {
    await loadState();
  } catch (e) {
    if (e.message !== 'unauthorized') toast('Could not load state: ' + e.message);
    return;
  }
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

  localStorage.setItem('fc_last_visit', String(Date.now()));
}

/* ------------------------------ interactions ------------------------------ */

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
    loadKeywords().catch(() => {});
  }, 250);
});

$('#newBannerBtn').addEventListener('click', () => {
  loadKeywords({ since: state.lastVisit, hub: 'all', tier: 'all', starred: false })
    .then((rows) => {
      toast(`Showing ${rows.length} new keywords — clear filters to go back.`);
    })
    .catch((err) => toast(err.message));
});

$('#starBtn').addEventListener('click', () => {
  state.filter.starred = !state.filter.starred;
  $('#starBtn').classList.toggle('active', state.filter.starred);
  loadKeywords().catch((err) => toast(err.message));
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
      toast(starred ? `Shortlisted “${kw}”` : `Removed “${kw}” from shortlist`);
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#exportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/export.csv?' + queryPath(), {
      headers: state.code ? { 'x-access-code': state.code } : {},
    });
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

  const params = new URLSearchParams();
  if (state.code) params.set('code', state.code);
  if (state.filter.hub && state.filter.hub !== 'all') params.set('hubs', state.filter.hub);

  const es = new EventSource('/api/scan?' + params.toString());

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
        scanLogLine(
          `✔ scan finished in ${Math.round(s.ms / 1000)}s — ${s.totalKeywords} keywords, ${s.newKeywords} new`,
          'ok'
        );
        $('#scanTitle').textContent = 'Catch of the day is in';
        $('#scanProgress').textContent = `${s.newKeywords} new · ${s.totalKeywords} total`;
        es.close();
        finishScan();
        break;
      }
      case 'error':
        scanLogLine(`✖ ${data.message}`, 'err');
        es.close();
        finishScan(true);
        break;
    }
  };

  es.onerror = () => {
    // Stream ended or dropped; if the server is still scanning that's fine.
    if (es.readyState === EventSource.CLOSED) finishScan();
  };
}

function finishScan(isError) {
  if (!state.scanning) return;
  state.scanning = false;
  $('#scanBtn').disabled = false;
  loadKeywords().catch(() => {});
  if (!isError) toast('Scan complete — fresh keywords loaded');
}

/* ------------------------------ access gate ------------------------------ */

function showGate() {
  $('#app').classList.add('hidden');
  $('#accessGate').classList.remove('hidden');
}

$('#gateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#gateInput').value.trim();
  if (!code) return;
  localStorage.setItem('fc_access_code', code);
  state.code = code;
  $('#accessGate').classList.add('hidden');
  boot();
});

/* ------------------------------ PWA ------------------------------ */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
