# Erban: Build Spec (v2, post red-team)

Read this before writing code. This supersedes earlier decisions. Where it conflicts with `docs/architecture.md`, this wins. `docs/architecture.md` is the original design; `ERBAN-REDTEAM.md` holds the full review.

## The product, in one line

A one-line install that gives a non-technical business owner (trades, small office) one clean surface where their tools just get done: their CRM, inbox and other tools live in one owned window, and an agent runs the routine work, with a hard approval gate before anything irreversible. Built on OpenClaw (MIT).

## Two moves everything hinges on

1. **Actuate through APIs / MCP, not GUI pixels.** Drive integrations through their APIs, MCP servers, or DOM/accessibility selectors. Fall back to GUI automation only for tools with no API at all (the trades long tail, e.g. Tapi). This removes the OS-window walls, the MFA/ToS blocks, and most of the resume-corruption risk in one move.
2. **A guardrail / approval layer before any agent takes an irreversible action.** No autonomous send, delete, post or pay. Classify by blast radius, preview and confirm the dangerous ones, make ops reversible, and wall ingested content off from instructions.

If a design choice fights either of these, it is wrong.

## What OpenClaw gives us (don't rebuild)

- Its own installer. macOS/Linux: `curl -fsSL https://openclaw.ai/install.sh | bash`. Windows: `iwr -useb https://openclaw.ai/install.ps1 | iex`. Installs Node and everything else.
- Onboarding: `openclaw onboard --install-daemon` (provider + API key + Gateway; installs the Gateway as a launchd/systemd/Scheduled Task service).
- Gateway on port 18789; `openclaw dashboard` opens the Control UI. Custom UI via `gateway.controlUi.root`.
- Health: `openclaw --version`, `openclaw doctor`, `openclaw gateway status`. Runtime: Node 24 (22.19+ ok).
- Treat all inbound channel content as untrusted.
- Pin and vendor a specific OpenClaw version. It is young and security-weak by default. Keep a fallback in mind (LangGraph / n8n / Cloudflare Agents SDK) but do not build it yet.
- Do not quote OpenClaw star counts or any CVE as fact; the hype metrics look inflated and the cited CVE is unverified.

So Erban is a thin wrapper plus a trades-specific policy and workflow layer. We do not build an agent runtime, a Gateway, a chat UI, a secrets store, or a durable-execution engine from scratch.

## The corner surface (was the "kiosk window")

One owned window (chromeless Chrome `--app`, or a Tauri/WebView shell) that holds:
- the OpenClaw Control UI as a chat-and-status pane, and
- embedded panes / tabs / PWAs for the business tools, which is what delivers the "one clean window" promise, better than free-floating windows ever could.

`--kiosk` is cosmetic only (Alt+F4 / DevTools escape it). It was never the security boundary; the broker and the approval layer are.

**Window orchestration is parked, not built.** Absolute placement of other apps' windows is impossible on Wayland (your own Deck), consent-gated on macOS, and blocked for elevated apps on Windows. Embedded panes replace it. If native-window tidying ever comes back, it is a Windows/X11-only flourish, never on the action path, and explicitly unsupported on Wayland and sandboxed macOS.

## Build order (revised: the old order started with the riskiest from-scratch piece)

