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

// One-click sign-in. `claude auth login --claudeai` uses the OAuth LOOPBACK flow: it
// auto-opens the browser and, on Approve, the redirect returns to a localhost listener
// that completes auth on its own (no code to copy - unlike `setup-token`). It needs a
// real console for a TTY (piped stdio emits nothing), so we launch a minimized console
// and poll `auth status` until the credential lands in the shared store, surfacing
// 'awaiting-terminal' so the box can say "approve in your browser".
async function runClaudeFlow (p) {
  state = { provider: p.id, status: 'signing-in', step: 'auth', error: null, url: null }
  if (await claudeIsAuthed()) {
    persistProvider(p.id)
    state = { provider: p.id, status: 'ready', step: 'done', error: null, url: null }
    return
  }
  openSigninTerminal()
  state = { provider: p.id, status: 'awaiting-terminal', step: 'authorize', error: null, url: null }
  const ok = await pollAuthed(900000)
  if (!ok) throw new Error('Sign-in did not finish. Complete it in the sign-in window, then click Sign in with Claude again.')
  persistProvider(p.id)
  state = { provider: p.id, status: 'ready', step: 'done', error: null, url: null }
}

// Launch the sign-in console (minimized - the user only interacts with the browser).
// The console gives claude a real TTY so it can open the browser + run the loopback
// listener (piped stdio yields nothing). The shipped wrapper runs `auth login` and uses
// the claude.cmd shim (avoids the PowerShell execution-policy block on claude.ps1).
function openSigninTerminal () {
  const wrapper = join(dirname(fileURLToPath(import.meta.url)), 'signin-claude.cmd')
  try {
    // Explicit argv (NOT a shell:true string): from a hidden parent the shell-string form's
    // quoting silently failed to launch anything. `start` opens a new minimized console; `cmd`
    // hosts the wrapper so its console persists for the loopback flow. VM-verified.
    const args = existsSync(wrapper)
      ? ['/c', 'start', 'Sign in to Claude', '/min', wrapper]
      : ['/c', 'start', 'Sign in to Claude', '/min', 'cmd', '/c', 'claude', 'auth', 'login', '--claudeai']
    spawn('cmd.exe', args, { windowsHide: true, stdio: 'ignore' })
  } catch (e) {}
}

// Re-open the sign-in console (the user may have closed it). Only while a flow is live.
export function reopenSignin () {
  if (state.status === 'awaiting-terminal' || state.status === 'signing-in') { openSigninTerminal(); return { ok: true } }
  return { ok: false, error: 'no sign-in in progress' }
}

// Poll `claude auth status` until the user finishes in the console window (or we time out).
async function pollAuthed (timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000))
    if (await claudeIsAuthed()) return true
  }
  return false
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
