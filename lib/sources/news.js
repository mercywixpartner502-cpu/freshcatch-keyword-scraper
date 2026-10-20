'use strict';

const { fetchText, cached, mapLimit } = require('../fetcher');
const { parseRssItems, stripHtml } = require('./rss');

/**
 * Google News RSS — recent news volume per name.
 * `buzz()` (count + newest timestamp) feeds the demand & freshness scores.
 */

async function search(query, opts = {}) {
  const days = opts.days || 7;
  const geo = (opts.geo || process.env.NEWS_GEO || 'US').toUpperCase();
  const q = opts.raw ? `${query} when:${days}d` : `"${query}" when:${days}d`;
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}` +
    `&hl=en-${geo}&gl=${geo}&ceid=${geo}:en`;
  return cached(`news:${geo}:${days}:${query}`, 30 * 60 * 1000, async () => {
    const xml = await fetchText(url, { timeout: 12000 });
    return parseRssItems(xml)
      .map((it) => ({
        source: 'news',
        title: stripHtml(it.title),
        text: stripHtml(it.description).slice(0, 200),
        createdAt: it.pubAt || Date.now(),
        url: it.link,
      }))
      .filter((n) => n.title);
  });
}

async function buzz(query, context, geo) {
  // Niche-context query: "verity" minecraft mod — bare words would match
  // three digits of unrelated news.
  const q = context ? `"${query}" ${context}` : `"${query}"`;
  const items = await search(q, { days: 7, geo, raw: true }).catch(() => []);
  return {
    count: items.length,
    latestAt: items.reduce((m, i) => Math.max(m, i.createdAt || 0), 0),
  };
}

async function hubChatter(hub) {
  const phrases = (hub.searchPhrases || []).slice(0, 2);
  const batches = await mapLimit(phrases, 2, (q) => search(q, { days: 7 }));
  return batches.flat().filter(Boolean);
}

module.exports = { search, buzz, hubChatter };
