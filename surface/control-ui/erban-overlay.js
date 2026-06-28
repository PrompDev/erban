/* Erban Business surface overlay - first-run naming + UI cleanup + reset.
   Served only by the Erban OpenClaw gateway (gateway.controlUi.root).
   No LLM calls. Read-and-draft is unchanged.

   Name persistence: the workspace (via the identity helper) is the SOURCE OF TRUTH;
   localStorage is a fast UI cache. */
(function () {
  "use strict";
  var NAME_KEY = "erban.assistantName";
  var FALLBACK = "Assistant";
  var HELPER_WS = "ws://127.0.0.1:8766";
  var currentName = null;

  // Capture the launch epoch (?erbanT0=) at script-load time, BEFORE the SPA router can
  // rewrite the URL and drop the query string. Used by the debug timer badge below.
  var LAUNCH_T0 = (function () {
    try { var v = parseInt(new URLSearchParams(location.search).get("erbanT0"), 10); return v > 0 ? v : 0; }
    catch (e) { return 0; }
  })();

  function getLocal() { try { return localStorage.getItem(NAME_KEY) || null; } catch (e) { return null; } }
  function setLocal(n) { try { localStorage.setItem(NAME_KEY, n); } catch (e) {} }
  function clearLocal() { try { localStorage.removeItem(NAME_KEY); } catch (e) {} }

  // The Control UI CSP blocks cross-origin HTTP but allows the ws: scheme, so the
  // identity helper is reached over a WebSocket request/response.
  var _ws = null, _wsReady = null, _pending = {}, _reqId = 0;
  function ensureWs() {
    if (_wsReady) return _wsReady;
    _wsReady = new Promise(function (resolve, reject) {
      var sock;
      try { sock = new WebSocket(HELPER_WS); } catch (e) { reject(e); return; }
      var settled = false;
      sock.onopen = function () { _ws = sock; settled = true; resolve(sock); };
      sock.onmessage = function (ev) { try { var m = JSON.parse(ev.data); if (m && m.id && _pending[m.id]) { _pending[m.id](m); delete _pending[m.id]; } } catch (e) {} };
      sock.onerror = function () { if (!settled) reject(new Error("ws error")); };
      sock.onclose = function () { _ws = null; _wsReady = null; };
      setTimeout(function () { if (!settled) reject(new Error("ws timeout")); }, 3000);
    });
    return _wsReady;
  }
  function rpc(action, name) {
    return ensureWs().then(function (sock) {
      return new Promise(function (resolve) {
        var id = ++_reqId; _pending[id] = resolve;
        sock.send(JSON.stringify({ id: id, action: action, name: name }));
        setTimeout(function () { if (_pending[id]) { delete _pending[id]; resolve(undefined); } }, 4000);
      });
    }).catch(function () { return undefined; });
  }
  function helperGet() { return rpc("get").then(function (r) { return r === undefined ? undefined : (r.ok ? (r.name || null) : null); }); }
  function helperSet(name) { return rpc("set", name).then(function (r) { return !!(r && r.ok); }); }
  function helperReset() { return rpc("reset").then(function (r) { return !!(r && r.ok); }); }

  /* Generic helper call: sends {id, ...payload} over the same ws and resolves the reply
     (or undefined on timeout/error). Used for the provider sign-in actions, which carry
     fields beyond {action,name}. Sign-in OAuth can take a while, so the per-call timeout
     is longer than the name RPCs. */
  function call(payload) {
    return ensureWs().then(function (sock) {
      return new Promise(function (resolve) {
        var id = ++_reqId; _pending[id] = resolve;
        var msg = { id: id }; for (var k in payload) { if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k]; }
        sock.send(JSON.stringify(msg));
        setTimeout(function () { if (_pending[id]) { delete _pending[id]; resolve(undefined); } }, 8000);
      });
    }).catch(function () { return undefined; });
  }
  function providerGet() { return call({ action: "provider-get" }); }
  function signinStart(provider) { return call({ action: "signin-start", provider: provider }); }
  function signinStatus() { return call({ action: "signin-status" }); }

  /* (4) Rename sweep: OpenClaw Control -> OpenClaw Business; bare Control -> Business. */
  function rebrand() {
    try {
      if (document.title !== "OpenClaw Business") document.title = "OpenClaw Business";
      document.querySelectorAll(".dashboard-header__breadcrumb-link").forEach(function (a) {
        if (a.textContent.trim() === "OpenClaw") a.textContent = "OpenClaw Business";
      });
      document.querySelectorAll(".sidebar-brand__eyebrow").forEach(function (e) {
        if (/control/i.test(e.textContent)) e.textContent = "Business";
      });
      document.querySelectorAll(".nav-section__label-text").forEach(function (e) {
        if (e.textContent.trim().toLowerCase() === "control") e.textContent = "Business";
      });
      document.querySelectorAll("h1,p,span,a,button").forEach(function (e) {
        if (e.children.length === 0 && (/OpenClaw Control/i.test(e.textContent) || /Control UI/i.test(e.textContent))) {
          e.textContent = e.textContent.replace(/OpenClaw Control/gi, "OpenClaw Business").replace(/Control UI/gi, "Business UI");
        }
      });
    } catch (e) {}
  }

  /* (2) Show the saved name everywhere the UI says "Assistant". */
  function applyName() {
    try {
      var nm = currentName || FALLBACK;
      // sender labels (explicit) + any leaf in the chat main area that reads exactly "Assistant"
      // (covers the message sender labels AND the centre empty-state welcome <h2>).
      var nodes = document.querySelectorAll(".chat-group.assistant .chat-sender-name, main *, .agent-chat__welcome *");
      nodes.forEach(function (el) {
        if (el.children.length === 0 && el.textContent.trim() === "Assistant") el.textContent = nm;
      });
      // input placeholder "Message Assistant" -> "Message <name>"
      document.querySelectorAll("textarea").forEach(function (ta) {
        if (ta.placeholder && /Message Assistant/i.test(ta.placeholder)) ta.placeholder = ta.placeholder.replace(/Assistant/i, nm);
      });
    } catch (e) {}
  }

  function applyAll() { rebrand(); applyName(); }

  /* (1) First-run screen (no LLM): name the assistant, then one-click sign in to a model
     provider. Sign-in is delegated to the local helper (provider-auth.mjs), which runs the
     provider CLI login, points the erban profile at that backend, applies the read-and-draft
     gate, restarts the gateway and verifies. Only providers the helper reports as supported
     are clickable; the rest render disabled with a "soon" tag. */
  var PROVIDER_LABELS = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini" };
  var PROVIDER_ORDER = ["claude", "chatgpt", "gemini"];

  function showFirstRun() {
    if (document.getElementById("erban-firstrun")) return;
    var ov = document.createElement("div");
    ov.id = "erban-firstrun";
    ov.innerHTML =
      '<div class="erban-fr-card">' +
        '<img class="erban-fr-logo" src="/favicon.svg" alt="OpenClaw Business" />' +
        '<h1 class="erban-fr-title">What should you call me?</h1>' +
        '<p class="erban-fr-sub">Give your assistant a name, then sign in to finish setup.</p>' +
        '<input id="erban-fr-input" class="erban-fr-input" type="text" maxlength="40" autocomplete="off" placeholder="e.g. Ros, Mate, Banksy" />' +
        '<div class="erban-fr-or">Sign in to finish</div>' +
        '<div class="erban-fr-providers" id="erban-fr-providers"></div>' +
        '<button id="erban-fr-go" class="erban-fr-btn" hidden>Start</button>' +
        '<p id="erban-fr-status" class="erban-fr-status"></p>' +
      "</div>";
    document.body.appendChild(ov);
    var input = ov.querySelector("#erban-fr-input");
    var provWrap = ov.querySelector("#erban-fr-providers");
    var go = ov.querySelector("#erban-fr-go");
    var status = ov.querySelector("#erban-fr-status");
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
    var busy = false;

    function setStatus(msg) { status.textContent = msg || ""; }

    function buildButtons(providers) {
      var byId = {}; (providers || []).forEach(function (p) { byId[p.id] = p; });
      provWrap.innerHTML = "";
      PROVIDER_ORDER.forEach(function (pid) {
        var meta = byId[pid] || { id: pid, label: PROVIDER_LABELS[pid] || pid, supported: pid === "claude", reason: null };
        var b = document.createElement("button");
        b.type = "button";
        b.className = "erban-fr-prov";
        b.setAttribute("data-provider", pid);
        b.innerHTML =
          '<span class="erban-fr-prov-dot"></span>' +
          '<span class="erban-fr-prov-label">Sign in with ' + (meta.label || pid) + "</span>" +
          (meta.supported ? "" : '<span class="erban-fr-prov-tag">soon</span>');
        if (!meta.supported) {
          b.disabled = true; b.classList.add("is-soon");
          if (meta.reason) b.title = meta.reason;
        } else {
          b.addEventListener("click", function () { onSignin(pid, b); });
        }
        provWrap.appendChild(b);
      });
    }

    function lockButtons(lock) {
      provWrap.querySelectorAll(".erban-fr-prov").forEach(function (el) {
        if (el.classList.contains("is-soon") || el.classList.contains("is-done")) return;
        el.disabled = lock;
      });
    }

    function onSignin(provider, btn) {
      if (busy) return;
      var name = (input.value || "").trim();
      if (!name) { setStatus("Type a name first."); try { input.focus(); } catch (e) {} return; }
      busy = true;
      setLocal(name); helperSet(name); // persist the name (best-effort) before sign-in
      lockButtons(true);
      btn.classList.add("is-working");
      setStatus("Opening your browser to sign in with " + (PROVIDER_LABELS[provider] || provider) + "…");
      signinStart(provider).then(function (r) {
        if (!r || !r.ok) return failSignin(btn, (r && r.error) || "Could not start sign-in.");
        if (r.status === "unsupported" || r.status === "error") return failSignin(btn, r.error || "Not available yet.");
        pollSignin(provider, btn);
      });
    }

    function pollSignin(provider, btn) {
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        signinStatus().then(function (s) {
          if (!s) return; // transient ws miss; keep polling
          if (s.status === "ready") {
            clearInterval(iv);
            btn.classList.remove("is-working"); btn.classList.add("is-done");
            var lbl = btn.querySelector(".erban-fr-prov-label");
            if (lbl) lbl.textContent = "Signed in with " + (PROVIDER_LABELS[provider] || provider);
            currentName = (input.value || "").trim();
            setStatus("Signed in. You're ready.");
            go.hidden = false; try { go.focus(); } catch (e) {}
          } else if (s.status === "error" || s.status === "unsupported") {
            clearInterval(iv); failSignin(btn, s.error || "Sign-in failed.");
          } else if (s.step) {
            setStatus("Signing in… (" + s.step + ")");
          }
          if (tries > 240) { clearInterval(iv); failSignin(btn, "Sign-in timed out."); }
        });
      }, 1500);
    }

    function failSignin(btn, msg) {
      busy = false;
      btn.classList.remove("is-working");
      setStatus(msg);
      lockButtons(false);
    }

    function finish() { if (ov.parentNode) ov.parentNode.removeChild(ov); applyAll(); }
    go.addEventListener("click", finish);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") e.preventDefault(); });

    buildButtons(null); // optimistic default (Claude enabled) until the helper reports
    providerGet().then(function (r) { if (r && r.ok && r.providers) buildButtons(r.providers); });
  }

  /* (3) Reset / rename control: clears workspace + cache, then re-triggers first-run. */
  function addResetControl() {
    if (document.getElementById("erban-reset")) return;
    var btn = document.createElement("button");
    btn.id = "erban-reset";
    btn.type = "button";
    btn.title = "Clear the assistant's name and run first-run setup again";
    btn.textContent = "↺ Rename";
    btn.addEventListener("click", function () {
      if (!window.confirm("Clear the assistant's name and run first-run setup again?")) return;
      clearLocal();
      helperReset().then(function () { location.reload(); });
    });
    document.body.appendChild(btn);
  }

  /* Debug timer: the launcher passes ?erbanT0=<epoch ms> (the moment the pin was clicked).
     Show a small red pill with the click->ready latency so "is it instant?" is measurable. */
  function showDebugTimer() {
    try {
      var t0 = LAUNCH_T0;
      if (!t0) return;
      var ms = Date.now() - t0;
      var badge = document.getElementById("erban-debug-timer");
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "erban-debug-timer";
        badge.title = "Time from pin click to window ready. Click to dismiss.";
        badge.style.cssText =
          "position:fixed;left:8px;bottom:8px;z-index:2147483647;" +
          "font:600 11px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;" +
          "background:rgba(196,42,42,.93);padding:3px 9px;border-radius:999px;" +
          "box-shadow:0 1px 5px rgba(0,0,0,.45);cursor:pointer;transition:opacity .6s;user-select:none;";
        badge.addEventListener("click", function () { if (badge.parentNode) badge.parentNode.removeChild(badge); });
        document.body.appendChild(badge);
      }
      badge.textContent = "⏱ ready in " + (ms / 1000).toFixed(1) + "s";
      setTimeout(function () { if (badge) badge.style.opacity = "0"; }, 6000);
      setTimeout(function () { if (badge && badge.parentNode) badge.parentNode.removeChild(badge); }, 7000);
    } catch (e) {}
  }

  var scheduled = false;
  function schedule() { if (scheduled) return; scheduled = true; requestAnimationFrame(function () { scheduled = false; applyAll(); }); }

  function boot() {
    applyAll();
    showDebugTimer();
    addResetControl();
    // Setup is complete only when the assistant is named AND a model provider is signed in.
    // Fetch both the name (workspace = source of truth) and the active-provider marker.
    Promise.all([helperGet(), providerGet()]).then(function (res) {
      var serverName = res[0];           // string | null | undefined(helper down)
      var prov = res[1];                 // {ok, active, providers} | undefined
      var active = (prov && prov.ok) ? prov.active : null;
      var name = serverName || getLocal() || null;
      if (name) { currentName = name; applyAll(); }
      if (name && active) {
        // Already configured. If the name only lived in the cache, sync it to the workspace.
        if (!serverName && getLocal()) helperSet(getLocal());
      } else {
        showFirstRun();
      }
    });
    try { new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
