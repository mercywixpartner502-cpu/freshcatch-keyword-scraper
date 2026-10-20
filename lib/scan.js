'use strict';

/**
 * Scan orchestrator — the pipeline that runs per hub:
 *   chatter → name mining → (AI refine) → buyer-intent verification →
 *   scoring → micro keywords → database → (Telegram on scheduled scans)
 */

const db = require('./db');
const { HUBS } = require('./hubs');
const reddit = require('./sources/reddit');
const producthunt = require('./sources/producthunt');
const github = require('./sources/github');
const hn = require('./sources/hn');
const news = require('./sources/news');
const trends = require('./sources/trends');
const autocomplete = require('./sources/autocomplete');
const extract = require('./engine/extract');
const intent = require('./engine/intent');
const microkw = require('./engine/microkw');
const { scoreName } = require('./engine/score');
const ai = require('./ai');
const telegram = require('./telegram');
const { mapLimit } = require('./fetcher');

async function activeHubs() {
  try {
    const rows = await db.query('SELECT value FROM settings WHERE key = ?', ['custom_hubs']);
    const custom = rows.length ? JSON.parse(rows[0].value) : [];
    return [...HUBS, ...custom];
  } catch {
    return HUBS;
  }
}

async function gatherChatter(hub) {
  const jobs = [
    ['reddit', reddit.hubChatter(hub)],
    ['producthunt', producthunt.hubChatter(hub)],
    ['github', github.hubChatter(hub)],
    ['hn', hn.hubChatter(hub)],
    ['news', news.hubChatter(hub)],
  ];
  const settled = await Promise.allSettled(jobs.map((j) => j[1]));
  const perSource = {};
  const items = [];
  settled.forEach((r, i) => {
    const list = r.status === 'fulfilled' ? r.value : [];
    perSource[jobs[i][0]] = list.length;
    items.push(...list);
  });
  return { items, perSource };
}

