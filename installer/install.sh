#!/usr/bin/env bash
# Erban one-line installer (macOS / Linux).
#   curl -fsSL https://erban.xyz/install.sh | bash
#
# Sets up OpenClaw + the isolated read-only "erban" profile + gateway.
# NOTE: the corner-box GUI surface is Windows-only in this build. On macOS/Linux
# this gives you the same agent + Control UI via:  openclaw --profile erban dashboard
set -euo pipefail

BASE="https://erban.xyz"
ERBAN_HOME="$HOME/.erban"
APP="$ERBAN_HOME/app"
PROFILE_DIR="$HOME/.openclaw-erban"
PORT=18901

echo "[erban] installer starting"
mkdir -p "$ERBAN_HOME" "$PROFILE_DIR"

# 1. OpenClaw (installs Node too)
if ! command -v openclaw >/dev/null 2>&1; then
  echo "[erban] installing OpenClaw (also installs Node)..."
  curl -fsSL https://openclaw.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.openclaw/bin:$PATH"
fi
command -v openclaw >/dev/null 2>&1 || { echo "[erban] ERROR: openclaw not on PATH. Open a new shell and re-run."; exit 1; }
echo "[erban] OpenClaw: $(openclaw --version 2>&1 | head -n1)"
NODE="$(command -v node)"
echo "[erban] Node: $NODE"

# 2. Download + extract the Erban app bundle
echo "[erban] downloading app bundle..."
tmp="$(mktemp -d)"
curl -fsSL "$BASE/erban-assets.zip" -o "$tmp/erban-assets.zip"
rm -rf "$APP"; mkdir -p "$APP"
unzip -q "$tmp/erban-assets.zip" -d "$APP"
CRM="$APP/mcp/erban-crm/server.mjs"
WS="$APP/agent/workspace"
UI="$APP/surface/control-ui"

# 3. Write the isolated erban profile config
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
cat > "$PROFILE_DIR/openclaw.json" <<JSON
{
  "mcp": { "servers": { "erban-crm": { "command": "$NODE", "args": ["$CRM"] } } },
  "agents": { "defaults": {
    "workspace": "$WS",
    "models": {
      "anthropic/claude-opus-4-8": { "agentRuntime": { "id": "openclaw" } },
      "anthropic/claude-sonnet-4-6": { "agentRuntime": { "id": "openclaw" } }
    },
    "model": { "primary": "anthropic/claude-opus-4-8" }
  } },
  "gateway": { "mode": "local", "port": $PORT, "bind": "loopback",
    "auth": { "mode": "token", "token": "$TOKEN" },
    "controlUi": { "root": "$UI" } },
  "tools": { "profile": "minimal", "deny": ["session_status","message","file_write","file_fetch","dir_list","dir_fetch","memory_get","memory_search","memory_store","memory_forget","web_fetch","web_search","browser","process","shell","canvas","image"] },
  "plugins": { "entries": { "anthropic": { "enabled": true }, "file-transfer": { "enabled": false }, "memory-core": { "enabled": false } } }
}
JSON
echo "[erban] wrote erban profile config (gateway :$PORT, read-only tools)"

# 4. Start the gateway
echo "[erban] starting gateway on :$PORT..."
OPENCLAW_PROFILE=erban OPENCLAW_CONFIG_PATH="$PROFILE_DIR/openclaw.json" OPENCLAW_STATE_DIR="$PROFILE_DIR" \
  nohup openclaw --profile erban gateway --port "$PORT" >"$ERBAN_HOME/gateway.log" 2>&1 &

echo "[erban] INSTALL COMPLETE"
echo "[erban] open the assistant:  openclaw --profile erban dashboard"
echo "[erban] to let it reply, add a key: openclaw --profile erban models auth paste-token --provider anthropic"
echo "[erban] NOTE: the bottom-right corner box GUI is Windows-only in this build."
