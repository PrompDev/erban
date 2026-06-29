#!/usr/bin/env node
// Erban context-supervisor (zero deps) - SKELETON for Phase 3.
//
// Deterministic loop (no model in the control path, like the watchdog): poll the
// active session's context usage from OpenClaw, and when it crosses a model-aware
// threshold, write a durable handover document and force a fresh session. The new
// agent picks it up via session-start-hook.mjs.
//
// What's REAL here: config read, threshold decision (thresholds.mjs), handover
// persistence (db.mjs). What's STUBBED (needs a live OpenClaw to confirm exact
// endpoints/fields - see DESIGN.md "Open risks"): reading usage (R3) and the
// force-rotate call (R2). Those only run when ERBAN_HANDOVER_LIVE=1; by default the
// supervisor is OBSERVE-ONLY: it logs what it would do and writes the handover doc,
// but does not rotate. That makes it safe to run on a real box while we verify R1-R4.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { openStore } from '../identity-service/db.mjs'
import { shouldHandover } from './thresholds.mjs'

const WORKSPACE = process.env.ERBAN_WORKSPACE ||
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'workspace')
const SESSION_KEY = process.env.ERBAN_SESSION_KEY || 'main'
const POLL_MS = Number(process.env.ERBAN_HANDOVER_POLL_MS || 15000)
const RATIO = Number(process.env.ERBAN_HANDOVER_RATIO || 0.96)
const LIVE = process.env.ERBAN_HANDOVER_LIVE === '1'   // gate the rotate call
const CLAUDE_BIN = process.env.ERBAN_CLAUDE_BIN || 'claude'

const log = (m) => process.stderr.write(`[erban-handover] ${m}\n`)

// --- gateway config (port + token) from openclaw.json --------------------------
function gatewayConfig () {
  const candidates = [
    process.env.OPENCLAW_CONFIG_PATH,
    process.env.OPENCLAW_STATE_DIR && join(process.env.OPENCLAW_STATE_DIR, 'openclaw.json')
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        const gw = j.gateway || {}
        return { port: gw.port, token: gw.auth && gw.auth.token, base: `http://127.0.0.1:${gw.port}` }
      }
    } catch (e) {}
  }
  return null
}

// --- R3: read the active session's usage from OpenClaw -------------------------
// TODO(R3): confirm the exact endpoint + field semantics on a live gateway. The
// usage bundle exposes usage.totalTokens / contextWeight / model / maxtokens; this
// is the best guess at the REST shape (GET /v1/sessions/status).
async function readUsage (cfg) {
  if (!cfg || !cfg.port) return null
  try {
    const res = await fetch(`${cfg.base}/v1/sessions/status?key=${encodeURIComponent(SESSION_KEY)}`, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}
    })
    if (!res.ok) return null
    const j = await res.json()
    const u = j.usage || j
    return {
      model: j.model || u.model || null,
      usedTokens: Number(u.totalTokens ?? u.contextWeight ?? 0),
      maxTokens: Number(u.maxtokens ?? u.maxTokens ?? j.maxtokens ?? 0)
    }
  } catch (e) { log('readUsage failed: ' + e.message); return null }
}

// --- R4: build the handover document -------------------------------------------
// One-shot, isolated `claude -p` summary. TODO(R4): feed it the real conversation
// (OpenClaw /export or `claude -p --output-format json` of the session) rather than
// just the usage stats. --bare keeps this call from loading our own hooks (no loop).
function generateHandover (usage) {
  return new Promise((resolve) => {
    const prompt = 'Write a concise handover document for the next agent: what we were doing, ' +
      'key decisions, current state, and the immediate next step. Be specific and self-contained.'
    const child = spawn(CLAUDE_BIN, ['-p', prompt, '--bare'], { shell: true, windowsHide: true })
    let out = ''
    child.stdout && child.stdout.on('data', (d) => { out += d.toString() })
    const timer = setTimeout(() => { try { child.kill() } catch (e) {} resolve(fallbackDoc(usage)) }, 120000)
    child.on('error', () => { clearTimeout(timer); resolve(fallbackDoc(usage)) })
    child.on('close', () => { clearTimeout(timer); resolve(out.trim() || fallbackDoc(usage)) })
  })
}
function fallbackDoc (usage) {
  return `# Handover\n\nThe previous session reached ${usage.usedTokens} tokens of its ` +
    `${usage.maxTokens || '?'} window before a forced handover. Continue the user's current task.`
}

// --- R2: force a fresh session via OpenClaw -------------------------------------
async function forceRotate (cfg) {
  // TODO(R2): confirm this cleanly rotates the claude session id -> fresh SessionStart.
  const res = await fetch(`${cfg.base}/v1/sessions/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
    body: JSON.stringify({ key: SESSION_KEY })
  })
  return res.ok
}

// --- main loop -----------------------------------------------------------------
async function tick (store, cfg) {
  // If a handover is already pending (waiting to be picked up / rotated), do nothing.
  // Keeps us from re-summarising every poll while context stays above threshold.
  if (store.getPendingHandover(SESSION_KEY)) return
  const usage = await readUsage(cfg)
  if (!usage) return
  const d = shouldHandover({ model: usage.model, usedTokens: usage.usedTokens, maxTokens: usage.maxTokens, ratio: RATIO })
  log(`usage=${usage.usedTokens}/${d.window} (${Math.round(d.usedRatio * 100)}%) model=${usage.model || '?'} -> ${d.handover ? 'HANDOVER' : 'ok'}`)
  if (!d.handover) return

  const document = await generateHandover(usage)
  const id = store.addHandover({ sessionKey: SESSION_KEY, model: usage.model, contextTokens: usage.usedTokens, maxTokens: d.window, document })
  log(`wrote handover #${id} (${document.length} chars)`)

  if (!LIVE) { log('observe-only (ERBAN_HANDOVER_LIVE!=1): not rotating'); return }
  const rotated = await forceRotate(cfg)
  log(rotated ? 'rotated session' : 'rotate FAILED')
}

async function main () {
  const store = openStore(WORKSPACE)
  if (store.backend !== 'sqlite') { log('handover disabled: no SQLite store'); process.exit(0) }
  const cfg = gatewayConfig()
  if (!cfg) log('no gateway config found; readUsage will no-op until openclaw.json is present')
  log(`supervisor up (workspace=${WORKSPACE}, poll=${POLL_MS}ms, live=${LIVE})`)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await tick(store, cfg) } catch (e) { log('tick error: ' + e.message) }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

main()
