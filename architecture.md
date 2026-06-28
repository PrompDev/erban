# Erban: Architecture Overview

> **Superseded note:** this is the original design. Several decisions here were changed by the red-team review. `CLAUDE.md` is the current authoritative build spec and `ERBAN-REDTEAM.md` holds the full findings; where this doc and CLAUDE.md disagree, CLAUDE.md wins. Changed since: window orchestration is dropped in favour of embedded panes, the secrets broker is adopted (Vault/SPIFFE) not built, cert pinning and Cloudflare-in-the-secret-path are removed, SMS is no longer a command channel, the bootstrap model is swapped off Qwen 3.5 0.8B and given no repair authority, and a guardrail/approval layer plus an Australian compliance workstream are added.

**Status:** Concept / pre-build
**Owner:** DeAndre (Clawdie)
**Built on:** OpenClaw agent framework

## The one-liner

A packaged, locked-down business automation product for non-technical owners (think plumbers, trades, small offices with a handful of staff). You boot the machine, one clean window opens, you type "start", and your whole operation comes to life: CRM, email, every tool you depend on, opened and positioned automatically, with an OpenClaw agent running your workflows. Every credential stays secure and nobody ever touches a config file.

What gets it all off the ground is a tiny local model, **Qwen 3.5 0.8B** (the smallest in the 3.5 small series), bundled straight into the install. Its only job is the setup step: get the gateway chat box open, parked in the bottom-right corner, and keep it alive. It never touches the env file and it is not the brain. Once that box is up, the real agents take over. It is the right pick because it was built from scratch to run small instead of being a chopped-down big model, so it stays sharp at tiny size, it runs fully offline and is light enough to sit on a phone, and it is open-weight, so no per-token fees and you can fine-tune it right down to that one job.

## Why it exists

OpenClaw is powerful but built for devs. The average owner of a 10-person trades business is never going to set up agents, manage env files, or wire up secure connections. Erban is the dumbed-down, secure-by-default layer that makes all of that invisible. They get the power of OpenClaw agents without needing to understand any of it.

Two products, clear split:

- **OpenClaw** stays the sophisticated, open framework for devs and the community.
- **Erban** is the commercial wrapper: pre-built agents, secure credential handling, support, and the polished boot-to-work experience.

## The experience we're building for

This is the dream sequence:

1. Owner walks into the office, turns on the computer.
2. The only thing that opens is a single clean window. No browser chrome, no address bar, no tabs. Just a box.
3. They type "start".
4. The OpenClaw gateway agent wakes up, reads its workflow config, and starts opening everything: CRM in one window, email in another, whatever else the business runs on, each restored to exactly where it was left off.
5. The agent positions windows intelligently and gets out of the way.
6. From there the agent runs the workflows the business depends on, and the owner can talk to it (including over SMS).

That is the whole pitch in one picture. No distractions, no setup, no IT person needed.

## Core components

### 1. The Gateway (headless Chrome kiosk)

The entry point. A Chrome instance launched in kiosk mode (`--kiosk`), so there is no header, no address bar, no tabs, no way to wander off. It is just the OpenClaw gateway UI living in a borderless box.

Important distinction: the kiosk is *only* for the gateway itself. Everything else (CRM, email, and so on) opens in its own separate windows. The gateway is the control surface, not the container for everything.

### 2. Window orchestration

The agent acts as a window manager, not just a logic layer. It opens, sizes, moves, and arranges app windows on the fly.

The mental model is a streamer managing their webcam overlay: they constantly nudge the camera so it never covers anything important on screen. The agent should do the same with windows, shuffling them into the most useful layout for whatever task is happening, and tucking the gateway into a spare corner when it is not needed.

Open question for later: cross-platform window management is messy. Windows, macOS, and Linux all handle window positioning differently, so this needs a per-OS strategy.

### 3. Secrets broker (credential distribution)

