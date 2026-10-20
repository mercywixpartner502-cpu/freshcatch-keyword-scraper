'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Name mining: chatter items → candidate entity names.
 *
 * Sources that already provide names (Product Hunt titles, GitHub repo
 * names) are taken as-is ("direct" candidates). Free text (Reddit / HN /
 * News / Trends) is mined with token-shape heuristics plus frequency and
 * cross-source corroboration — real names repeat, noise doesn't.
 */

// 10k most common English words — chatter words like "vanilla" or "buggy"
// are never brand names. Direct product titles bypass this list.
let COMMON_WORDS = new Set();
try {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'common-words.txt'), 'utf8');
  COMMON_WORDS = new Set(
    raw.split(/\r?\n/).map((w) => w.trim().toLowerCase()).filter((w) => w.length > 2)
  );
} catch {}

// Words that appear constantly in post titles and are never product names.
const TITLE_STOPWORDS = new Set(
  (
    'a an the and or but for with without into from your you my our their his her its this that these those i we they he she it ' +
    'is are was were be been being am do does did done have has had will would can could should may might must not no yes new ' +
    'old best worst good bad great top vs about after before during since until while when where why how what who whom which ' +
    'whose all any both each few more most other some such only own same so than too very just now today yesterday tomorrow ' +
    'week weeks month months year years day days time times get got getting make makes making made build builds building ' +
    'built create creates creating created use uses using used run runs running help helps helped need needs needed want ' +
    'wants wanted like likes liked know knows knew think thinks thought look looks looking go goes going come comes coming ' +
    'see seen saw work works working start starts starting stop stops stopped give gives given take takes taking find finds ' +
    'found show shows showing keep keeps kept lets says said say free paid cheap easy hard simple complex real fake full ' +
    'empty open close closed source code data dev devs developer developers user users people person anyone someone everyone ' +
    'nobody somebody everybody question questions answer answers update updates updated release releases released launch ' +
    'launched launching shipping shipped ship project projects idea ideas tool tools app apps software website websites site ' +
    'sites video videos game games player players server servers client clients business businesses company companies market ' +
    'markets price prices cost costs dollar dollars money cash pay paying buy buys bought sell sells selling sold hire hiring ' +
    'hired job jobs career freelance freelancer agency customers customer first second third last next previous one two three ' +
    'ten hundred thousand million billion thanks thank please sorry okay edit deleted removed mod mods admin owner portfolio ' +
    'studio scenario audio memo demo promo info bio duo trio combo mode morning coffee everything something anything nothing ' +
    'guys man women way ways thing things lot lots bit lots really actually basically finally however though although because ' +
    'reddit sub subreddit post thread comment karma account verified official major minor version release beta alpha'
  ).split(/\s+/)
);

// Tech terms / established giants — categories, not emerging names.
const GENERIC_TECH = new Set(
  (
    'ai artificial intelligence machine learning deep learning neural network neural networks llm llms gpt chatgpt openai ' +
    'api apis app apps web webapp website websites saas sdk framework frameworks library libraries platform platforms engine ' +
    'engines plugin plugins extension extensions theme themes template templates script scripts automation automations ' +
    'workflow workflows agent agents bot bots dashboard dashboards spreadsheet spreadsheets excel word google microsoft apple ' +
    'amazon meta nvidia anthropic claude gemini llama deepseek midjourney wordpress shopify wix webflow squarespace figma ' +
    'canva unity godot unreal blender roblox minecraft python javascript typescript react vue angular node nodejs django ' +
    'flask linux windows macos android ios chrome firefox github gitlab docker kubernetes aws azure cloud serverless database ' +
    'sql nosql mongodb postgresql mysql redis rest graphql seo crm cms ecommerce dropshipping prestashop magento woocommerce ' +
    'elementor divi gutenberg bricks kadence astra after effects premiere photoshop illustrator indesign zapier make ' +
    'automation openai chatgpt claude anthropic gemini google assistant siri alexa cortana ' +
    'youtube twitch tiktok discord twitter instagram facebook reddit telegram ' +
    'launcher launchers shader shaders modloader modpack modpacks datapack datapacks texturepack skin skins seed seeds'
  )
    .split(/\s+/)
    .filter(Boolean)
);

