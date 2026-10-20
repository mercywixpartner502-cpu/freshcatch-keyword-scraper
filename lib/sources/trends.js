'use strict';

const { fetchText, cached } = require('../fetcher');
const { parseRssItems, tagValue, decodeXml } = require('./rss');

/** Google Trends daily trending searches (RSS). Global — cross-checks every hub. */
async function daily(geo) {
  geo = (geo || process.env.TRENDS_GEO || 'US').toUpperCase();
  return cached(`trends:daily:${geo}`, 60 * 60 * 1000, async () => {
    const xml = await fetchText(
      `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`,
      { timeout: 15000 }
    );
    return parseRssItems(xml)
      .map((it) => ({
        source: 'trends',
        title: it.title,
        text: '',
        traffic: decodeXml(tagValue(it.raw, 'ht:approx_traffic')),
        createdAt: it.pubAt || Date.now(),
        url: it.link,
      }))
      .filter((t) => t.title);
  });
}

module.exports = { daily };
