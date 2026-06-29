// Erban provider sign-in orchestration (zero deps, loopback only).
//
// One-click "Sign in with <provider>" for the corner box. Called by the identity
// helper (server.mjs) over its loopback ws.
//
// The installer has ALREADY set up OpenClaw and written its config, so sign-in only
// has to AUTHENTICATE the model provider's CLI — no config rewrite, no gateway
// restart. For Claude that means the `claude` binary's own login (which OpenClaw's
// claude backend reads), via `claude setup-token` (subscription, long-lived).
//
// Safety: a provider is only "ready" after auth actually succeeds. Providers whose
// CLI backend isn't wired up yet stay unsupported so the UI disables them.

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { openStore } from './db.mjs'

const HOME = process.env.USERPROFILE || homedir()
// Same workspace resolution as server.mjs: ERBAN_WORKSPACE, else the bundle's own layout.
const WORKSPACE = process.env.ERBAN_WORKSPACE || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'workspace')
const PROVIDER_JSON = join(WORKSPACE, 'erban-provider.json')
const CLAUDE_BIN = process.env.ERBAN_CLAUDE_BIN || 'claude'
// Same canonical store as the identity helper (shared handle, see db.mjs).
const store = openStore(WORKSPACE)

// --- provider registry -------------------------------------------------------
const PROVIDERS = {
  claude: { id: 'claude', label: 'Claude', supported: true },
  chatgpt: {
    id: 'chatgpt', label: 'ChatGPT', supported: false,
    reason: 'OpenClaw has no ChatGPT CLI backend yet (app-server/API only), so one-click sign-in is not wired up.'
  },
  gemini: {
    id: 'gemini', label: 'Gemini', supported: false,
    reason: 'Gemini CLI gate is not yet proven (no native-tool strip confirmed).'
  }
}

// --- single-flight sign-in state --------------------------------------------
// status: none | signing-in | ready | error | unsupported
let state = { provider: null, status: 'none', step: null, error: null }
let running = false

export function getState () { return { ...state } }

export function listProviders () {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, supported: !!p.supported, reason: p.reason || null }))
}

export function getActiveProvider () {
  try { const p = store.getProvider(); if (p) return p } catch (e) {}
  // Belt-and-braces: read the legacy JSON directly if the store missed it.
  try {
    if (existsSync(PROVIDER_JSON)) {
      const j = JSON.parse(readFileSync(PROVIDER_JSON, 'utf8'))
      if (j && typeof j.provider === 'string') return j.provider
    }
  } catch (e) {}
  return null
}

export function startSignin (providerId) {
  const p = PROVIDERS[providerId]
  if (!p) { state = { provider: providerId, status: 'error', step: null, error: 'unknown provider' }; return getState() }
  if (!p.supported) { state = { provider: providerId, status: 'unsupported', step: null, error: p.reason }; return getState() }
  if (running) return getState()
  running = true
  state = { provider: providerId, status: 'signing-in', step: 'starting', error: null }
  runFlow(p).catch((e) => { state = { provider: providerId, status: 'error', step: state.step, error: String(e && e.message || e) } })
            .finally(() => { running = false })
  return getState()
}

// --- flow --------------------------------------------------------------------
async function runFlow (p) {
  if (p.id === 'claude') return runClaudeFlow(p)
  throw new Error('provider not implemented: ' + p.id)
}

async function runClaudeFlow (p) {
  state = { ...state, step: 'auth' }
  if (!(await claudeIsAuthed())) {
    // Opens the browser for the subscription OAuth; persists to the claude binary's own store.
    const r = await run(CLAUDE_BIN, ['setup-token'], { timeoutMs: 300000 })
    if (!(await claudeIsAuthed())) {
      throw new Error('Claude sign-in did not complete: ' + (r.stderr || r.stdout || ('exit ' + r.code)).trim().slice(0, 300))
    }
  }
  persistProvider(p.id)
  state = { provider: p.id, status: 'ready', step: 'done', error: null }
}

// `claude auth status` exits 0 when the binary is signed in (independent of where creds live).
async function claudeIsAuthed () {
  const r = await run(CLAUDE_BIN, ['auth', 'status'], { timeoutMs: 30000 })
  return r.code === 0
}

function persistProvider (provider) {
  try { store.setProvider(provider) } catch (e) {}                // canonical (SQLite)
  // Mirror to the legacy JSON the launcher reads (skip if the store IS that JSON).
  if (store.backend !== 'json') {
    try { writeFileSync(PROVIDER_JSON, JSON.stringify({ provider, updatedAt: new Date().toISOString() }, null, 2)) } catch (e) {}
  }
}

// --- tiny process runner -----------------------------------------------------
function run (cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let done = false
    const child = spawn(cmd, args, { shell: true, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout && child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr && child.stderr.on('data', (d) => { stderr += d.toString() })
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill() } catch (e) {} resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' }) } }, opts.timeoutMs || 120000)
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + String(e && e.message) }) } })
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }) } })
  })
}

export const _providers = PROVIDERS