const ACRONYM_GENERIC = new Set([
  'AI', 'API', 'SaaS', 'LLM', 'ML', 'SEO', 'CRM', 'CMS', 'UI', 'UX', 'PC', 'NSFW', 'AMA', 'ELI5', 'OC',
  'MVP', 'B2B', 'B2C', 'FYP', 'DND', 'RPG', 'MMO', 'FPS', 'IDE', 'OS', 'DB', 'QA', 'CI', 'CD', 'GPT',
]);

const NAME_SUFFIX = /(ai|gpt|bot|lab|labs|hq|kit|flow|db|ide|js|py|dev|gg|fm|tv)$/i;

// Hobby / list / demo repo shapes — traction without a market.
const JUNK_REPO =
  /(^|[-_])(awesome|demo|example|examples|sample|samples|tutorial|tutorials|template|templates|starter|boilerplate|test|testing|practice|playground|learning|learn|course|homework|clone|backup|copy|draft|experiment|mashup|collection|curated|resources|public|private)([-_]|$)/i;

function startsUpper(tok) {
  return /^[A-Z]/.test(tok);
}

function cleanToken(tok) {
  return String(tok || '').replace(/^['\-\.]+|['\-\.]+$/g, '');
}

/** Strongly name-shaped: camelCase, digits, brand suffix, or acronym. */
function looksNamey(tok) {
  const t = tok.replace(/[^A-Za-z0-9]/g, '');
  if (t.length < 3 || t.length > 24) return false;
  const lower = t.toLowerCase();
  if (TITLE_STOPWORDS.has(lower) || GENERIC_TECH.has(lower)) return false;
  if (ACRONYM_GENERIC.has(t.toUpperCase())) return false;
  if (/^\d+$/.test(t)) return false;
  const camel = /[a-z][A-Z]/.test(t) || /^[A-Z]{2,}[a-z]/.test(t);
  const digits = /\d/.test(t);
  const suffix = NAME_SUFFIX.test(t) && t.length > 5;
  const acronym = t === t.toUpperCase() && /^[A-Z]{2,6}$/.test(t);
  return camel || digits || suffix || acronym;
}

/** Weakly plausible title word (not stopword/generic, sane length). */
function isTitleWordOk(tok, extra) {
  const t = tok.replace(/[^A-Za-z0-9]/g, '');
  if (!t) return false;
  const lower = t.toLowerCase();
  return (
    t.length >= 3 &&
    t.length <= 24 &&
    !TITLE_STOPWORDS.has(lower) &&
    !GENERIC_TECH.has(lower) &&
    !COMMON_WORDS.has(lower) &&
    !(extra && extra.has(lower)) &&
    !/^\d+$/.test(t)
  );
}

