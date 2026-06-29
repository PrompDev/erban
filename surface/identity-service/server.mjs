#!/usr/bin/env node
// Erban identity helper (zero deps, scoped to the Erban surface).
//
// The OpenClaw Control UI's CSP blocks cross-origin HTTP (connect-src 'self' ...),
// but it allows the `ws:` scheme. So this is a minimal WebSocket server: the
// browser first-run flow opens ws://127.0.0.1:8766 and sends the chosen name,
// and this writes it into the Erban agent's workspace as the SERVER-SIDE SOURCE
// OF TRUTH:
//   - erban-identity.json -> machine-readable canonical name
//   - IDENTITY.md         -> injected into the agent's system prompt, so the
//                            agent itself knows/states its own name (for future
//                            agent-to-agent identification).
// localStorage in the browser stays as a fast UI cache; this is the truth.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSignin, getState as getSigninState, getActiveProvider, listProviders } from './provider-auth.mjs'
import { openStore } from './db.mjs'

const PORT = Number(process.env.ERBAN_IDENTITY_PORT || 8766)
const HOST = '127.0.0.1'
// Source of truth = the agent workspace. The launcher passes ERBAN_WORKSPACE; if it's
// absent (helper run standalone), fall back to the bundle's own layout: this file lives
// at <bundle>/surface/identity-service/, so the workspace is ../../agent/workspace.
const WORKSPACE = process.env.ERBAN_WORKSPACE || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'workspace')
const NAME_JSON = join(WORKSPACE, 'erban-identity.json')
const IDENTITY_MD = join(WORKSPACE, 'IDENTITY.md')
// Canonical config store (SQLite, or JSON fallback). The agent name lives here;
// we mirror it to NAME_JSON + IDENTITY.md below for the launcher and the prompt.
const store = openStore(WORKSPACE)

function readName () {
  try { const n = store.getName(); if (n) return n } catch (e) {}
  // Belt-and-braces: read the legacy JSON directly if the store missed it.
  try { if (existsSync(NAME_JSON)) { const j = JSON.parse(readFileSync(NAME_JSON, 'utf8')); if (j && typeof j.name === 'string' && j.name.trim()) return j.name.trim() } } catch (e) {}
  return null
}
function identityWithName (name) {
  return `# IDENTITY.md - Who Am I?

- **Name:** ${name}
- **Role:** A helpful assistant living on the owner's PC (the erban / OpenClaw corner box).
- **Creature:** A calm, capable assistant.

Your name is **${name}**. Always refer to yourself as ${name}. If another agent or a person
asks who you are, identify yourself as ${name} - this is your identity, including for
agent-to-agent identification.
`
}
function identityEmpty () {
  return `# IDENTITY.md - Who Am I?

- **Name:**
  _(not set yet - the owner names you on first run)_
- **Role:** A helpful assistant living on the owner's PC (the erban / OpenClaw corner box).

You have not been named yet. When the owner names you on the first-run screen, that name
becomes your identity and you should refer to yourself by it from then on.
`
}
function persist (name) {
  const clean = name && String(name).trim() ? String(name).trim() : null
  try { store.setName(clean) } catch (e) {}                       // canonical (SQLite)
  // Mirror to the legacy JSON the PowerShell launcher reads before launch.
  // (When the store is JSON-backed it already wrote this file, so skip the dup.)
  if (store.backend !== 'json') {
    try { writeFileSync(NAME_JSON, JSON.stringify({ name: clean, updatedAt: new Date().toISOString() }, null, 2)) } catch (e) {}
  }
  // Render IDENTITY.md (OpenClaw injects this into the agent's system prompt).
  writeFileSync(IDENTITY_MD, clean ? identityWithName(clean) : identityEmpty())
}

function handle (payload, reply) {
  let m
  try { m = JSON.parse(payload) } catch (e) { return reply(JSON.stringify({ ok: false, error: 'bad json' })) }
  const id = m.id
  try {
    if (m.action === 'get') return reply(JSON.stringify({ id, ok: true, name: readName() }))
    if (m.action === 'set') {
      const name = String(m.name || '').trim().slice(0, 40)
      if (!name) return reply(JSON.stringify({ id, ok: false, error: 'name required' }))
      persist(name); return reply(JSON.stringify({ id, ok: true, name }))
    }
    if (m.action === 'reset') { persist(null); return reply(JSON.stringify({ id, ok: true, name: null })) }
    // --- provider sign-in (delegated to provider-auth.mjs) ---
    if (m.action === 'provider-get') {
      return reply(JSON.stringify({ id, ok: true, active: getActiveProvider(), providers: listProviders() }))
    }
    if (m.action === 'signin-start') {
      const s = startSignin(String(m.provider || ''))
      return reply(JSON.stringify({ id, ok: true, provider: s.provider, status: s.status, step: s.step, error: s.error }))
    }
    if (m.action === 'signin-status') {
      const s = getSigninState()
      return reply(JSON.stringify({ id, ok: true, provider: s.provider, status: s.status, step: s.step, error: s.error }))
    }
    reply(JSON.stringify({ id, ok: false, error: 'unknown action' }))
  } catch (e) { reply(JSON.stringify({ id, ok: false, error: String(e && e.message) })) }
}

// ---- minimal RFC6455 WebSocket server (text frames only) ----
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
function acceptKey (k) { return createHash('sha1').update(k + GUID).digest('base64') }

function decode (frame) {
  const b1 = frame[1], masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f, off = 2
  if (len === 126) { len = frame.readUInt16BE(2); off = 4 } else if (len === 127) { len = Number(frame.readBigUInt64BE(2)); off = 10 }
  let mask
  if (masked) { mask = frame.slice(off, off + 4); off += 4 }
  const data = frame.slice(off, off + len)
  if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
  return { opcode: frame[0] & 0x0f, payload: data.toString('utf8') }
}
function encode (str) {
  const data = Buffer.from(str, 'utf8'), len = data.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([header, data])
}

const server = createServer((req, res) => { res.writeHead(426); res.end('Upgrade Required') })
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n')
  let buf = Buffer.alloc(0)
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 2) {
      const b1 = buf[1]; let len = b1 & 0x7f; let hl = 2
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); hl = 4 }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); hl = 10 }
      const masked = (b1 & 0x80) !== 0
      const total = hl + (masked ? 4 : 0) + len
      if (buf.length < total) break
      const frame = buf.slice(0, total); buf = buf.slice(total)
      const { opcode, payload } = decode(frame)
      if (opcode === 0x8) { try { socket.end() } catch (e) {} return }     // close
      if (opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0])) } catch (e) {}; continue } // ping->pong
      if (opcode === 0x1) handle(payload, msg => { try { socket.write(encode(msg)) } catch (e) {} })
    }
  })
  socket.on('error', () => {})
})
server.listen(PORT, HOST, () => process.stderr.write(`[erban-identity] ws://${HOST}:${PORT} (workspace: ${WORKSPACE})\n`))
