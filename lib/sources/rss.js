'use strict';

/** Shared RSS/Atom parsing + XML entity decoding. */

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tagValue(itemXml, name) {
  const m = itemXml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
}

function parseRssItems(xml) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  return items.map((raw) => ({
    raw,
    title: decodeXml(tagValue(raw, 'title')),
    link: decodeXml(tagValue(raw, 'link')),
    description: decodeXml(tagValue(raw, 'description')),
    pubDate: decodeXml(tagValue(raw, 'pubDate')),
    pubAt: Date.parse(decodeXml(tagValue(raw, 'pubDate'))) || 0,
  }));
}

/** Atom entries (Reddit feeds): <entry><title/><link href=""/><content/><updated/>… */
function parseAtomEntries(xml) {
  const entries = xml.match(/<entry[^>]*>[\s\S]*?<\/entry>/g) || [];
  return entries.map((raw) => {
    const when = tagValue(raw, 'updated') || tagValue(raw, 'published');
    return {
      raw,
      title: decodeXml(tagValue(raw, 'title')),
      link: decodeXml((raw.match(/<link[^>]*href="([^"]+)"/) || [])[1] || ''),
      content: decodeXml(tagValue(raw, 'content')),
      updated: decodeXml(when),
      pubAt: Date.parse(decodeXml(when)) || 0,
    };
  });
}

function stripHtml(s) {
  return decodeXml(String(s || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { decodeXml, parseRssItems, parseAtomEntries, stripHtml, tagValue };
