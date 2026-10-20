'use strict';

const { fetchText, cached, sleep } = require('../fetcher');
const { parseAtomEntries, stripHtml } = require('./rss');

/**
 * Reddit via its public RSS/Atom feeds. The JSON API 403s server-side
 * traffic; the .rss endpoints answer. Reddit hard-throttles unauthenticated
 * bursts (first request 200, the next ones 429), so every request goes
 * through a self-tuning paced queue — gaps grow on 429, relax on success,
 * and a circuit breaker backs off entirely after repeated throttling.
 */

const MIN_GAP_MS = 8000;
const MAX_GAP_MS = 90000;
const COOLDOWN_MS = 5 * 60 * 1000;
let gapMs = MIN_GAP_MS;
let consecutive429 = 0;
let cooldownUntil = 0;
let chain = Promise.resolve();

function paced(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {}).then(() => sleep(gapMs));
  return run;
}

async function fetchFeed(url, timeout = 12000) {
  if (Date.now() < cooldownUntil) throw new Error('reddit cooling down');
  const attempt = () => paced(() => fetchText(url, { timeout }));
  try {
    const text = await attempt();
    consecutive429 = 0;
    gapMs = Math.max(MIN_GAP_MS, Math.round(gapMs * 0.85));
    return text;
  } catch (e) {
    if (e && e.status === 429) {
      consecutive429++;
      const retryAfterMs = (e.retryAfter || 0) * 1000;
      gapMs = Math.min(MAX_GAP_MS, Math.max(gapMs * 2, retryAfterMs));
      if (consecutive429 >= 2) cooldownUntil = Date.now() + COOLDOWN_MS;
      if (retryAfterMs > 0 && retryAfterMs <= 15000) {
        await sleep(retryAfterMs);
        return attempt();
      }
      throw e;
    }
    await sleep(2500);
    return attempt();
  }
}

function mapEntry(e) {
  return {
    source: 'reddit',
    title: e.title || '',
    text: stripHtml(e.content || '').slice(0, 500),
    score: 0,
    comments: 0,
    createdAt: e.pubAt || 0,
    url: e.link || '',
    subreddit: '',
  };
}

async function subredditTop(sub, timeframe = 'week') {
  return cached(`rd:top:${timeframe}:${sub}`, 3 * 60 * 60 * 1000, async () => {
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top/.rss?t=${timeframe}`;
    const xml = await fetchFeed(url);
    return parseAtomEntries(xml).map(mapEntry).filter((p) => p.title);
  });
}

/** Keyword/phrase search across all of Reddit, newest first. */
async function searchRecent(query, timeframe = 'month') {
  return cached(`rd:search:${timeframe}:${query}`, 12 * 60 * 60 * 1000, async () => {
    const url = `https://www.reddit.com/search/.rss?q=${encodeURIComponent(query)}&sort=new&t=${timeframe}`;
    const xml = await fetchFeed(url);
    return parseAtomEntries(xml).map(mapEntry).filter((p) => p.title);
  });
}

// One phrase rotates per scan per hub — Reddit throttles hard, so every
// request has to earn its slot.
const phraseRotation = new Map();

function rotate(map, key, list, count) {
  if (!list.length) return [];
  const start = (map.get(key) || 0) % list.length;
  map.set(key, start + count);
  const out = [];
  for (let i = 0; i < Math.min(count, list.length); i++) out.push(list[(start + i) % list.length]);
  return out;
}

async function hubChatter(hub) {
  // One multi-subreddit feed covers the whole hub in a single request
  // (Reddit throttles per request, so concatenated subs are 4x cheaper),
  // plus one rotating phrase search for fresh niche posts.
  const subs = (hub.subreddits || []).slice(0, 6);
  const phrases = rotate(phraseRotation, hub.id, hub.searchPhrases || [], 1);
  const jobs = [];
  if (subs.length) {
    jobs.push(
      cached(`rd:multi:${subs.join('+')}`, 3 * 60 * 60 * 1000, async () => {
        const url = `https://www.reddit.com/r/${subs.map(encodeURIComponent).join('+')}/top/.rss?t=week`;
        const xml = await fetchFeed(url);
        return parseAtomEntries(xml).map(mapEntry).filter((p) => p.title);
      })
    );
  }
  for (const p of phrases) jobs.push(searchRecent(p, 'month'));
  const settled = await Promise.allSettled(jobs);
  return settled.map((r) => (r.status === 'fulfilled' ? r.value : [])).flat();
}

module.exports = { subredditTop, searchRecent, hubChatter };
