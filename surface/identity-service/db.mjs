// Erban config store - SQLite source of truth for the corner box (zero deps).
//
// Uses Node 24+'s built-in `node:sqlite`, so we keep the project's no-dependency
// rule (no native build step on the user's PC). The store owns one file in the
// agent workspace:
//   erban-config.db  ->  a tiny key/value `config` table (assistant name, the
//                        signed-in model provider, and room to grow).
//
// This is the CANONICAL store. Callers still mirror name + provider to the legacy
// JSON files (the PowerShell launcher reads those before launch) and still render
// IDENTITY.md (OpenClaw injects it into the system prompt) - SQLite just becomes
// the truth those are written from.
//
// Robustness: if `node:sqlite` is ever unavailable (older Node, module disabled),
// openStore() returns a JSON-backed store with the SAME shape, so first-run can
// never break - it just behaves like the old flat-file version.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ISO = () => new Date().toISOString()

// Load node:sqlite without spamming stderr with its experimental warning.
let DatabaseSync = null
try {
  const origEmit = process.emitWarning
  process.emitWarning = (w, ...rest) => {
    if (String(w).includes('SQLite is an experimental')) return
    return origEmit.call(process, w, ...rest)
  }
  ;({ DatabaseSync } = await import('node:sqlite'))
  process.emitWarning = origEmit
} catch (e) {
  DatabaseSync = null // -> JSON fallback below
}

// Read a string field out of a legacy JSON config file, or null.
function readJsonField (file, field) {
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      if (j && typeof j[field] === 'string' && j[field].trim()) return j[field].trim()
    }
  } catch (e) {}
  return null
}

// JSON-backed store used when node:sqlite is unavailable. Same shape as the
// SQLite store so callers don't care which one they got.
function makeJsonFallback (nameJson, providerJson) {
  return {
    backend: 'json',
    path: null,
    getName: () => readJsonField(nameJson, 'name'),
    setName: (name) => writeFileSync(nameJson, JSON.stringify({ name: name || null, updatedAt: ISO() }, null, 2)),
    getProvider: () => readJsonField(providerJson, 'provider'),
    setProvider: (p) => writeFileSync(providerJson, JSON.stringify({ provider: p || null, updatedAt: ISO() }, null, 2)),
    get: () => null,
    set: () => {},
    // Handover storage needs SQLite; stay inert (the supervisor logs that handover is disabled).
    addHandover: () => null,
    getPendingHandover: () => null,
    markHandoverConsumed: () => {},
    listHandovers: () => [],
    close: () => {}
  }
}

// One-time import of the legacy JSON files into SQLite, so existing installs
// upgrade without losing their name/provider. Guarded by a flag row so a later
// reset (name set back to null) is never overwritten by the old JSON value.
function migrateFromJson (store, nameJson, providerJson) {
  if (store.get('_migrated_json')) return
  const n = readJsonField(nameJson, 'name')
  if (n) store.set('name', n)
  const p = readJsonField(providerJson, 'provider')
  if (p) store.set('provider', p)
  store.set('_migrated_json', '1')
}

// One store per workspace, shared across the identity helper + provider-auth
// (both run in the same node process, so they reuse a single DB handle).
const STORES = new Map()

// Open the config store for a workspace dir. Always returns a usable store.
export function openStore (workspace) {
  const cached = STORES.get(workspace)
  if (cached) return cached
  const store = buildStore(workspace)
  STORES.set(workspace, store)
  return store
}

function buildStore (workspace) {
  const nameJson = join(workspace, 'erban-identity.json')
  const providerJson = join(workspace, 'erban-provider.json')

  if (!DatabaseSync) return makeJsonFallback(nameJson, providerJson)

  let db
  const dbPath = join(workspace, 'erban-config.db')
  try {
    db = new DatabaseSync(dbPath)
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS config (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handovers (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key    TEXT NOT NULL DEFAULT 'main',
        model          TEXT,
        context_tokens INTEGER,
        max_tokens     INTEGER,
        document       TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        consumed_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_handovers_pending ON handovers(session_key, consumed_at);
    `)
  } catch (e) {
    // Disk/permission/corruption trouble - don't let config wedge first-run.
    return makeJsonFallback(nameJson, providerJson)
  }

  const selStmt = db.prepare('SELECT value FROM config WHERE key = ?')
  const upStmt = db.prepare(
    'INSERT INTO config(key, value, updated_at) VALUES(?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  )

  const get = (k) => { const r = selStmt.get(k); return r && r.value != null ? r.value : null }
  const set = (k, v) => { upStmt.run(k, v == null ? null : String(v), ISO()) }

  // --- handover store (Phase 3): durable handover docs the SessionStart hook picks up ---
  const insHandover = db.prepare(
    'INSERT INTO handovers(session_key, model, context_tokens, max_tokens, document, created_at) ' +
    'VALUES(?, ?, ?, ?, ?, ?)'
  )
  const pendingHandover = db.prepare(
    'SELECT * FROM handovers WHERE session_key = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1'
  )
  const consumeHandover = db.prepare('UPDATE handovers SET consumed_at = ? WHERE id = ?')
  const recentHandovers = db.prepare('SELECT * FROM handovers WHERE session_key = ? ORDER BY id DESC LIMIT ?')

  const store = {
    backend: 'sqlite',
    path: dbPath,
    getName: () => get('name'),
    setName: (name) => set('name', name && String(name).trim() ? String(name).trim() : null),
    getProvider: () => get('provider'),
    setProvider: (p) => set('provider', p && String(p).trim() ? String(p).trim() : null),
    get,
    set,
    // Handover API
    addHandover: ({ sessionKey = 'main', model = null, contextTokens = null, maxTokens = null, document }) => {
      const r = insHandover.run(sessionKey, model, contextTokens, maxTokens, String(document), ISO())
      return Number(r.lastInsertRowid)
    },
    getPendingHandover: (sessionKey = 'main') => pendingHandover.get(sessionKey) || null,
    markHandoverConsumed: (id) => { consumeHandover.run(ISO(), id) },
    listHandovers: (sessionKey = 'main', limit = 20) => recentHandovers.all(sessionKey, limit),
    close: () => { try { db.close() } catch (e) {} }
  }

  migrateFromJson(store, nameJson, providerJson)
  return store
}