async function runScan(opts = {}) {
  const trigger = opts.trigger || 'manual';
  const onEvent = opts.onEvent || (() => {});
  const hubIds = opts.hubIds && opts.hubIds.length ? opts.hubIds : null;
  const hubs = (await activeHubs()).filter((h) => !hubIds || hubIds.includes(h.id));

  const startedAt = Date.now();
  const scanInfo = await db.run(
    'INSERT INTO scans (started_at, trigger_type, hubs) VALUES (?, ?, ?)',
    [startedAt, trigger, JSON.stringify(hubs.map((h) => h.id))]
  );
  const scanId = scanInfo.lastInsertRowid;

  onEvent({
    type: 'start',
    scanId,
    trigger,
    hubs: hubs.map((h) => ({ id: h.id, label: h.label })),
  });

  // Global freshness cross-check: today's trending searches.
  const trendsTitles = (await trends.daily().catch(() => [])).map((t) => t.title.toLowerCase());

  let totalNew = 0;
  let totalKw = 0;
  const perHub = [];

  for (const hub of hubs) {
    onEvent({ type: 'hub-start', hub: hub.id, label: hub.label });

    const { items, perSource } = await gatherChatter(hub);
    const srcLine = Object.entries(perSource)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(' · ');
    onEvent({ type: 'log', msg: `${hub.label}: ${items.length} chatter items (${srcLine || 'all sources empty'})` });

    // 1) mine candidate names
    let candidates = extract.mine(hub, items);
    const knownRows = await db.query(
      'SELECT name, display, first_seen_at, mentions_last_scan FROM entities WHERE hub = ?',
      [hub.id]
    );
    const knownMap = new Map(knownRows.map((k) => [String(k.name).toLowerCase(), k]));
    candidates = extract.mergeKnown(candidates, knownMap);
    onEvent({ type: 'log', msg: `${hub.label}: ${candidates.length} candidate names mined` });

    // 2) optional AI refinement
    candidates = await ai.refineNames(hub, candidates).catch(() => candidates);
    candidates = candidates.slice(0, 25);

    // 3) verify: buyer intent + news buzz + engine saturation probes
    // Intent first looks through the chatter we already hold; a repo's own
    // listing is excluded so it can't vouch for its own demand.
    const community = items.filter((it) => it.source !== 'github' && it.source !== 'producthunt');
    const searchBudget = { searches: 5 };
    const nicheContext = (hub.searchPhrases && hub.searchPhrases[0]) || '';
    const verified = await mapLimit(candidates, 3, async (c) => {
      const [intentRes, newsRes] = await Promise.allSettled([
        intent.verify(c.name, community, searchBudget),
        news.buzz(c.name, nicheContext),
      ]);
      const iv = intentRes.status === 'fulfilled'
        ? intentRes.value
        : { intentPosts: 0, lastIntentAt: 0, total: 0, samples: [] };
      const nv = newsRes.status === 'fulfilled'
        ? newsRes.value
        : { count: 0, latestAt: 0 };
      const probe = await autocomplete.probe(c.name).catch(() => ({ engines: [], count: 0 }));
      const wiki = await autocomplete.probe(c.name, ['wikipedia']).catch(() => ({ engines: [], count: 0 }));
      return {
        ...c,
        intent: iv,
        news: nv,
        engines: probe.engines,
        engineCount: probe.count,
        wikiKnown: wiki.count > 0,
        firstSeenAt: c.firstSeenAt || startedAt,
        trendingHit: trendsTitles.some((t) => t.includes(c.name)),
        nameWords: c.name.split(/\s+/).length,
        isNew: !c.firstSeenAt,
      };
    });

    const valid = verified
      .filter(Boolean)
      .filter((v) => {
        if (v.intent.intentPosts > 0 && (v.freq >= 2 || v.intent.intentPosts >= 2)) return true; // buyers asking for help — gold
        if (v.freq >= 4) return true; // loud chatter
        if (!v.direct) {
          // A chatter-mined name needs corroboration: repeated mentions
          // plus at least one independent echo (posts, news, engines).
          return v.freq >= 2 && (v.intent.total >= 2 || v.news.count > 0 || v.engineCount >= 2);
        }
        // Product Hunt launches are products by definition; a GitHub repo
        // must echo somewhere beyond its own repo page — Reddit chatter,
        // news coverage, or autocomplete knowledge — to be a market name.
        if ((v.sources || []).includes('producthunt')) return true;
        return v.intent.total > 0 || v.news.count > 0 || v.engineCount > 0 || v.wikiKnown;
      });

    onEvent({ type: 'log', msg: `${hub.label}: ${valid.length} verified names` });

    // 4) score + build micro keywords
    const rows = [];
    for (const v of valid) {
      const s = scoreName(v);
      const keywords = microkw.build(v.name, hub, v.intent.samples);
      for (const kw of keywords) {
        rows.push({
          hub: hub.id,
          entity: v.name,
          keyword: kw,
          ...s,
          intentPosts: v.intent.intentPosts,
          mentions: Math.round(v.freq),
          newsCount: v.news.count,
          engines: v.engines,
          sources: v.sources,
          firstSeenAt: v.firstSeenAt,
          isNew: v.isNew,
        });
      }
    }

    // 5) persist entities + keywords
    for (const v of valid) {
      await db
        .run(
          `INSERT INTO entities (name, display, hub, first_seen_at, last_seen_at, mentions_last_scan, source_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             display = excluded.display,
             last_seen_at = excluded.last_seen_at,
             mentions_last_scan = excluded.mentions_last_scan,
             source_count = excluded.source_count`,
          [
            v.name,
            v.display || v.name,
            hub.id,
            v.firstSeenAt,
            Date.now(),
            Math.round(v.freq),
            v.sourceCount || v.sources.length,
          ]
        )
        .catch(() => {});
    }

    let newCount = 0;
    for (const r of rows) {
      const existing = await db.query(
        'SELECT id FROM keywords WHERE hub = ? AND keyword = ?',
        [r.hub, r.keyword]
      );
      if (!existing.length) newCount++;
      await db
        .run(
          `INSERT INTO keywords
             (hub, entity, keyword, tier, opportunity, demand, freshness, saturation, verdict,
              intent_posts, mentions, news_count, engines, sources, first_seen_at, last_scan_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hub, keyword) DO UPDATE SET
             entity = excluded.entity,
             tier = excluded.tier,
             opportunity = excluded.opportunity,
             demand = excluded.demand,
             freshness = excluded.freshness,
             saturation = excluded.saturation,
             verdict = excluded.verdict,
             intent_posts = excluded.intent_posts,
             mentions = excluded.mentions,
             news_count = excluded.news_count,
             engines = excluded.engines,
             sources = excluded.sources,
             last_scan_at = excluded.last_scan_at`,
          [
            r.hub,
            r.entity,
            r.keyword,
            r.tier,
            r.opportunity,
            r.demand,
            r.freshness,
            r.saturation,
            r.verdict,
            r.intentPosts,
            r.mentions,
            r.newsCount,
            JSON.stringify(r.engines || []),
            JSON.stringify(r.sources || []),
            r.firstSeenAt,
            Date.now(),
          ]
        )
        .catch(() => {});
    }

    totalNew += newCount;
    totalKw += rows.length;
    perHub.push({
      hub: hub.id,
      label: hub.label,
      candidates: candidates.length,
      names: valid.length,
      keywords: rows.length,
      new: newCount,
    });
    onEvent({
      type: 'hub-done',
      hub: hub.id,
      label: hub.label,
      new: newCount,
      keywords: rows.length,
      names: valid.length,
    });
  }

  const finishedAt = Date.now();
  await db
    .run('UPDATE scans SET finished_at = ?, new_keywords = ?, total_keywords = ?, stats = ? WHERE id = ?', [
      finishedAt,
      totalNew,
      totalKw,
      JSON.stringify(perHub),
      scanId,
    ])
    .catch(() => {});

  const summary = {
    scanId,
    trigger,
    startedAt,
    finishedAt,
    newKeywords: totalNew,
    totalKeywords: totalKw,
    perHub,
    ms: finishedAt - startedAt,
  };
  onEvent({ type: 'done', summary });

  // Scheduled scans earn a Telegram ping when there is fresh gold.
  if (trigger !== 'manual' && totalNew > 0) {
    const top = await db
      .query('SELECT keyword, hub, opportunity FROM keywords WHERE first_seen_at >= ? ORDER BY opportunity DESC LIMIT 3', [
        startedAt,
      ])
      .catch(() => []);
    const lines = top.map((t) => `• <b>${t.keyword}</b> (${t.hub}) — opp ${t.opportunity}`).join('\n');
    await telegram.notify(
      `🐟 <b>FreshCatch</b> — ${totalNew} new micro keyword${totalNew === 1 ? '' : 's'} found\n` +
        lines +
        (process.env.PUBLIC_URL ? `\n${process.env.PUBLIC_URL}` : '')
    );
  }

  return summary;
}

module.exports = { runScan, activeHubs };
