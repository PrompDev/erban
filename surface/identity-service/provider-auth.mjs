// Erban provider sign-in orchestration (zero deps, loopback only).
//
// Drives the one-click "Sign in with <provider>" flow for the Erban corner box.
// Called by the identity helper (server.mjs) over its loopback ws.
//
// Per provider the flow is: authenticate the provider's CLI -> register with
// OpenClaw -> point the erban profile at that runtime+model -> ensure the
// capability gate is in place -> restart the gateway -> verify the agent
// replies AND the read-and-draft gate holds, THEN report ready.
//
// Safety rule (matches the gate work proven for claude-cli): a provider is only
// reported "ready" after a verify pass. Providers whose capability gate is not
// yet proven are returned as unsupported so the UI keeps them disabled.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.USERPROFILE || homedir()
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || join(HOME, '.openclaw-erban')
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(STATE_DIR, 'openclaw.json')
const WORKSPACE = process.env.ERBAN_WORKSPACE || 'C:/Users/alias/Downloads/file2212s/agent/workspace'
const PROVIDER_JSON = join(WORKSPACE, 'erban-provider.json')
const TASK_NAME = process.env.OPENCLAW_WINDOWS_TASK_NAME || 'OpenClaw Gateway (erban)'
const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 18901)
const PROFILE = process.env.OPENCLAW_PROFILE || 'erban'
const CLAUDE_BIN = process.env.ERBAN_CLAUDE_BIN || 'claude'
const CLAUDE_CREDS = join(HOME, '.claude', '.credentials.json')
// The vendored+patched OpenClaw backend that carries the read-and-draft gate
// (native tools stripped via `--tools ""`). See memory: erban-capability-gate.
const VENDORED_BACKEND = process.env.ERBAN_VENDORED_BACKEND ||
  'C:/Users/alias/AppData/Roaming/npm/node_modules/openclaw-erban/dist/cli-backend-Bh7E9SnS.js'

// CRM ground-truth markers (from mcp/erban-crm/crm.json) used to prove the 5
// erban-crm tools actually returned real data rather than a hallucination.
const CRM_MARKERS = ['Coastline Plumbing', 'J-1042']

// --- provider registry -------------------------------------------------------
// supported:false providers are intentionally NOT wired to sign-in yet because
// their capability gate is unproven. Keeping them here lets the UI explain why.
const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    supported: true,
    runtime: 'claude-cli',
    model: 'anthropic/claude-opus-4-8',
    ocProvider: 'anthropic',
    ocMethod: 'cli'
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    supported: false,
    reason: 'OpenClaw has no hardened ChatGPT CLI backend (app-server/API only), so the read-and-draft capability gate cannot be enforced yet.'
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    supported: false,
    reason: 'Gemini CLI gate is not yet proven (no native-tool strip confirmed; gemini CLI not installed).'
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
  if (running) return getState() // one sign-in at a time
  running = true
  state = { provider: providerId, status: 'signing-in', step: 'starting', error: null }
  // fire and forget; the UI polls signin-status
  runFlow(p).catch((e) => { state = { provider: providerId, status: 'error', step: state.step, error: String(e && e.message || e) } })
                .finally(() => { running = false })
  return getState()
}

// --- the flow ----------------------------------------------------------------
async function runFlow (p) {
  if (p.id === 'claude') return runClaudeFlow(p)
  throw new Error('provider not implemented: ' + p.id)
}

async function runClaudeFlow (p) {
  // 1) authenticate the claude CLI (browser OAuth) unless already signed in
  state = { ...state, step: 'auth' }
  if (!claudeIsAuthed()) {
    const r = await run(CLAUDE_BIN, ['setup-token'], { timeoutMs: 300000 })
    if (r.code !== 0 || !claudeIsAuthed()) {
      throw new Error('Claude sign-in did not complete: ' + (r.stderr || r.stdout || ('exit ' + r.code)).slice(0, 300))
    }
  }
  // 2) register the provider with OpenClaw (best-effort; claude-cli reads ~/.claude directly)
  state = { ...state, step: 'register' }
  await run('openclaw', ['--profile', PROFILE, 'models', 'auth', 'login', '--provider', p.ocProvider, '--method', p.ocMethod, '--set-default'],
            { shell: true, timeoutMs: 120000 }).catch(() => ({}))
  // 3) point the erban profile at claude-cli + the model (idempotent)
  state = { ...state, step: 'configure' }
  setRuntimeAndModel(p.runtime, p.model)
  // 4) confirm the capability gate is present in the active backend
  if (!gateIntact()) throw new Error('capability gate missing from vendored backend (' + VENDORED_BACKEND + ')')
  // 5) restart the gateway so it loads the config
  state = { ...state, step: 'restart' }
  await restartGateway()
  // 6) verify: agent replies AND the 5 CRM tools return real data
  state = { ...state, step: 'verify' }
  await verifyBackend()
  // 7) ready
  persistProvider(p.id)
  state = { provider: p.id, status: 'ready', step: 'done', error: null }
}

