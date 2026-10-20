'use strict';

/**
 * Shared HTTP helpers: timeout'd fetch, small TTL cache, bounded concurrency.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 FreshCatch/1.0';

async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 9000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      body: opts.body,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: opts.accept || '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${new URL(url).host}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url, opts = {}) {
  const text = await fetchText(url, { ...opts, accept: 'application/json,text/plain;q=0.9' });
  return JSON.parse(text);
}

/**
 * Run an async mapper over items with at most `limit` tasks in flight.
 * A mapper failure becomes a null slot (never throws).
 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch {
        results[idx] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Tiny in-memory TTL cache (per process). */
const _cache = new Map();
async function cached(key, ttlMs, producer) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await producer();
  _cache.set(key, { at: Date.now(), value });
  if (_cache.size > 3000) {
    for (const k of [..._cache.keys()].slice(0, 750)) _cache.delete(k);
  }
  return value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { UA, fetchText, fetchJSON, mapLimit, cached, sleep };