The security backbone, and the bit that makes the whole thing safe to deploy.

The setup:

- The owner's machine holds the master env file with every company credential (Facebook page, CRM, email, and so on).
- That file never goes on the network. Ever.
- Each staff machine runs an OpenClaw agent that needs to log into things, but it never sees the full env file.
- Instead, the agent asks a secrets broker daemon (running on the owner's machine) for one specific credential by name, for example "give me the Facebook password".
- The broker checks the agent is allowed, then hands back just that one secret over an encrypted channel.

The key idea you landed on: agents request secrets by name, they never read the file itself. If we want, the broker can work off a reference (a title pointing to a location) rather than exposing the raw value, with a cryptographic handshake on every request that gets logged.

### 4. Local inference engine (the bootstrap launcher)

A tiny quantized model bundled right into the install package. The lighter the better, ideally light enough to run on a phone.

Its only job is to get the gateway up and keep it there: open the gateway chat box, position it in the bottom-right corner, and make sure it stays alive (relaunch if it dies). That is the whole task. It does not touch the env file, it is not the brain, and it does not run any workflows. The moment the chat box is live, the real agents take over.

Worth being straight about the scope: opening a window at fixed coordinates and keeping a process alive is deterministic plumbing, the kind of thing a watchdog script does more reliably than any model. Where the 0.8B earns its place is adapting to whatever machine the installer lands on: unknown screen size, unknown OS or window manager, working out the right window command and the correct bottom-right coordinates for that box. So the model is the adaptive launcher sitting on top of a dumb relaunch-if-dead watchdog underneath.

So why keep a model for this at all, rather than just the watchdog? Because the watchdog is frozen at the one job it was coded for. The 0.8B is a beachhead: the first piece of local intelligence on the machine. Once it sits there cheap enough to leave running, you can retune it to take on more than the launch (recovering from novel failures, walking a user through a broken install, adapting as you add new apps and operating systems) without shipping new brittle scripts every time. The launch is just its first job. This is the prepare-for-the-worst call: a single-purpose script handles only the cases you anticipated, a small local model can reason through the ones you did not, with the dumb watchdog underneath as the guaranteed floor if the model ever stalls. Official design is the split, not pure-model and not pure-script.

One bound on that, so we do not over-scope it the way a launcher should never be: the 0.8B grows into the always-on "keep the lights on locally" layer (launch, recover, diagnose, talk to the user when offline). Anything heavy still routes to the real agents. It is the resilient local floor, not a second brain.

The whole bet rests on compute, and the rule that keeps it cheap is simple: the model is only ever active during boot or a repair. Dormant the rest of the time, unloaded, zero RAM and zero compute at idle. That makes it event-driven and load-on-demand, not resident-hot.

How that rule actually holds: the always-on watchdog is the cheap heartbeat loop, and the instant the window dies it does a dumb relaunch with no model involved. Only if that relaunch keeps failing (repeated crashes, something a plain restart cannot fix) does it escalate and load the 0.8B to diagnose and repair. So a normal boot wakes the model once, a one-off crash never wakes it at all, and a real fault is the only thing that pulls it in mid-session. After it is done, it unloads again.

Footprint target: a Q4 GGUF build, roughly half a gig on disk and comfortably under a gig of RAM while loaded, on llama.cpp or Ollama for desktop and an ONNX-style runtime for mobile. Because it is dormant by default, the size only costs you at load time, and a model this small cold-starts in a second or two at most.

- Model: **Qwen 3.5 0.8B**, the smallest in the Qwen 3.5 small series (sizes go 0.8B / 2B / 4B / 9B). Built ground-up for on-device use rather than distilled down from a big model, runs offline on a phone, and tuned for agent and tool-use workflows. Quantize it hard (INT4 or lower) and it runs on a potato. Open-weight, so no per-token fees and you can fine-tune it to the one narrow task. If 0.8B turns out too light for reliable bootstrap, the 2B is the next step up and still tiny.
- Packaging: one npm install that pulls in whatever it needs (Docker container, Ollama, whatever the cleanest runtime is) and gets the model running, then the model kicks off the program.
- We do not care about the exact runtime mechanism, we just want: install, model runs, model starts the gateway.

If we end up needing two or three different bootstrap agents on that one tiny model, each can be fine-tuned for a different task, but they are never allowed to run at the same time. Strictly one at a time.

### 5. Agent orchestration (serial, fine-tuned)

Beyond bootstrap, the real work is done by fine-tuned task agents:

- Agent A: CRM orchestrator
- Agent B: email handler
- Agent C: whatever the business needs

Only one runs at a time, picked off a task queue. This keeps the memory footprint tiny and behaviour predictable. No agents stepping on each other.

### 6. SMS connectivity

The owner can talk to their agent over SMS. This is an owner-only privilege.

Two tiers worth considering:

- **Owner machine:** connected to SMS, holds the env file and the secrets broker. Full control.
- **Staff machines:** a more locked-down version that is *not* connected to the owner's machine env file directly, and not wired to SMS. More secure by default, less privileged.

### 7. State persistence and recovery

If a machine crashes mid-workflow, the agent needs to resume where it left off, not start from scratch. For a working business that matters.

- Lightweight local state store: SQLite with atomic writes, or Redis locally.
- Windows restore to their last position, workflows pick up mid-step, context survives a reboot.

### 8. Audit and logging

Two layers:

- **Secrets access:** who requested what credential, when, and from where. Already core to the broker.
- **Agent actions:** what each agent did. Not for surveillance, but so when something breaks you can debug it, and so the business can show compliance if asked.

## Security model by deployment type

The same broker pattern scales across very different environments.

**Local network (single office):**
mTLS. Each agent gets a client certificate signed by a CA you control. The broker only releases a secret if the cert checks out. Fast, no real network overhead, hard to beat.

**Distributed offices (multiple buildings, different cities or countries):**
Same mTLS, but the broker now needs to be reachable from outside. Put it behind a reverse proxy with certificate pinning so agents pin the server cert and a man-in-the-middle attack cannot work. Cloudflare Tunnel is a clean fit here: encrypted tunnel back to the origin, and you control exactly who connects via client certs.

**Government-grade / hostile networks:**
Everything above, plus:

- Full audit logging of every secret access.
- Regular credential rotation.
- Rate limiting and anomaly detection. If an agent starts asking for secrets it has no business requesting, flag it.
- Token revocation: if a token leaks, rotate it without ever touching the master env file.

## The big open decision

Build the moat, or build the movement.

**Option A, keep it commercial:** Erban is your product, the architecture is your edge, you sell the packaged solution.

**Option B, open-source the core:** put the bootstrap architecture and orchestration framework on GitHub, get it in front of OpenClaw, let people fork and contribute, maybe get it merged via PR. Stars, credibility, possibly free tokens for the project.

Leaning recommendation from our chat:

- Open-source the core bootstrap and orchestration framework. That is the credibility play and the community signal.
- Keep Erban as the commercial wrapper: hosted secrets broker, pre-built fine-tuned agents for trades, support, compliance. You are not selling the tech, you are selling the done-for-you solution.
- You get the GitHub stars and the OpenClaw goodwill, and the money comes from people who would rather pay you than self-host.

You have a direct line to push a PR into OpenClaw if it is good enough, which makes Option B a real choice rather than wishful thinking.

## What's next

This doc is the plain-language version. Next step is to dive into the code, component by component. Suggested build order:

1. Secrets broker (the foundation everything else trusts).
2. Local inference engine and npm install package (the bootstrap).
3. Gateway in kiosk mode.
4. Window orchestration.
5. Agent queue and fine-tuned task agents.
6. State persistence.
7. SMS layer.
8. Audit logging woven through all of it.
