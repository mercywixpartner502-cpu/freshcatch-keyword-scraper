'use strict';

const { fetchText, fetchJSON, cached } = require('../fetcher');

/**
 * Search-engine autocomplete — the saturation meter.
 * If several engines already suggest a name, it is mainstream (crowded);
 * if none do while people are talking about it, the window is still open.
 */

const CACHE_MS = 30 * 60 * 1000;

function norm(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

async function google(q) {
  return cached(`sug:g:${q}`, CACHE_MS, async () => {
    const data = await fetchJSON(
      `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`
    );
    return (data[1] || []).map(norm);
  });
}

async function youtube(q) {
  return cached(`sug:y:${q}`, CACHE_MS, async () => {
    const text = await fetchText(
      `https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&hl=en&q=${encodeURIComponent(q)}`
    );
    const s = text.indexOf('(');
    const e = text.lastIndexOf(')');
    if (s === -1 || e <= s) return [];
    const data = JSON.parse(text.slice(s + 1, e));
    return (data[1] || []).map((x) => norm(Array.isArray(x) ? x[0] : String(x)));
  });
}

async function bing(q) {
  return cached(`sug:b:${q}`, CACHE_MS, async () => {
    try {
      const data = await fetchJSON(`https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`);
      return (data[1] || []).map(norm);
    } catch {
      const html = await fetchText(`https://www.bing.com/AS/Suggestions?q=${encodeURIComponent(q)}&mkt=en-US`);
      return [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
        .map((m) => norm(m[1].replace(/<[^>]+>/g, '')))
        .filter(Boolean);
    }
  });
}

async function ddg(q) {
  return cached(`sug:d:${q}`, CACHE_MS, async () => {
    const data = await fetchJSON(`https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`);
    return (Array.isArray(data) ? data : [])
      .map((x) => norm(Array.isArray(x) ? x[0] : (x && x.phrase) || ''))
      .filter(Boolean);
  });
}

async function wikipedia(q) {
  return cached(`sug:w:${q}`, CACHE_MS, async () => {
    const data = await fetchJSON(
      `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=8&namespace=0&search=${encodeURIComponent(q)}`
    );
    return (data[1] || []).map(norm);
  });
}

const ENGINES = { google, youtube, bing, ddg, wikipedia };
const DEFAULT_PROBE = ['google', 'youtube', 'bing', 'ddg'];

/**
 * Which of `engineIds` already know the keyword
 * (any returned suggestion containing the keyword counts as "known").
 */
async function probe(keyword, engineIds = DEFAULT_PROBE) {
  const kw = norm(keyword);
  if (!kw) return { engines: [], count: 0 };
  const jobs = engineIds.map((id) =>
    ENGINES[id](kw).then((s) => (s.some((x) => x.includes(kw)) ? id : null)).catch(() => null)
  );
  const settled = await Promise.allSettled(jobs);
  const engines = settled.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  return { engines, count: engines.length };
}

async function health() {
  const ids = Object.keys(ENGINES);
  const settled = await Promise.allSettled(ids.map((id) => ENGINES[id]('freelance')));
  return ids.map((id, i) => ({ id, online: settled[i].status === 'fulfilled' }));
}

module.exports = { probe, health };
