'use strict';

/**
 * Scoring — freshness law, demand, saturation, opportunity.
 *
 * freshness  0-100  how alive the name is RIGHT NOW (recency of dated
 *                   activity, age on the radar, trending feed bonus)
 * demand     0-100  buyer pull (intent posts, chatter, news, engine presence)
 * saturation 0-100  how mainstream/crowded it already is (engines that know
 *                   it, Wikipedia presence, age on the radar)
 * opportunity 0-100 the headline number: (demand + freshness) discounted by
 *                   saturation — the "can I still compete" verdict
 */

const DAY = 86400000;

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function scoreName(s) {
  const now = Date.now();

  // --- freshness ---
  const intentHrs = s.lastIntentAt ? (now - s.lastIntentAt) / 3600000 : Infinity;
  const newsHrs = s.newsLatestAt ? (now - s.newsLatestAt) / 3600000 : Infinity;
  const recencyHrs = Math.min(intentHrs, newsHrs);

  let freshness;
  if (recencyHrs === Infinity) freshness = 15; // chatter seen, no dated activity
  else freshness = Math.round(100 * clamp01(1 - recencyHrs / (24 * 15))); // decays over ~15 days

  const ageDays = s.firstSeenAt ? (now - s.firstSeenAt) / DAY : 0;
  if (ageDays <= 1) freshness = Math.max(freshness, 95);
  else if (ageDays <= 7) freshness = Math.max(freshness, 85);
  else if (ageDays <= 30) freshness = Math.max(freshness, 65);
  if (s.trendingHit) freshness = Math.max(freshness, 90);

  // Tier = the freshness law: hot week > fresh month > within 5 months > dormant.
  let tier = 'dormant';
  if (recencyHrs <= 168) tier = 'hot_week';
  else if (recencyHrs <= 720) tier = 'fresh_month';
  else if (recencyHrs <= 150 * 24) tier = 'within_5mo';
  else if (ageDays <= 150) tier = 'within_5mo';

  // --- demand ---
  const demandRaw =
    2.2 * Math.log10(1 + (s.intentPosts || 0) * 2) +
    1.0 * Math.log10(1 + (s.freq || 0)) +
    1.2 * Math.log10(1 + (s.newsCount || 0)) +
    0.8 * (s.engineCount || 0) +
    0.5 * (s.sourceCount || 0);
  const demand = Math.round(100 * clamp01(demandRaw / 10));

  // --- saturation ---
  let sat = 0.45 * ((s.engineCount || 0) / 4);
  if (s.wikiKnown) sat += 0.25;
  sat += 0.3 * clamp01(ageDays / 150);
  if ((s.nameWords || 1) === 1 && !s.direct) sat += 0.1;
  const saturation = Math.round(100 * clamp01(sat));

  // --- opportunity ---
  const opp = (0.45 * demand + 0.35 * freshness + 0.2 * 10) * (1 - 0.6 * (saturation / 100));
  const opportunity = Math.round(opp);

  let verdict = 'watch';
  if (opportunity >= 55 && saturation <= 40) verdict = 'window-open';
  else if (freshness >= 70 && demand >= 35) verdict = 'rising';
  else if (saturation >= 65) verdict = 'closing';

  return { freshness, demand, saturation, opportunity, tier, verdict };
}

module.exports = { scoreName };