1. **API/MCP actuation for one real integration**, with the corner surface as a chat-and-status pane. Demoable on Windows, single machine. Read and draft only.
2. **Guardrail + content-trust layer** before any acting agent. Blast-radius classes; confirm/preview on send/delete/post/pay; reversible ops (soft-delete, drafts, scheduled-send window); strict separation of ingested content from instructions so injected text cannot impersonate the owner; anomaly rate-limit; kill-switch.
3. **Durable execution** for anything with side effects: Cloudflare Workflows + Durable Objects (already your stack). Reconcile-first, never replay-first. Write-ahead journal (intended, issued, confirmed) per side-effecting step; never auto-replay an "issued" step; on resume read the target system's authoritative state; idempotency keys wherever actuation is API-based.
4. **Packaging + bootstrap.** Ship a single statically-linked, checksum-verified binary (llama.cpp / GGUF) in the installer, not an npm install that pulls Docker/Ollama (that fails on locked-down trades machines and contradicts the on-device story). For launch geometry, prefer a per-OS lookup table over a model. If a local model is kept, use a plain dense sub-1B (Gemma 3 1B, Llama 3.2 1B, or Qwen3-0.6B/1.7B), not Qwen 3.5 0.8B (it is a multimodal MoE + vision hybrid, heavy and awkward to port). The bootstrap model gets no repair authority: recovery is deterministic idempotent playbooks; the model is read-only describe/draft behind a confirm. Footprint claims (sub-1GB RAM, 1-2s cold start) are unverified, so do not promise them.
5. **Business / multi-machine layer.** Adopt OpenBao/Vault + SPIFFE/SPIRE for secrets; build only the agent-identity to allowed-secret-name authorization policy. No cert pinning (OWASP-discouraged, fights rotation). Keep Cloudflare out of the secret path, or end-to-end encrypt so the edge only sees ciphertext; prefer direct mTLS or a WireGuard/Tailscale overlay. Master key material in TPM-bound storage; separate the CA off the owner box. The owner laptop is currently a single point of total compromise; write the "what if this box is popped" threat model before using the words "secure by default".
6. **Authenticated control channel.** Drop SMS as a command channel (sender-ID is spoofable, SIM-swappable, and it was wired to the most privileged node). Use an authenticated OpenClaw channel (Telegram/Signal) or a device-bound passkey, a minimal command grammar (status / pause / resume / approve), every state-changing command routed through step 2, plus a kill-switch. SMS, if kept at all, is read-only notifications.

## Cross-cutting, from the start

- **Cost control.** "No per-token fees" covers only the bootstrap. The capable model doing real work costs real money, and a runaway loop is a four-figure surprise the owner cannot see. Spend caps, a cost model, and alerts.
- **Compliance (Australian; not a footnote, and get a real lawyer).** Privacy Act 1988 and the APPs plus the Notifiable Data Breaches scheme once client customer-PII sits on the machine; Spam Act 2003 and ACMA for any agent-to-customer email or SMS (consent plus a working unsubscribe, real penalties); Australian Consumer Law plus professional-indemnity / E&O insurance for when the agent gets it wrong; bot-disclosure (no AU statute yet, but it bites for EU/California customers and is coming). Plus a signed-update / supply-chain pipeline to push fixes to the fleet, backup/DR, and a staging path so agents do not validate against live customer data on first run.
- **Operator + distribution model.** Decide before GTM: appliance / provisioned image, or MSP channel. Open question is whether vendor-borne setup and support margins close at trades-SMB ARPU; model it before committing to self-serve pricing.

## Settled, do NOT re-litigate (the steel-man already killed these critiques)

- The watchdog is fine: liveness is deterministic and model-free, the model is out of the hot path.
- Request-by-name with least-privilege, rotation and anomaly detection is the right posture; we never claimed reference-vs-raw-value was the security property.
- Serial bootstrap is not a liveness SPOF (liveness is model-free).
- Open-core is the right monetization, and the moat is the done-for-you trades packaging, not novel tech. Build the thin trades-specific policy and workflows, not the infra under them.

## MVP acceptance (this phase)

One real integration actuated via its API/MCP, surfaced in the corner pane, with the agent able to read and draft but with no path to send/delete/post/pay. Runs on Windows, single machine. The guardrail layer (step 2) is the gate that later unlocks acting.

## Conventions

- User-facing copy: casual, direct, plain Australian English. No em-dashes, no AI filler.
- Idempotent, re-runnable installers; lean on `openclaw doctor`-style checks.
- Don't reimplement what you can call through OpenClaw's CLI or a vendor API.
