'use strict';

const { searchRecent } = require('../sources/reddit');

/**
 * Buyer-intent verification — a name qualifies only if people are asking
 * for HELP with it, not merely discussing it.
 */

const INTENT_WORDS = [
  'help', 'setup', 'set up', 'install', 'tutorial', 'how to', 'error', 'fix', 'issue', 'bug',
  'not working', 'stuck', 'crash', 'crashing', 'hire', 'hiring', 'looking for', 'can someone',
  'commission', 'freelance', 'freelancer', 'price', 'cost', 'recommend', 'alternative',
  'template', 'custom', 'build me', 'make me', 'possible', 'automate', 'integrate',
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function verify(name, corpus, budget) {
  const lower = name.toLowerCase();
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(lower)}([^a-z0-9]|$)`, 'i');
  const hits = [];
  const scan = (posts) => {
    for (const p of posts || []) {
      const hay = `${p.title || ''} ${p.text || ''}`.toLowerCase();
      if (re.test(hay)) hits.push(p);
    }
  };

  // 1) Free pass: the community chatter already gathered for this hub
  //    (reddit / HN / news — never the repo's own listing).
  scan(corpus);

  // 2) Only names with no chatter echo cost a Reddit search — and the
  //    hub's scan budget caps how many of those we fire.
  if (!hits.length && (!budget || budget.searches > 0)) {
    if (budget) budget.searches--;
    const posts = await searchRecent(`"${name}"`, 'month').catch(() => []);
    scan(posts);
  }

  let intentPosts = 0;
  let lastIntentAt = 0;
  const samples = [];
  for (const p of hits) {
    const hay = `${p.title} ${p.text || ''}`.toLowerCase();
    if (INTENT_WORDS.some((w) => hay.includes(w))) {
      intentPosts++;
      lastIntentAt = Math.max(lastIntentAt, p.createdAt || 0);
      if (samples.length < 3 && p.title) samples.push(p.title.slice(0, 140));
    }
  }
  return { total: hits.length, intentPosts, lastIntentAt, samples };
}

module.exports = { verify, INTENT_WORDS };