function normalizeName(raw) {
  return String(raw)
    .replace(/[^A-Za-z0-9\s\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mine(hub, items) {
  const extra = new Set(((hub && hub.blocklist) || []).map((w) => String(w).toLowerCase()));
  const counts = new Map(); // key -> { name, display, freq, sources:Set, direct, titleCase }

  const bump = (raw, item, direct = false, titleCase = false) => {
    const name = normalizeName(raw);
    if (!name || name.length < 3 || name.length > 32) return;
    if (name.split(/\s+/).length > 3) return;
    const key = name.toLowerCase();
    if (GENERIC_TECH.has(key) || TITLE_STOPWORDS.has(key) || extra.has(key)) return;
    // Common dictionary words are chatter noise — but a product that is
    // literally named after one (direct source) stays valid.
    if (!direct && COMMON_WORDS.has(key)) return;
    let e = counts.get(key);
    if (!e) {
      e = { name: key, display: name, freq: 0, sources: new Set(), direct, titleCase };
      counts.set(key, e);
    }
    e.freq += 1;
    if (item && item.source) e.sources.add(item.source);
    if (direct) e.direct = true;
    if (titleCase) e.titleCase = true;
  };

  for (const item of items) {
    // Direct-name sources: titles ARE names. Product Hunt launches are
    // products by definition. GitHub repos count as market names only with
    // real traction — hobby repos must earn a slot through frequency and
    // cross-source corroboration like any other mention.
    if (item.source === 'producthunt') {
      bump(item.title, item, true);
    } else if (item.source === 'github') {
      const stars = Number(item.stars) || 0;
      const segments = item.title.split(/[-_]/).filter(Boolean).length;
      const core = item.title.replace(/[^A-Za-z0-9]/g, '');
      // Name-shaped repos with traction, or genuinely famous ones — plain
      // dictionary-word repos ("launcher") never pass as brand names.
      const direct =
        stars >= 100 &&
        segments <= 2 &&
        !JUNK_REPO.test(item.title) &&
        (looksNamey(core) || stars >= 300);
      bump(item.title, item, direct);
    }

    const tokens = String(item.title || '')
      .split(/[^A-Za-z0-9'.\-]+/)
      .filter(Boolean)
      .map(cleanToken)
      .filter(Boolean);

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (looksNamey(tok)) bump(tok, item);
      // Plain brand-style words: TitleCase tokens mid-title ("Sodium",
      // "Iris", "Enderbridge") — never sentence-start, must repeat.
      else if (
        i > 0 &&
        startsUpper(tok) &&
        tok.replace(/[^A-Za-z0-9]/g, '').length >= 4 &&
        isTitleWordOk(tok, extra)
      ) {
        bump(tok, item, false, true);
      }
      const next = i + 1 < tokens.length ? tokens[i + 1] : '';
      if (
        tok &&
        next &&
        startsUpper(tok) &&
        startsUpper(next) &&
        isTitleWordOk(tok, extra) &&
        isTitleWordOk(next, extra) &&
        (looksNamey(tok) || looksNamey(next))
      ) {
        bump(`${tok} ${next}`, item);
      }
    }
  }

  // Thresholds: strong candidates need freq >= 2; weak ones need
  // cross-source corroboration (>= 2 sources and >= 3 mentions).
  const out = [];
  for (const e of counts.values()) {
    if (e.direct) {
      out.push({ ...e, sourceCount: e.sources.size, freq: Math.max(1, e.freq) });
      continue;
    }
    const sourceCount = e.sources.size;
    const namey = looksNamey(e.display.replace(/\s/g, ''));
    // Strong shapes (acronyms like BOP, digits like ATM10, camelCase) earn
    // a slot even once — verification decides if they are real. Plain
    // TitleCase words must repeat; loose mentions need cross-source proof.
    if (namey && e.freq >= 1) {
      out.push({ ...e, sourceCount });
    } else if (e.titleCase && e.freq >= 2) {
      out.push({ ...e, sourceCount });
    } else if (e.freq >= 3 && sourceCount >= 2) {
      out.push({ ...e, sourceCount });
    }
  }

  out.sort(
    (a, b) => (b.direct ? 2 : 0) + b.freq + b.sourceCount * 1.5 - ((a.direct ? 2 : 0) + a.freq + a.sourceCount * 1.5)
  );
  return out.slice(0, 45).map((e) => ({ ...e, sources: [...e.sources] }));
}

/** Attach first-seen continuity from previously known entities. */
function mergeKnown(candidates, knownMap) {
  for (const c of candidates) {
    const k = knownMap.get(c.name);
    if (k) {
      c.firstSeenAt = Number(k.first_seen_at);
      c.prevMentions = Number(k.mentions_last_scan || 0);
      if (k.display) c.display = k.display;
    }
  }
  return candidates;
}

module.exports = { mine, mergeKnown, looksNamey };
