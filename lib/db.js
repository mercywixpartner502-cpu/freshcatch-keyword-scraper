'use strict';

/**
 * Database adapter — one interface, two backends:
 *   local  → Node built-in SQLite file (data/freshcatch.sqlite)
 *   cloud  → Turso (libsql) when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set
 */

const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  display TEXT NOT NULL,
  hub TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  mentions_last_scan INTEGER DEFAULT 0,
  source_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hub TEXT NOT NULL,
  entity TEXT NOT NULL,
  keyword TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'fresh_month',
  opportunity INTEGER DEFAULT 0,
  demand INTEGER DEFAULT 0,
  freshness INTEGER DEFAULT 0,
  saturation INTEGER DEFAULT 0,
  verdict TEXT DEFAULT 'watch',
  intent_posts INTEGER DEFAULT 0,
  mentions INTEGER DEFAULT 0,
  news_count INTEGER DEFAULT 0,
  engines TEXT DEFAULT '[]',
  sources TEXT DEFAULT '[]',
  starred INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  first_seen_at INTEGER NOT NULL,
  last_scan_at INTEGER NOT NULL,
  UNIQUE(hub, keyword)
);
CREATE INDEX IF NOT EXISTS idx_keywords_hub ON keywords(hub);
CREATE INDEX IF NOT EXISTS idx_keywords_first_seen ON keywords(first_seen_at);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  trigger_type TEXT,
  hubs TEXT,
  new_keywords INTEGER DEFAULT 0,
  total_keywords INTEGER DEFAULT 0,
  stats TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

let impl = null;
let mode = 'uninitialized';

async function init() {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (tursoUrl && tursoToken) {
    let createClient;
    try {
      ({ createClient } = require('@libsql/client'));
    } catch {
      throw new Error('TURSO_* set but @libsql/client is not installed — run: npm install');
    }
    const client = createClient({ url: tursoUrl, authToken: tursoToken });
    mode = 'turso';
    impl = {
      exec: async (sql) => {
        await client.executeMultiple(sql);
      },
      run: async (sql, params = []) => {
        const res = await client.execute({ sql, args: params });
        return { lastInsertRowid: Number(res.lastInsertRowid ?? 0) };
      },
      query: async (sql, params = []) => {
        const res = await client.execute({ sql, args: params });
        return res.rows.map((r) => ({ ...r }));
      },
    };
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const dir = path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'freshcatch.sqlite'));
    mode = 'file';
    impl = {
      exec: async (sql) => {
        db.exec(sql);
      },
      run: async (sql, params = []) => {
        const info = db.prepare(sql).run(...params);
        return { lastInsertRowid: Number(info.lastInsertRowid ?? 0) };
      },
      query: async (sql, params = []) => {
        return db.prepare(sql).all(...params);
      },
    };
  }

  await impl.exec(SCHEMA);
  return { mode };
}

async function query(sql, params = []) {
  return impl.query(sql, params);
}

async function run(sql, params = []) {
  return impl.run(sql, params);
}

async function exec(sql) {
  return impl.exec(sql);
}

module.exports = { init, query, run, exec, get mode() { return mode; } };
