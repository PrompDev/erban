// Model-aware handover thresholds (zero deps).
//
// We trigger a handover a little before a model's context window fills, so there's
// room to write the handover doc and rotate cleanly. The window is read live from
// OpenClaw's usage (`maxtokens`) when available; this map is only the fallback for
// when the gateway doesn't report one, and to sanity-check.

// Context windows as of 2026-06 (tokens). Keys are matched case-insensitively and
// by suffix, so both "anthropic/claude-opus-4-8" and "claude-opus-4-8" resolve.
export const CONTEXT_WINDOWS = {
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-fable-5': 1_000_000
}

export const DEFAULT_WINDOW = 200_000   // safe (small) default for unknown models
export const DEFAULT_RATIO = 0.96       // hand over at 96% full

// Resolve a model id (provider-prefixed or not) to its context window.
export function windowFor (model) {
  if (!model) return DEFAULT_WINDOW
  const id = String(model).toLowerCase()
  if (CONTEXT_WINDOWS[id]) return CONTEXT_WINDOWS[id]
  // Suffix match: "anthropic/claude-opus-4-8" -> "claude-opus-4-8"
  for (const key of Object.keys(CONTEXT_WINDOWS)) {
    if (id.endsWith(key)) return CONTEXT_WINDOWS[key]
  }
  return DEFAULT_WINDOW
}

// Decide whether to hand over. `maxTokens` (from live gateway usage) wins over the
// static map; `ratio` is the fill fraction at which we trigger.
// Returns { handover, window, threshold, usedRatio }.
export function shouldHandover ({ model, usedTokens, maxTokens, ratio = DEFAULT_RATIO }) {
  const window = Number(maxTokens) > 0 ? Number(maxTokens) : windowFor(model)
  const used = Number(usedTokens) || 0
  const threshold = Math.floor(window * ratio)
  return {
    handover: used >= threshold,
    window,
    threshold,
    usedRatio: window > 0 ? used / window : 0
  }
}
