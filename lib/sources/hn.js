'use strict';

const { fetchJSON, cached, mapLimit } = require('../fetcher');

/** Hacker News (Algolia API) — fresh dev-community chatter, free JSON, no key. */

async function searchByDate(query, days = 7) {
  return cached(`hn:${days}:${query}`, 60 * 60 * 1000, async () => {
    const ts = Math.floor((Date.now() - days * 86400000) / 1000);
    const url =
      `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}` +
      `&tags=story&numericFilters=created_at_i%3E${ts}&hitsPerPage=25`;
    const data = await fetchJSON(url);
    return (data.hits || [])
      .filter((h) => h.title)
      .map((h) => ({
        source: 'hn',
        title: h.title,
        text: '',
        points: h.points || 0,
        createdAt: (h.created_at_i || 0) * 1000,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      }));
  });
}

async function hubChatter(hub) {
  const phrases = (hub.searchPhrases || []).slice(0, 3);
  const batches = await mapLimit(phrases, 2, (q) => searchByDate(q, 7));
  return batches.flat().filter(Boolean);
}

module.exports = { searchByDate, hubChatter };
