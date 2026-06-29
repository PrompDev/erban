#!/usr/bin/env node
// Erban handover pick-up - a Claude Code SessionStart hook (zero deps).
//
// Claude Code runs this when a session starts/resumes/clears/compacts (it fires
// even under OpenClaw's headless `claude -p`, as long as `--bare` isn't used). We
// read the newest UNCONSUMED handover for this box from erban's SQLite store and
// hand it back as `additionalContext`, so a freshly-rotated agent opens already
// knowing where the previous one left off. Then we mark it consumed (idempotent).
//
// Wiring: the installer writes this into the erban-local Claude home (NOT the user's
// global ~/.claude) - <root>\claude\settings.json, with CLAUDE_CONFIG_DIR pointed there:
//   "hooks": { "SessionStart": [ { "hooks": [
//     { "type": "command", "command": "\"<node>\" \"<root>/app/surface/handover-service/session-start-hook.mjs\"" }
//   ] } ] }
//
// Contract: stdout MUST be only the hook JSON (or nothing). Never block the session:
// any error -> exit 0 with no output. Logs go to stderr.

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from '../identity-service/db.mjs'

const SESSION_KEY = process.env.ERBAN_SESSION_KEY || 'main'
// Same workspace resolution as the identity helper: ERBAN_WORKSPACE (set by the
// gateway/launcher and inherited by the claude child), else the bundle layout.
const WORKSPACE = process.env.ERBAN_WORKSPACE ||
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'workspace')

function emitNothing () { process.exit(0) }

async function readStdin () {
  if (process.stdin.isTTY) return '' // manual run, no piped payload
  try {
    let input = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) input += chunk
    return input
  } catch (e) { return '' }
}

try {
  // We don't actually need the payload to do our job (the gate is "is a handover
  // pending"), but drain stdin so claude's pipe closes cleanly.
  await readStdin()

  const store = openStore(WORKSPACE)
  const pending = store.getPendingHandover(SESSION_KEY)
  if (!pending || !pending.document) { store.close && store.close(); emitNothing() }

  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: pending.document
    }
  }
  store.markHandoverConsumed(pending.id)
  store.close && store.close()
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
} catch (e) {
  process.stderr.write('[erban-handover] session-start-hook: ' + String(e && e.message) + '\n')
  emitNothing()
}
