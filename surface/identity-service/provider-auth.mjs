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
const SYSROOT = process.env.SystemRoot || 'C:\\Windows'

// The surface scheduled task can hand us a STRIPPED PATH (missing System32 and the npm
// global bin). That breaks both `claude` resolution AND node-pty/ConPTY's spawn of cmd.exe
// (which fails with a bare "File not found:"). Repair PATH at load so everything resolves.
;(function ensurePath () {
  try {
    const want = [SYSROOT + '\\System32', SYSROOT, (process.env.APPDATA ? process.env.APPDATA + '\\npm' : '')].filter(Boolean)
    const have = (process.env.PATH || '').split(';')
    const add = want.filter((d) => !have.some((c) => c.trim().toLowerCase() === d.toLowerCase()))
    if (add.length) process.env.PATH = add.concat(have).join(';')
  } catch (e) {}
})()

// Absolute shell + claude paths (don't rely on PATH inside the PTY).
const CMD_EXE = process.env.ComSpec || (SYSROOT + '\\System32\\cmd.exe')
const CLAUDE_CMD = (process.env.APPDATA && existsSync(process.env.APPDATA + '\\npm\\claude.cmd')) ? process.env.APPDATA + '\\npm\\claude.cmd' : 'claude'

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

// Fully in-app sign-in, no console window. `claude auth login --claudeai` needs a TTY
// (piped stdio emits nothing), so we run it through a HIDDEN ConPTY (vendored node-pty).
// We capture the OAuth URL from its output and surface it to the box ('awaiting-code'),
// open the browser, and then either: the user just clicks Approve and the loopback
// auto-completes (no code), OR they paste the code into the box and we write it to the
// PTY. claude persists the credential to the shared CLAUDE_CONFIG_DIR store the gateway
// reads. node-pty is dynamic-imported so a native-load failure can't take down naming.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
let signinTerm = null
const readyState = (p) => ({ provider: p.id, status: 'ready', step: 'done', error: null, url: null })

async function runClaudeFlow (p) {
  state = { provider: p.id, status: 'signing-in', step: 'auth', error: null, url: null }
  if (await claudeIsAuthed()) { persistProvider(p.id); state = readyState(p); return }
  let ptyMod
  try { ptyMod = (await import('./vendor/node-pty/lib/index.js')).default }
  catch (e) { throw new Error('sign-in component failed to load: ' + (e && e.message || e)) }
  await new Promise((resolve, reject) => {
    let out = '', urlSent = false, settled = false, poll = null, timer = null, term
    try {
      term = ptyMod.spawn(CMD_EXE, ['/c', CLAUDE_CMD, 'auth', 'login', '--claudeai'],
        { name: 'xterm-color', cols: 120, rows: 40, cwd: HOME, env: process.env })
    } catch (e) { return reject(new Error('could not start sign-in: ' + (e && e.message || e))) }
    signinTerm = term
    const settle = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearInterval(poll)
      try { term.kill() } catch (e) {}
      signinTerm = null
      fn(arg)
    }
    term.onData((d) => {
      out += d
      if (urlSent) return
      const clean = stripAnsi(out)
      const m = clean.match(/https?:\/\/\S*oauth\/authorize\S*/i)
      // Fire only once the whole url has landed (a newline / the paste-prompt follows it).
      if (m && (/paste code/i.test(clean) || /[\r\n]/.test(clean.slice(m.index + m[0].length)))) {
        urlSent = true
        state = { provider: p.id, status: 'awaiting-code', step: 'authorize', error: null, url: m[0] }
        openBrowser(m[0])
      }
    })
    term.onExit(async () => {
      if (await claudeIsAuthed()) settle(resolve)
      else settle(reject, new Error('Sign-in did not complete. Open the link, approve, then paste the code.'))
    })
    // Loopback path: approving in the browser can complete it with no code to paste.
    poll = setInterval(async () => { if (!settled && await claudeIsAuthed()) settle(resolve) }, 3000)
    timer = setTimeout(() => settle(reject, new Error('Sign-in timed out.')), 900000)
  })
  persistProvider(p.id)
  state = readyState(p)
}

// Write the user's pasted code into the live PTY to finish the paste flow.
export function submitCode (codeRaw) {
  const code = String(codeRaw || '').trim()
  if (!signinTerm) return { ok: false, error: 'no sign-in is in progress' }
  if (!code) return { ok: false, error: 'code required' }
  try {
    signinTerm.write(code + '\r')
    state = { ...state, status: 'signing-in', step: 'finishing' }
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e && e.message || e) } }
}

// Open the OAuth url in the default browser (best-effort; the box also shows a copy-link).
function openBrowser (url) {
  try {
    const u = String(url).replace(/'/g, "''")
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${u}'`], { windowsHide: true, stdio: 'ignore' })
  } catch (e) {}
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
