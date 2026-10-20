'use strict';

/**
 * Optional AI layer — upgrades name mining from pattern-matching to
 * semantic understanding. Works with free tiers:
 *   AI_PROVIDER=gemini             (+ AI_API_KEY, optional AI_MODEL)
 *   AI_PROVIDER=openai-compatible  (+ AI_API_KEY, AI_BASE_URL, AI_MODEL)
 * Without configuration every function is a silent no-op.
 */

const { fetchJSON } = require('./fetcher');

function config() {
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  const key = process.env.AI_API_KEY;
  if (!key) return null;
  if (provider === 'gemini') {
    return { provider: 'gemini', key, model: process.env.AI_MODEL || 'gemini-2.0-flash' };
  }
  if (provider === 'openai-compatible' || provider.startsWith('openai')) {
    return {
      provider: 'openai-compatible',
      key,
      baseUrl: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
      model: process.env.AI_MODEL || 'llama-3.3-70b-versatile',
    };
  }
  return null;
}

function configured() {
  return !!config();
}

async function chat(prompt) {
  const cfg = config();
  if (!cfg) throw new Error('AI layer not configured');

  if (cfg.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.key)}`;
    const data = await fetchJSON(url, {
      method: 'POST',
      timeout: 45000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    return ((data.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }

  const data = await fetchJSON(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    timeout: 45000,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  return ((data.choices || [])[0]?.message?.content) || '';
}

/**
 * Ask the model which candidates are real products/tools/brands a
 * freelancer could sell services around. Everything it drops is noise.
 */
async function refineNames(hub, candidates) {
  const cfg = config();
  if (!cfg || !candidates.length) return candidates;

  const list = candidates
    .slice(0, 40)
    .map((c) => `${c.name} (seen ${Math.round(c.freq)}x across ${c.sourceCount} sources)`)
    .join('\n');

  const prompt = `You are a market researcher for a freelance services marketplace. Below are candidate names extracted from this week's chatter in the "${hub.label}" niche.

For each candidate, decide if it is a real product, tool, brand, or platform that a freelancer could sell services around (setup, customization, integration, development) — as opposed to a generic word, a person with no service angle, a common English word, or noise.

Reply ONLY with a JSON array, one entry per candidate you KEEP, shaped exactly:
[{"name":"...","what":"one short phrase: what it is","service":"the service a freelancer would sell"}]
Drop everything else. No commentary.

Candidates:
${list}`;

  try {
    const raw = await chat(prompt);
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return candidates;
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return candidates;
    const keep = new Map(parsed.map((p) => [String(p.name || '').toLowerCase(), p]));
    return candidates
      .filter((c) => keep.has(c.name))
      .map((c) => ({ ...c, ai: keep.get(c.name) }));
  } catch {
    return candidates; // AI unavailable → algorithmic results stand
  }
}

module.exports = { config, configured, chat, refineNames };
