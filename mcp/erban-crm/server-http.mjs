#!/usr/bin/env node
// Erban read-only CRM MCP server over HTTP (persistent, zero deps).
//
// Supports BOTH MCP HTTP transports so OpenClaw connects either way:
//   - Legacy SSE  : GET /mcp opens an event stream and emits an `endpoint`
//                   event; the client POSTs JSON-RPC to that endpoint and the
//                   responses are delivered back over the stream.
//   - Streamable  : POST /mcp returns the JSON-RPC response directly.
//
// Why HTTP not stdio: OpenClaw spawns stdio MCP servers per-turn and the spawn
// races prompt-building, so the tools intermittently fail to register and the
// model narrates tool calls as text. A long-lived HTTP server stays connected,
// so the five CRM tools are reliably present every turn.
//
// SAFETY INVARIANT: read tools only. No create/update/delete/send/post/pay
// tool exists anywhere in this file. The agent physically cannot actuate.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_PATH = process.env.ERBAN_CRM_DATA || join(__dirname, 'crm.json')
const PORT = Number(process.env.ERBAN_CRM_PORT || 8765)
const HOST = '127.0.0.1'
const DEFAULT_PROTOCOL = '2025-06-18'

function loadDb () { return JSON.parse(readFileSync(DATA_PATH, 'utf8')) }
function log (...a) { process.stderr.write('[erban-crm-http] ' + a.join(' ') + '\n') }

const TOOLS = [
  { name: 'list_customers', description: 'List all customers in the CRM (id, name, contact). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_customer', description: 'Get one customer by id, including contact details and notes. Read-only.',
    inputSchema: { type: 'object', properties: { customer_id: { type: 'string', description: 'Customer id, e.g. C-1001' } }, required: ['customer_id'], additionalProperties: false } },
  { name: 'list_jobs', description: 'List jobs (id, customer, title, status). Optionally filter by status. Read-only.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Optional status filter, e.g. quote_requested' } }, additionalProperties: false } },
  { name: 'get_job', description: 'Get one job by id, including line items, site address and notes. Read-only. Use this to draft a quote.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string', description: 'Job id, e.g. J-1042' } }, required: ['job_id'], additionalProperties: false } },
  { name: 'get_business_profile', description: 'Get the business profile (name, ABN, rates, GST). Read-only. Use for quote headers and pricing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
]

const HANDLERS = {
  list_customers () { return loadDb().customers.map(c => ({ id: c.id, name: c.name, phone: c.phone, email: c.email })) },
  get_customer ({ customer_id }) { const c = loadDb().customers.find(x => x.id === customer_id); if (!c) throw new Error(`No customer with id ${customer_id}`); return c },
  list_jobs ({ status } = {}) {
    const db = loadDb(); let jobs = db.jobs; if (status) jobs = jobs.filter(j => j.status === status)
    return jobs.map(j => { const cust = db.customers.find(c => c.id === j.customer_id); return { id: j.id, title: j.title, status: j.status, customer: cust ? cust.name : j.customer_id, requested_on: j.requested_on } })
  },
  get_job ({ job_id }) { const db = loadDb(); const j = db.jobs.find(x => x.id === job_id); if (!j) throw new Error(`No job with id ${job_id}`); const cust = db.customers.find(c => c.id === j.customer_id) || null; return { ...j, customer: cust } },
  get_business_profile () { return loadDb().business }
}

function handleRpc (msg) {
  const { id, method, params } = msg
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'erban-crm', version: '0.1.0' } } }
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    const fn = HANDLERS[name]
    if (!fn) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true } }
    try { return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(fn(args), null, 2) }] } } }
    catch (err) { return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } } }
  }
  if (id !== undefined && id !== null) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  return null
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, accept, mcp-session-id, mcp-protocol-version'
}

const streams = new Map() // sessionId -> SSE response
let counter = 0

function readBody (req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`)

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }

  // --- Legacy SSE transport: open the event stream ---
  if (req.method === 'GET' && (u.pathname === '/mcp' || u.pathname === '/sse')) {
    const sessionId = `s${++counter}-${process.pid}`
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', ...CORS })
    streams.set(sessionId, res)
    res.write(`event: endpoint\ndata: /mcp/post?sessionId=${sessionId}\n\n`)
    const ka = setInterval(() => { try { res.write(': ka\n\n') } catch {} }, 15000)
    req.on('close', () => { clearInterval(ka); streams.delete(sessionId) })
    return
  }

  // --- Legacy SSE transport: client posts requests here, replies go via the stream ---
  if (req.method === 'POST' && u.pathname === '/mcp/post') {
    const sse = streams.get(u.searchParams.get('sessionId'))
    const body = await readBody(req)
    let parsed
    try { parsed = JSON.parse(body) } catch { res.writeHead(400, CORS); res.end(); return }
    const msgs = Array.isArray(parsed) ? parsed : [parsed]
    for (const m of msgs) {
      const r = handleRpc(m)
      if (r && sse) sse.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`)
    }
    res.writeHead(202, CORS); res.end()
    return
  }

  // --- Streamable HTTP transport: POST returns the response directly ---
  if (req.method === 'POST' && u.pathname === '/mcp') {
    const body = await readBody(req)
    let parsed
    try { parsed = JSON.parse(body) } catch {
      res.writeHead(400, { 'content-type': 'application/json', ...CORS })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }
    const batch = Array.isArray(parsed)
    const responses = (batch ? parsed : [parsed]).map(handleRpc).filter(r => r !== null)
    if (responses.length === 0) { res.writeHead(202, CORS); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json', ...CORS })
    res.end(JSON.stringify(batch ? responses : responses[0]))
    return
  }

  res.writeHead(404, CORS); res.end()
})

server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}/mcp (data: ${DATA_PATH})`))
