'use strict';

const { fetchText, cached } = require('../fetcher');
const { parseRssItems, stripHtml } = require('./rss');

/**
 * Product Hunt RSS — every item title IS a product name,
 * which makes this the freshest direct source of launch names.
 */
async function feed() {
  return cached('ph:feed', 30 * 60 * 1000, async () => {
    const xml = await fetchText('https://www.producthunt.com/feed', { timeout: 12000 });
    return parseRssItems(xml)
      .filter((it) => it.title)
      .map((it) => {
        // PH feed titles are usually "Product Name: tagline"
        const cut = it.title.indexOf(':');
        const name = cut > 2 && cut < 40 ? it.title.slice(0, cut).trim() : it.title;
        return {
          source: 'producthunt',
          title: name,
          text: stripHtml(it.description).slice(0, 300),
          createdAt: it.pubAt || Date.now(),
          url: it.link,
        };
      });
  });
}

async function hubChatter(hub) {
  const items = await feed().catch(() => []);
  const words = (hub.searchPhrases || [])
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  if (!words.length) return items.slice(0, 10);
  return items.filter((it) => {
    const hay = `${it.title} ${it.text}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });
}

module.exports = { feed, hubChatter };
