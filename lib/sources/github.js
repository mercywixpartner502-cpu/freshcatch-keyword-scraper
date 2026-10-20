'use strict';

const { fetchJSON, cached } = require('../fetcher');

/**
 * GitHub repo search — newly created repositories with real traction.
 * One rotating topic per hub per scan keeps us inside the
 * unauthenticated rate limit (10 search requests/minute).
 */

const rotation = new Map(); // hubId -> next topic index

async function searchRepos(query, perPage = 15) {
  return cached(`gh:${query}`, 60 * 60 * 1000, async () => {
    const url =
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}` +
      `&sort=stars&order=desc&per_page=${perPage}`;
    const data = await fetchJSON(url, { headers: { Accept: 'application/vnd.github+json' } });
    return (data.items || []).map((r) => ({
      source: 'github',
      title: r.name || '',
      text: r.description || '',
      stars: r.stargazers_count || 0,
      createdAt: Date.parse(r.created_at) || 0,
      url: r.html_url || '',
    }));
  });
}

async function hubChatter(hub) {
  const topics = (hub.githubTopics && hub.githubTopics.length ? hub.githubTopics : hub.searchPhrases || []).slice(0, 4);
  if (!topics.length) return [];
  const idx = rotation.get(hub.id) || 0;
  rotation.set(hub.id, (idx + 1) % topics.length);
  const topic = topics[idx];

  // Pass 1: repos created in the last 90 days already gaining stars (truly new).
  const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  let items = await searchRepos(`topic:${topic} created:>${since90} stars:>15`).catch(() => []);

  // Pass 2 (fallback): recently active, high-star repos on the topic.
  if (!items.length) {
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    items = await searchRepos(`topic:${topic} pushed:>${since30} stars:>150`).catch(() => []);
  }
  return items.filter((it) => it.title);
}

module.exports = { searchRepos, hubChatter };