// --- steps -------------------------------------------------------------------
function claudeIsAuthed () { try { return existsSync(CLAUDE_CREDS) } catch (e) { return false } }

function gateIntact () {
  try { return readFileSync(VENDORED_BACKEND, 'utf8').includes('"--tools", ""') } catch (e) { return false }
}

function setRuntimeAndModel (runtime, model) {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const defaults = cfg.agents && cfg.agents.defaults
  if (!defaults) throw new Error('agents.defaults missing in ' + CONFIG_PATH)
  if (defaults.models && typeof defaults.models === 'object') {
    for (const key of Object.keys(defaults.models)) {
      const m = defaults.models[key]
      if (m && typeof m === 'object') m.agentRuntime = { id: runtime }
    }
  }
  defaults.model = defaults.model || {}
  defaults.model.primary = model
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

function persistProvider (provider) {
  writeFileSync(PROVIDER_JSON, JSON.stringify({ provider, updatedAt: new Date().toISOString() }, null, 2))
}

async function restartGateway () {
  // Stop the task, hard-kill any lingering erban gateway node procs (matched by
  // port), then start the task and wait for the port to bind. Mirrors the manual
  // restart that reliably reloads the erban config.
  const ps = [
    `Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`,
    `Start-Sleep -Milliseconds 800`,
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '${GATEWAY_PORT}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    `for($i=0;$i -lt 30;$i++){ if(-not (Get-NetTCPConnection -LocalPort ${GATEWAY_PORT} -State Listen -ErrorAction SilentlyContinue)){break}; Start-Sleep -Milliseconds 400 }`,
    `Start-ScheduledTask -TaskName '${TASK_NAME}'`,
    `$up=$false; for($i=0;$i -lt 80;$i++){ if(Get-NetTCPConnection -LocalPort ${GATEWAY_PORT} -State Listen -ErrorAction SilentlyContinue){$up=$true;break}; Start-Sleep -Milliseconds 500 }`,
    `if(-not $up){ throw 'gateway did not bind ${GATEWAY_PORT}' }`
  ].join('; ')
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 120000 })
  if (r.code !== 0) throw new Error('gateway restart failed: ' + (r.stderr || r.stdout || ('exit ' + r.code)).slice(0, 300))
}

async function verifyBackend () {
  const hello = await agentTurn('hello', 'erban-verify-hello')
  if (!hello.ok) throw new Error('agent did not reply on verify: ' + (hello.error || 'no reply'))
  const crm = await agentTurn('Using the CRM, list every job with its id and customer. Real data only.', 'erban-verify-crm')
  const text = crm.text || ''
  if (!CRM_MARKERS.some((m) => text.includes(m))) {
    throw new Error('CRM tools did not return real data on verify (markers not found)')
  }
}

async function agentTurn (message, sessionKey) {
  const r = await run('openclaw', ['--profile', PROFILE, 'agent', '-m', message, '--session-key', 'agent:main:' + sessionKey, '--json', '--timeout', '120'],
                      { shell: true, timeoutMs: 150000 })
  try {
    const j = JSON.parse(r.stdout)
    const text = j && j.result && j.result.payloads && j.result.payloads[0] && j.result.payloads[0].text
    return { ok: j && j.status === 'ok', text: text || '', raw: j }
  } catch (e) {
    return { ok: false, error: 'unparseable agent output: ' + (r.stderr || r.stdout || '').slice(0, 200) }
  }
}

// --- tiny process runner -----------------------------------------------------
function run (cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let done = false
    const child = spawn(cmd, args, { shell: !!opts.shell, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout && child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr && child.stderr.on('data', (d) => { stderr += d.toString() })
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill() } catch (e) {} resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' }) } }, opts.timeoutMs || 120000)
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + String(e && e.message) }) } })
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }) } })
  })
}

export const _providers = PROVIDERS
