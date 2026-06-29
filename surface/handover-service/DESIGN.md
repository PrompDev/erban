# Handover service - design (Phase 3 spike)

Status: **spike / design**. The store + threshold logic + SessionStart hook in this folder
are built and unit-tested. The supervisor loop and OpenClaw force-rotate call are skeletoned
and need a live OpenClaw install to finish (see "Open risks" at the bottom).

## Goal

When the agent's context fills toward its model's limit (e.g. ~960K of Opus 4.8's 1M window),
**force a handover**: write a durable handover document, rotate to a fresh agent session, and have
the new agent pick up automatically from that document. The threshold scales with the model's
context window, so a 200K model (Haiku) hands over at ~190K instead.

## Why it isn't just OpenClaw/Claude compaction

The installed agent runs through OpenClaw's `claude-cli` backend, which is a live
`claude -p --output-format stream-json` process. That backend declares
`ownsNativeCompaction: true` - **Claude Code compacts its own context internally**, and OpenClaw
stays out of it. Claude's auto-compaction is lossy in-place summarisation that keeps the *same*
session; it produces no durable artefact. We want the opposite: a clean, audited handover
**document** and a **fresh** session. So we sit alongside Claude's compaction and trigger a bit
earlier (96%), with Claude's own `PreCompact` as a backstop if we ever miss.

## The three seams we use (all confirmed)

1. **Usage signal - OpenClaw gateway.** OpenClaw parses `claude`'s `stream-json` `usage` and exposes,
   per session: `usage.totalTokens`, `contextWeight`, `model`/`modelProvider`, `mintokens`/`maxtokens`.
   Readable via the gateway WS `sessions` snapshot, REST `GET /v1/sessions/status`, or the CLI
   (`openclaw sessions`, `openclaw status --usage`). We do NOT use Claude's statusLine: it's a TUI
   element and won't render under OpenClaw's headless `claude -p`.
2. **Force-rotate - OpenClaw.** `POST /v1/sessions/reset` (reset a session by key) / `openclaw sessions`
   reset ends the current session so the next turn starts a fresh `claude` session id. CLAUDE.md rule:
   prefer calling this through OpenClaw's CLI/API over reimplementing it.
3. **Pick-up - Claude Code SessionStart hook.** Hooks fire under `claude -p` (unless `--bare`).
   On `SessionStart` (source `startup`/`resume`/`clear`/`compact`) our hook reads the newest unconsumed
   handover for this workspace from erban's SQLite and returns it as `additionalContext`, so the fresh
   agent opens with the handover already in context. `PreCompact` (gives `transcript_path` + `trigger`)
   is the backstop that captures a handover whenever Claude compacts on its own.

## Data flow

```
                 erban context-supervisor (loopback, deterministic - like the watchdog)
                 1. poll OpenClaw usage for the active session  -> totalTokens / maxtokens / model
                 2. fill% = totalTokens / window(model);  threshold = window * 0.96
                 3. if over: generate handover doc (one-shot `claude -p` summary of the session)
                 4. INSERT into erban-config.db `handovers` (session_key, model, tokens, document)
                 5. force-rotate via OpenClaw  (POST /v1/sessions/reset)
                                   |
                                   v
   OpenClaw starts a fresh `claude` session  ->  Claude Code fires SessionStart
                                   |
                                   v
   session-start-hook.mjs: read newest unconsumed handover for this workspace from erban-config.db,
   emit { hookSpecificOutput: { additionalContext: <document> } }, mark it consumed.
                                   |
                                   v
                    New agent opens already knowing where the last one left off.
```

The whole exchange goes through **erban's SQLite** (`handovers` table) - the same store Phase 1 added.
No model sits in the control loop except the one summarisation call that writes the document.

## Model-aware threshold

`thresholds.mjs` owns a model -> context-window map and the trigger ratio:

| Model | Window | Handover at (×0.96) |
|---|---|---|
| claude-opus-4-8 | 1,000,000 | 960,000 |
| claude-sonnet-4-6 | 1,000,000 | 960,000 |
| claude-haiku-4-5 | 200,000 | 192,000 |
| (unknown) | 200,000 (safe default) | 192,000 |

The active model + window come from the gateway usage fields (`model` / `maxtokens`), so the
threshold adapts automatically; the map is only a fallback when the gateway doesn't report a window.

## Components in this folder

- `thresholds.mjs` - model->window map + `shouldHandover()` decision. Pure, unit-tested.
- `session-start-hook.mjs` - the Claude Code SessionStart hook. Pure stdin->stdout, unit-tested.
- `supervisor.mjs` - the poll/decide/act loop. **Skeleton**: usage source + rotate call are stubbed
  behind an interface and marked TODO until a live gateway confirms the exact endpoints/fields.
- handover storage lives in `../identity-service/db.mjs` (the shared erban store) as the `handovers` table.

## Self-contained install (everything under the erban root)

The agent gets its OWN Claude config home inside the install root - `<root>\claude` - via
`CLAUDE_CONFIG_DIR`, NOT the user's global `~/.claude`. The installer creates it (persistent, not
under `app\` which is wiped on reinstall), writes the SessionStart hook into `<root>\claude\settings.json`,
and sets `CLAUDE_CONFIG_DIR` in all three places `claude` is spawned so login + runtime + supervisor
agree: the gateway (`gateway.cmd`), the one-click sign-in (`launch-surface.ps1` before it starts the
identity helper, so `claude setup-token` writes here), and the supervisor (`erban-handover.cmd`). The
supervisor itself runs as the `OpenClaw Business Handover` scheduled task (observe-only by default).
This keeps Claude's settings/hooks/transcripts/login all inside erban - clean uninstall (delete the
root), and no pollution of the user's personal Claude setup.

## Open risks (need a live OpenClaw install to close)

- **R1 - hooks under OpenClaw's `claude -p`.** We now own the config dir and install the hook there, so
  this narrows to: confirm OpenClaw (a) passes `CLAUDE_CONFIG_DIR` through to the `claude` child and
  (b) does NOT spawn it with `--bare`, so our SessionStart hook actually fires. (gateway.cmd sets both
  `HOME` and `CLAUDE_CONFIG_DIR`, and the child inherits env, which is promising.)
- **R2 - force-rotate semantics.** Confirm `POST /v1/sessions/reset` (or the CLI equivalent) cleanly
  rotates the `claude` session id and yields a fresh `SessionStart` (source `startup`/`clear`) rather
  than a `--resume` of the old transcript.
- **R3 - usage field semantics.** Confirm whether `contextWeight` / `usage.totalTokens` is the running
  context size (what we want) vs per-turn, and which exact call returns it for the active session.
- **R4 - handover source.** Claude's transcript JSONL is version-fragile (don't parse in prod). Prefer a
  one-shot `claude -p --output-format json` summarisation pass, or OpenClaw `/export`, to build the doc.
