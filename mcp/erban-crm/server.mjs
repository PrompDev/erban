#!/usr/bin/env node
// Erban read-only CRM MCP server.
//
// Phase-1 (read-and-draft) integration. This speaks the Model Context Protocol
// over stdio (newline-delimited JSON-RPC 2.0) with ZERO npm dependencies, so it
// can be vendored into the installer later with nothing to download.
//
// SAFETY INVARIANT: this server exposes READ tools only. There is no create,
// update, delete, send, post or pay tool anywhere in this file. The agent
// physically cannot actuate the CRM through it. That is the capability-level
// guarantee for this phase, not a prompt request.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_PATH = process.env.ERBAN_CRM_DATA || join(__dirname, 'crm.json')

const SERVER_NAME = 'erban-crm'
const SERVER_VERSION = '0.1.0'
const DEFAULT_PROTOCOL = '2025-06-18'

function loadDb () {
  // Read fresh each call so the "data source" stays authoritative. Read-only.
  return JSON.parse(readFileSync(DATA_PATH, 'utf8'))
}

function log (...args) {
  // Never write to stdout: stdout is the JSON-RPC channel. Logs go to stderr.
  process.stderr.write('[erban-crm] ' + args.join(' ') + '\n')
}

// ---- Tool definitions (all read-only) --------------------------------------

const TOOLS = [
  {
    name: 'list_customers',
    description: 'List all customers in the CRM (id, name, contact). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_customer',
    description: 'Get one customer by id, including contact details and notes. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { customer_id: { type: 'string', description: 'Customer id, e.g. C-1001' } },
      required: ['customer_id'],
      additionalProperties: false
    }
  },
  {
    name: 'list_jobs',
    description: 'List jobs (id, customer, title, status). Optionally filter by status. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', description: 'Optional status filter, e.g. quote_requested' } },
      additionalProperties: false
    }
  },
  {
    name: 'get_job',
    description: 'Get one job by id, including line items, site address and notes. Read-only. Use this to draft a quote.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job id, e.g. J-1042' } },
      required: ['job_id'],
      additionalProperties: false
    }
  },
  {
    name: 'get_business_profile',
    description: 'Get the business profile (name, ABN, rates, GST). Read-only. Use for quote headers and pricing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

// ---- Tool implementations (pure reads) -------------------------------------

const HANDLERS = {
  list_customers () {
    const db = loadDb()
    return db.customers.map(c => ({ id: c.id, name: c.name, phone: c.phone, email: c.email }))
  },
  get_customer ({ customer_id }) {
    const db = loadDb()
    const c = db.customers.find(x => x.id === customer_id)
    if (!c) throw new Error(`No customer with id ${customer_id}`)
    return c
  },
  list_jobs ({ status } = {}) {
    const db = loadDb()
    let jobs = db.jobs
    if (status) jobs = jobs.filter(j => j.status === status)
    return jobs.map(j => {
      const cust = db.customers.find(c => c.id === j.customer_id)
      return { id: j.id, title: j.title, status: j.status, customer: cust ? cust.name : j.customer_id, requested_on: j.requested_on }
    })
  },
  get_job ({ job_id }) {
    const db = loadDb()
    const j = db.jobs.find(x => x.id === job_id)
    if (!j) throw new Error(`No job with id ${job_id}`)
    const cust = db.customers.find(c => c.id === j.customer_id) || null
    return { ...j, customer: cust }
  },
  get_business_profile () {
    return loadDb().business
  }
}

// ---- Minimal MCP / JSON-RPC 2.0 over stdio ---------------------------------

function send (msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply (id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError (id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function handle (msg) {
  const { id, method, params } = msg

  // Notifications (no id) get no response.
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return reply(id, {})

  if (method === 'initialize') {
    const requested = params && params.protocolVersion
    return reply(id, {
      protocolVersion: requested || DEFAULT_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
    })
  }

  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS })
  }

  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    const fn = HANDLERS[name]
    if (!fn) return reply(id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true })
    try {
      const data = fn(args)
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true })
    }
  }

  // Unknown request method.
  if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`)
}

// Line-delimited framing: accumulate stdin, dispatch each complete JSON line.
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      log('failed to parse line:', line.slice(0, 200))
      continue
    }
    try {
      handle(msg)
    } catch (err) {
      log('handler error:', err && err.message)
      if (msg && msg.id != null) replyError(msg.id, -32603, 'Internal error')
    }
  }
})
process.stdin.on('end', () => process.exit(0))

log(`ready (data: ${DATA_PATH})`)
