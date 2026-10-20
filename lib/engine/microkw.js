'use strict';

/**
 * Micro-keyword builder — name-anchored output only.
 * The name itself, plus name × service verb, never more than 3 words,
 * so generic phrase-salads can never appear.
 */

const UNIVERSAL_VERBS = ['setup', 'help', 'custom', 'integration', 'automation', 'template', 'fix'];

function build(name, hub, intentSamples) {
  const nameWords = name.trim().split(/\s+/).length;
  const hay = (intentSamples || []).join(' ').toLowerCase();

  // Prefer verbs actually present in buyer chatter, then hub verbs, then universal.
  const pool = [...new Set([...(hub.verbs || []), ...UNIVERSAL_VERBS])];
  const proven = pool.filter((v) => hay.includes(v));
  const ordered = [...proven, ...pool.filter((v) => !proven.includes(v))];

  const out = [name.trim()];
  if (nameWords <= 2) {
    for (const v of ordered) {
      if (name.toLowerCase().includes(v)) continue; // no "ai automation automation"
      const vWords = v.split(/\s+/).length;
      if (nameWords + vWords > 3) continue;
      out.push(`${name.trim()} ${v}`);
      if (out.length >= 3) break; // name + at most 2 variants — the sellers, not spam
    }
  }
  return out
    .map((k) => k.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((k) => k.split(' ').length <= 3 && k.length >= 3);
}

module.exports = { build };
