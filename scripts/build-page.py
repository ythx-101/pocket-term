#!/usr/bin/env python3
"""pocket-term build-page.py — Inject mobile enhancements into ttyd HTML.

Locks to ttyd 1.6.3 HTML by fingerprint anchors. Refuses to inject if the
page structure doesn't match (failsafe: returns bare page on mismatch).

# Portability notes for the original fork commits (commit hashes preserved for provenance):
  - 26ed912: SIGWINCH repaint via terminal.refresh() on tab return
  - a4882ee: dark <head> background to kill white flash on cold reload
  - 0fd1b41: >5min hidden auto-refresh, file upload to terminal
  - 6a397b7: tiered renderer recovery after >10s hidden

Usage:
  python3 build-page.py \\
    --index-src /path/to/index-orig.html \\
    --output /path/to/index.html \\
    [--lang en|zh] \\
    [--with-upload] \\
    [--theme light|dark]

Author: pocket-term contributors
License: MIT
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# ── i18n dictionary ────────────────────────────────────────────────────
I18N = {
    "en": {
        "connecting": "Connecting\u2026",
        "connected": "Connected",
        "disconnected": "Connection lost \u2014 tap to reconnect",
        "offline": "Offline \u2014 waiting for network\u2026",
        "auth": "Session expired \u2014 refresh to re-login",
        "error": "Connection check failed \u2014 refresh",
        "timeout": "Terminal init timeout \u2014 refresh",
        "ended": "Terminal ended \u2014 refresh for new session",
        "recovering": "Network restored \u2014 checking\u2026",
        "shortcuts": "Shortcuts",
        "cjkInput": "IME",
        "upload": "Upload",
        "tools": "Tools",
        "send": "Send",
        "inputPlaceholder": "Type command or IME text\u2026",
        "latest": "\u2193 Latest",
        "uploadOk": "Uploaded {} file(s), path(s) pasted",
        "uploadFail": "Upload failed: {}",
        "sendFail": "Send failed: {}",
    },
    "zh": {
        "connecting": "\u6b63\u5728\u8fde\u63a5\u2026",
        "connected": "\u5df2\u8fde\u63a5",
        "disconnected": "\u8fde\u63a5\u5df2\u65ad\u5f00\uff0c\u70b9\u51fb\u63d0\u793a\u91cd\u8fde",
        "offline": "\u7f51\u7edc\u79bb\u7ebf\uff0c\u7b49\u5f85\u6062\u590d\u2026",
        "auth": "\u767b\u5f55\u5df2\u8fc7\u671f\uff0c\u8bf7\u5237\u65b0\u6216\u91cd\u65b0\u767b\u5f55",
        "error": "\u8fde\u63a5\u68c0\u67e5\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u5237\u65b0",
        "timeout": "\u7ec8\u7aef\u521d\u59cb\u5316\u8d85\u65f6\uff0c\u8bf7\u5237\u65b0\u9875\u9762",
        "ended": "\u7ec8\u7aef\u5df2\u7ed3\u675f\uff0c\u8bf7\u5237\u65b0\u9875\u9762",
        "recovering": "\u7f51\u7edc\u5df2\u6062\u590d\uff0c\u6b63\u5728\u68c0\u67e5\u2026",
        "shortcuts": "\u5feb\u6377\u952e",
        "cjkInput": "\u4e2d\u6587\u8f93\u5165",
        "upload": "\u4e0a\u4f20",
        "tools": "\u5de5\u5177",
        "send": "\u53d1\u9001",
        "inputPlaceholder": "\u8f93\u5165\u4e2d\u6587\u6216\u547d\u4ee4\u2026",
        "latest": "\u2193 \u6700\u65b0",
        "uploadOk": "\u5df2\u4e0a\u4f20 {} \u4e2a\u6587\u4ef6\uff0c\u8def\u5f84\u5df2\u653e\u5165\u7ec8\u7aef",
        "uploadFail": "\u4e0a\u4f20\u5931\u8d25\uff1a{}",
        "sendFail": "\u53d1\u9001\u5931\u8d25\uff1a{}",
    },
}

# ── Anchors that MUST be present for ttyd 1.6.3 ────────────────────────
# If any of these regexps fail, the injector refuses and returns bare page.
V163_ANCHORS = [
    (r'<meta\s+charset="UTF-8"', "UTF-8 meta tag"),
    (r"<body>", "body open tag"),
    (r"</body>\s*</html>", "body+html close tags"),
    # ttyd 1.6.3 client JS markers (survive minification)
    (r"\[ttyd\]", "ttyd console log prefix"),
    (r"window\.term", "window.term global"),
    (r"WebSocket", "WebSocket usage"),
]

# ── Anchors for experimental 1.7.x detection (not same as 1.6.3) ───────
V17X_INDICATORS = [
    # ttyd 1.7.x ships xterm.js 5.x with addon-based API
    (r"xterm-addon-", "xterm.js addon (1.7.x indicator)"),
    (r"import\s*\{.*\}\s*from\s*[\"']xterm", "ESM import (1.7.x indicator)"),
]


def _make_viewport(args: argparse.Namespace) -> str:
    theme_color = "#191724" if args.theme == "dark" else "#e1e2e7"
    color_scheme = "dark" if args.theme == "dark" else "light"
    return (
        '<meta name="viewport" content="width=device-width, initial-scale=1.0, '
        "maximum-scale=1.0, user-scalable=no, viewport-fit=cover\">"
        f'<meta name="theme-color" content="{theme_color}">'
        f'<meta name="color-scheme" content="{color_scheme}">'
        f"<style>html,body{{background:{theme_color};}}</style>"
    )


def _make_early_script(args: argparse.Namespace) -> str:
    """Generate the early-loading status/connection monitor script (run before xterm)."""
    t = I18N[args.lang]
    return f"""<script id="ttyd-mobile-early">
(function () {{
  "use strict";
  var status = window.__ttydMobileStatus = window.__ttydMobileStatus || {{}};
  status.state = "connecting";
  status.startedAt = Date.now();

  function capsule() {{
    var el = document.getElementById("tm-status");
    if (el) return el;
    el = document.createElement("div");
    el.id = "tm-status";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.style.cssText = "position:fixed;top:calc(10px + env(safe-area-inset-top));left:calc(10px + env(safe-area-inset-left));z-index:100001;display:none;max-width:calc(100vw - 88px);padding:7px 10px;border:1px solid #403d52;border-radius:999px;background:rgba(31,29,46,.96);color:#e0def4;font:600 12px/1.2 -apple-system,system-ui,Segoe UI,monospace;box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer;";
    (document.body || document.documentElement).appendChild(el);
    return el;
  }}
  function show(text, state) {{
    status.state = state || status.state;
    status.text = text;
    var el = capsule();
    el.textContent = text;
    el.style.display = "block";
    el.style.color = status.state === "connected" ? "#287a45" : "#a14d00";
    el.style.borderColor = status.state === "connected" ? "#5b9b70" : "#b77a39";
    clearTimeout(status.hideTimer);
    if (status.state === "connected") {{
      status.hideTimer = setTimeout(function () {{ el.style.display = "none"; }}, 3500);
    }}
  }}
  function observeSocket(ws) {{
    if (!ws || ws.__ttydMobileObserved) return;
    ws.__ttydMobileObserved = true;
    ws.addEventListener("open", function () {{ status.socketOpen = true; show("{t['connected']}", "connected"); }});
    ws.addEventListener("close", function (ev) {{
      status.socketOpen = false;
      show(ev && ev.code === 1000 ? "{t['ended']}" : "{t['disconnected']}", "disconnected");
    }});
    ws.addEventListener("error", function () {{ status.socketOpen = false; show("{t['disconnected']}", "error"); }});
  }}
  (function () {{
    var NativeWebSocket = window.WebSocket;
    if (!NativeWebSocket || window.__ttydMobileObserverInstalled) return;
    function ObservedWebSocket(url, protocols) {{
      var ws = arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
      try {{ if (/\\/ws(?:[?#]|$)/.test(ws.url)) observeSocket(ws); }} catch (e) {{}}
      return ws;
    }}
    try {{
      Object.setPrototypeOf(ObservedWebSocket, NativeWebSocket);
      window.WebSocket = ObservedWebSocket;
      window.__ttydMobileObserverInstalled = true;
    }} catch (e) {{ status.observerError = true; }}
  }})();
  function tokenProbe() {{
    return fetch("/token", {{ cache: "no-store", redirect: "manual" }}).then(function (res) {{
      var ct = res.headers && res.headers.get("content-type") || "";
      if (!res.ok || res.type === "opaqueredirect" || res.redirected || ct.indexOf("application/json") < 0) {{
        throw new Error("auth");
      }}
      return res.json();
    }});
  }}
  function check() {{
    if (!navigator.onLine) {{ show("{t['offline']}", "offline"); return; }}
    tokenProbe().then(function () {{
      status.tokenOK = true;
      if (window.term) show("{t['connected']}", "connected");
      else show("{t['connecting']}", "connecting");
    }}).catch(function (err) {{
      status.tokenOK = false;
      if (err && err.message === "auth") show("{t['auth']}", "auth");
      else show("{t['error']}", "error");
    }});
  }}
  function waitForTerminal() {{
    var deadline = Date.now() + 12000;
    var timer = setInterval(function () {{
      if (window.term) {{
        clearInterval(timer);
        check();
      }} else if (Date.now() > deadline) {{
        clearInterval(timer);
        show("{t['timeout']}", "error");
      }}
    }}, 150);
  }}
  function reload() {{ window.location.reload(); }}
  document.addEventListener("DOMContentLoaded", function () {{
    var el = capsule();
    el.addEventListener("click", function () {{
      if (status.state !== "connected") reload();
    }});
    show("{t['connecting']}", "connecting");
    waitForTerminal();
    check();
    setInterval(check, 20000);
  }});
  window.addEventListener("offline", function () {{ show("{t['offline']}", "offline"); }});
  window.addEventListener("online", function () {{ show("{t['recovering']}", "connecting"); check(); }});
  document.addEventListener("visibilitychange", function () {{
    if (document.visibilityState === "visible") check();
  }});
  // 0fd1b41 + 6a397b7: >5min hidden auto-refresh; tiered renderer recovery
  (function () {{
    var hiddenAt = 0;
    document.addEventListener("visibilitychange", function () {{
      if (document.hidden) {{ hiddenAt = Date.now(); return; }}
      if (hiddenAt && (Date.now() - hiddenAt) > 300000) {{
        // >5min hidden: full refresh to recover WebSocket + renderer
        window.location.reload();
        return;
      }}
      if (hiddenAt && (Date.now() - hiddenAt) > 10000) {{
        // 10s-5min: tiered renderer recovery (6a397b7)
        var t = window.term;
        if (t && typeof t.refresh === "function") {{
          try {{ t.refresh(0, Math.max(1, (t.rows || 24) - 1)); }} catch (e) {{}}
        }}
      }}
      hiddenAt = 0;
      // 26ed912: SIGWINCH repaint — force full redraw on tab return
      try {{ window.dispatchEvent(new Event("resize")); }} catch (e) {{}}
    }});
  }})();
}})();
</script>"""


def _make_enhance_script(args: argparse.Namespace) -> str:
    """Generate the main enhancement injection (styles, toolbar, IME, touch scroll)."""
    t = I18N[args.lang]
    bg = "#191724" if args.theme == "dark" else "#faf4ed"
    panel = "#1f1d2e" if args.theme == "dark" else "#d8dae3"
    btn = "#26233a" if args.theme == "dark" else "#cfd5e6"
    fg = "#e0def4" if args.theme == "dark" else "#575279"
    border = "#403d52" if args.theme == "dark" else "#6172b0"
    accent = "#f6c177" if args.theme == "dark" else "#286983"
    inp = "#1f1d2e" if args.theme == "dark" else "#f6f7fb"
    status_bg = "rgba(31,29,46,.96)" if args.theme == "dark" else "rgba(250,244,237,.96)"
    status_fg = "#e0def4" if args.theme == "dark" else "#575279"
    status_accent_bg = "rgba(196,167,231,.2)" if args.theme == "dark" else "rgba(40,105,131,.15)"

    upload_html = ""
    if args.with_upload:
        upload_html = (
            '<button id="tm-upload" class="tm-tool" '
            f'title="{t["upload"]}" aria-label="{t["upload"]}">\U0001f4ce</button>'
        )

    head = f"""<style id="ttyd-mobile-style">
:root{{--tm-bg:{bg};--tm-panel:{panel};--tm-button:{btn};--tm-fg:{fg};--tm-border:{border};--tm-accent:{accent};--tm-input:{inp};}}
html,body{{background:var(--tm-bg)!important;overscroll-behavior:none;}}
body{{box-sizing:border-box;}}
#terminal-container{{box-sizing:border-box;padding:calc(16px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))!important;}}
#terminal-container .terminal{{height:100%!important;padding:0!important;}}
.xterm,.xterm *{{font-family:ui-monospace,Menlo,Consolas,"DejaVu Sans Mono",monospace!important;}}
#tm-tools{{position:fixed;top:50%;right:calc(6px + env(safe-area-inset-right));z-index:100000;display:flex;flex-direction:column;gap:8px;align-items:center;transform:translateY(-50%);}}
#tm-tools button,#tm-shortcuts button{{box-sizing:border-box;min-width:42px;height:40px;padding:0 10px;border:1px solid var(--tm-border);border-radius:7px;background:var(--tm-button);color:var(--tm-fg);font:600 13px/1 -apple-system,system-ui,"Segoe UI",monospace;touch-action:manipulation;}}
#tm-tools button{{width:38px;min-width:38px;height:38px;padding:0;border-radius:19px;font-size:16px;box-shadow:0 1px 6px {status_accent_bg};opacity:.5;transition:opacity .15s ease;}}
#tm-tools .tm-tool{{display:none;}}
#tm-tools.open .tm-tool{{display:block;opacity:.97;}}
#tm-tools.open #tm-more{{opacity:.97;}}
#tm-tools button:active,#tm-shortcuts button:active{{background:var(--tm-accent);color:{bg};border-color:var(--tm-accent);opacity:1;}}
#tm-shortcuts{{position:fixed;top:env(safe-area-inset-top);left:0;right:0;z-index:99998;display:none;gap:6px;padding:6px max(6px,env(safe-area-inset-right)) 6px max(6px,env(safe-area-inset-left));overflow-x:auto;white-space:nowrap;background:var(--tm-panel);border-bottom:1px solid var(--tm-border);box-shadow:0 1px 6px {status_accent_bg};-webkit-overflow-scrolling:touch;}}
#tm-shortcuts.on{{display:flex;}}
body.tm-shortcuts-open #terminal-container{{margin-top:var(--tm-terminal-offset,60px)!important;}}
#tm-input-bar{{position:fixed;left:0;right:0;bottom:0;z-index:99998;display:none;box-sizing:border-box;align-items:flex-end;gap:8px;padding:8px max(8px,env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));background:var(--tm-panel);border-top:1px solid var(--tm-border);box-shadow:0 -2px 10px {status_accent_bg};}}
#tm-input-bar.on{{display:flex;}}
body.tm-input-open #terminal-container{{height:calc(100% - var(--tm-input-height,64px))!important;}}
#tm-input{{flex:1 1 auto;min-width:0;min-height:38px;max-height:96px;box-sizing:border-box;padding:8px 10px;resize:none;overflow-y:auto;border:1px solid var(--tm-border);border-radius:7px;background:var(--tm-input);color:var(--tm-fg);font:16px/20px -apple-system,system-ui,"Segoe UI",sans-serif;outline:none;}}
#tm-input:focus{{border-color:var(--tm-accent);}}
#tm-send{{flex:0 0 auto;width:58px;height:38px;border:0;border-radius:7px;background:var(--tm-accent);color:{bg};font:700 14px/1 -apple-system,system-ui,"Segoe UI",sans-serif;touch-action:manipulation;}}
#tm-send:disabled{{opacity:.55;}}
#tm-bottom{{position:fixed;right:calc(10px + env(safe-area-inset-right));bottom:calc(14px + env(safe-area-inset-bottom));z-index:99999;height:38px;padding:0 14px;border:1px solid var(--tm-border);border-radius:19px;background:var(--tm-accent);color:{bg};font:600 13px/1 -apple-system,system-ui,"Segoe UI",monospace;box-shadow:0 2px 8px {status_accent_bg};opacity:0;pointer-events:none;transition:opacity .18s ease;touch-action:manipulation;}}
#tm-bottom.show{{opacity:.92;pointer-events:auto;}}
#tm-notice{{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));z-index:100003;display:none;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:8px 12px;border-radius:8px;background:{status_bg};color:{status_fg};font:13px/1.35 -apple-system,system-ui,"Segoe UI",sans-serif;box-shadow:0 3px 14px rgba(0,0,0,.25);}}
#tm-notice.on{{display:block;}}
@media (min-width:769px){{#tm-tools button{{opacity:.8;}}#tm-tools button:hover{{opacity:1;}}#tm-shortcuts{{max-width:760px;right:auto;border-radius:0 0 8px 0;}}}}
</style>
<div id="tm-tools" aria-label="{t['tools']}">
 <button id="tm-shortcuts-toggle" class="tm-tool" title="{t['shortcuts']}" aria-label="{t['shortcuts']}">&#x2328;</button>
 <button id="tm-cjk-toggle" class="tm-tool" title="{t['cjkInput']}" aria-label="{t['cjkInput']}">&#x4e2d;</button>
 {upload_html}
 <button id="tm-more" title="{t['tools']}" aria-label="{t['tools']}">&ctdot;</button>
</div>
<div id="tm-shortcuts" aria-label="{t['shortcuts']}">
 <button data-key="esc">Esc</button><button data-key="tab">Tab</button>
 <button data-key="ctrl-c">Ctrl+C</button><button data-key="ctrl-d">Ctrl+D</button>
 <button data-key="up">&uarr;</button><button data-key="down">&darr;</button>
 <button data-key="left">&larr;</button><button data-key="right">&rarr;</button>
 <button data-key="enter">Enter</button><button data-key="pgup">PgUp</button><button data-key="pgdn">PgDn</button>
</div>
<input id="tm-file" type="file" accept="image/*,.pdf,.txt,.log,.json,.md,.csv,.html" multiple hidden>
<div id="tm-input-bar"><textarea id="tm-input" rows="1" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="{t['inputPlaceholder']}"></textarea><button id="tm-send">{t['send']}</button></div>
<button id="tm-bottom">{t['latest']}</button>
<div id="tm-notice" role="status" aria-live="polite"></div>
<script id="ttyd-mobile-enhance">
(function(){{
  "use strict";
  var state=window.__ttydMobileEnhance=window.__ttydMobileEnhance||{{}};
  var light={{
    background:"{bg}",foreground:"{fg}",cursor:"{accent}",cursorAccent:"{bg}",
    selectionBackground:"{border}",black:"#26233a",red:"#eb6f92",green:"#31748f",
    yellow:"#f6c177",blue:"#c4a7e7",magenta:"#c4a7e7",cyan:"#ebbcba",white:"#e0def4",
    brightBlack:"#6e6a86",brightRed:"#eb6f92",brightGreen:"#31748f",
    brightYellow:"#f6c177",brightBlue:"#c4a7e7",brightMagenta:"#c4a7e7",
    brightCyan:"#ebbcba",brightWhite:"#e0def4"
  }};
  var dark=light;
  var input=document.getElementById("tm-input"), notice=document.getElementById("tm-notice");
  var themeName="{args.theme}";

  function notify(text){{if(!notice)return;notice.textContent=text;notice.classList.add("on");clearTimeout(state.noticeTimer);state.noticeTimer=setTimeout(function(){{notice.classList.remove("on");}},4200);}}
  function terminal(){{return window.term||null;}}
  function coreInput(data){{
    var t=terminal(), core=t&&t._core, svc=core&&(core.coreService||core._coreService);
    if(svc&&typeof svc.triggerDataEvent==="function"){{svc.triggerDataEvent(data,true);return true;}}
    if(core&&typeof core.triggerDataEvent==="function"){{core.triggerDataEvent(data,true);return true;}}
    return false;
  }}
  function sendText(text){{
    var t=terminal();
    if(!t)throw new Error("terminal not connected");
    if(typeof t.paste==="function"){{t.paste(text);return;}}
    if(!coreInput(text))throw new Error("input channel unavailable");
  }}
  function syncChromeLayout(){{
    var shortcuts=document.getElementById("tm-shortcuts");
    var open=!!(shortcuts&&shortcuts.classList.contains("on"));
    document.documentElement.style.setProperty("--tm-terminal-offset",open?(shortcuts.offsetHeight+6)+"px":"0px");
  }}
  (function(){{
    var tools=document.getElementById("tm-tools"),more=document.getElementById("tm-more");
    function collapse(){{tools.classList.remove("open");clearTimeout(state.toolsTimer);}}
    function armAutoCollapse(){{clearTimeout(state.toolsTimer);state.toolsTimer=setTimeout(collapse,10000);}}
    more.addEventListener("click",function(){{
      var on=!tools.classList.contains("open");
      tools.classList.toggle("open",on);
      if(on)armAutoCollapse();else clearTimeout(state.toolsTimer);
    }});
    tools.addEventListener("click",function(e){{
      var b=e.target.closest("button");
      if(!b||b.id==="tm-more")return;
      armAutoCollapse();
      if(b.id==="tm-upload")collapse();
    }});
    state.collapseTools=collapse;
  }})();
  function resize(){{
    syncChromeLayout();
    var t=terminal();try{{if(t&&t.fit)t.fit();}}catch(e){{}}
    try{{if(t&&t.refresh&&typeof t.rows==="number")t.refresh(0,t.rows-1);}}catch(e){{}}
    try{{window.dispatchEvent(new Event("resize"));}}catch(e){{}}
  }}
  function applyTheme(){{
    var t=terminal();if(!t)return;
    try{{t.options.theme=themeName==="dark"?dark:light;}}catch(e){{}}
    try{{if(t.setOption)t.setOption("theme",themeName==="dark"?dark:light);}}catch(e){{}}
    resize();
  }}
  var applier=setInterval(function(){{if(terminal()){{applyTheme();clearInterval(applier);}}}},150);
  setTimeout(function(){{clearInterval(applier);}},20000);

  var shortcuts={{esc:"\\x1b",tab:"\\t","ctrl-c":"\\x03","ctrl-d":"\\x04",up:"\\x1b[A",down:"\\x1b[B",left:"\\x1b[D",right:"\\x1b[C",enter:"\\r",pgup:"\\x1b[5~",pgdn:"\\x1b[6~"}};
  function shortcutSequence(name){{if(!coreInput(shortcuts[name]||""))notify("{t['sendFail']}".replace("{{}}","input channel"));else{{var t=terminal();if(t&&t.focus)t.focus();}}}}
  document.getElementById("tm-shortcuts").addEventListener("click",function(e){{var b=e.target.closest("button");if(b)shortcutSequence(b.getAttribute("data-key"));}});
  document.getElementById("tm-shortcuts-toggle").addEventListener("click",function(){{var bar=document.getElementById("tm-shortcuts"),on=!bar.classList.contains("on");bar.classList.toggle("on",on);document.body.classList.toggle("tm-shortcuts-open",on);syncChromeLayout();resize();}});
  document.getElementById("tm-cjk-toggle").addEventListener("click",function(){{var bar=document.getElementById("tm-input-bar"),on=!bar.classList.contains("on");bar.classList.toggle("on",on);document.body.classList.toggle("tm-input-open",on);localStorage.setItem("tmCjkOpen",on?"1":"0");if(on){{setTimeout(function(){{input.focus();grow();}},30);}}resize();}});
  function grow(){{if(!input)return;input.style.height="auto";input.style.height=Math.min(input.scrollHeight,96)+"px";document.documentElement.style.setProperty("--tm-input-height",document.getElementById("tm-input-bar").offsetHeight+"px");resize();}}
  function sendCjk(){{var text=input&&input.value;if(!text||!text.trim()){{if(input)input.focus();return;}}var button=document.getElementById("tm-send");try{{button.disabled=true;sendText(text);setTimeout(function(){{coreInput("\\r");}},70);input.value="";grow();setTimeout(function(){{button.disabled=false;input.focus();}},180);}}catch(e){{button.disabled=false;notify("{t['sendFail']}".replace("{{}}",e.message||"input channel"));}}}}
  document.getElementById("tm-send").addEventListener("click",sendCjk);input.addEventListener("input",grow);input.addEventListener("keydown",function(e){{if(e.key==="Enter"&&!e.shiftKey){{e.preventDefault();sendCjk();}}}});
  if(localStorage.getItem("tmCjkOpen")==="1"){{document.getElementById("tm-input-bar").classList.add("on");document.body.classList.add("tm-input-open");}}
"""

    if args.with_upload:
        upload_js = f"""
  (function(){{var btn=document.getElementById("tm-upload"),file=document.getElementById("tm-file");
  btn.addEventListener("click",function(){{file.click();}});
  file.addEventListener("change",function(){{
    var files=Array.prototype.slice.call(file.files||[]);file.value="";
    if(!files.length)return;btn.textContent="\\u2026";
    var paths=[];var chain=Promise.resolve();
    files.forEach(function(f){{chain=chain.then(function(){{
      return fetch("/up",{{method:"POST",headers:{{"X-Filename":encodeURIComponent(f.name||"upload.bin")}},body:f}})
        .then(function(r){{if(!r.ok)throw new Error("HTTP "+r.status);return r.json();}})
        .then(function(j){{if(!j||!j.path)throw new Error("no path in response");paths.push(j.path);}});
    }});}});
    chain.then(function(){{
      sendText(paths.join(" ")+" ");btn.textContent="\\u2713";
      notify("{t['uploadOk']}".replace("{{}}",paths.length));
      setTimeout(function(){{btn.textContent="\\U0001f4ce";}},1500);
    }}).catch(function(e){{
      btn.textContent="!";notify("{t['uploadFail']}".replace("{{}}",e.message||"/up unavailable"));
      setTimeout(function(){{btn.textContent="\\U0001f4ce";}},2500);
    }});
  }});}})();
"""
    else:
        upload_js = ""

    tail = f"""
  var bottom=document.getElementById("tm-bottom");
  function showBottom(){{bottom.classList.add("show");clearTimeout(state.bottomTimer);state.bottomTimer=setTimeout(function(){{bottom.classList.remove("show");}},4000);}}
  function scrollWheel(button){{var t=terminal(),pos="\\x1b[<"+button+";1;1M";if(t&&t.rows)pos="\\x1b[<"+button+";"+Math.max(1,Math.floor((t.cols||80)/2))+";"+Math.max(1,Math.floor(t.rows/2))+"M";coreInput(pos);}}
  var lastY=null,startY=null,engaged=false;
  document.addEventListener("touchstart",function(e){{if(e.touches.length===1){{lastY=e.touches[0].clientY;startY=lastY;engaged=false;}}}},{{passive:true}});
  document.addEventListener("touchmove",function(e){{if(e.touches.length!==1||lastY===null)return;if(e.target.closest&&e.target.closest("#tm-tools,#tm-shortcuts,#tm-input-bar,#tm-bottom"))return;var y=e.touches[0].clientY,dy=lastY-y;if(!engaged){{if(Math.abs(startY-y)<24)return;engaged=true;lastY=y;return;}}if(Math.abs(dy)<14)return;lastY=y;var n=Math.min(6,Math.max(1,Math.floor(Math.abs(dy)/28))),button=dy>0?65:64;for(var i=0;i<n;i++)scrollWheel(button);if(button===64)showBottom();e.preventDefault();}},{{passive:false}});
  document.addEventListener("touchend",function(){{lastY=null;engaged=false;}},{{passive:true}});
  bottom.addEventListener("click",function(){{for(var i=0;i<80;i++)scrollWheel(65);bottom.classList.remove("show");}});
}})();
</script>"""

    return head + upload_js + tail


def _detect_version(html: str) -> tuple[str | None, list[str], list[str]]:
    """Check anchors to determine ttyd version.

    Returns:
      (version|None, matches, misses) — version is "1.6.3", "1.7.x", or None.
    """
    matches: list[str] = []
    misses: list[str] = []

    for pattern, label in V163_ANCHORS:
        if re.search(pattern, html):
            matches.append(f"1.6.3:{label}")
        else:
            misses.append(f"1.6.3:{label}")

    if not misses:
        return "1.6.3", matches, misses

    # Check for 1.7.x indicators
    v17_hits = []
    for pattern, label in V17X_INDICATORS:
        if re.search(pattern, html):
            v17_hits.append(f"1.7.x:{label}")
    if v17_hits:
        return "1.7.x", v17_hits, misses

    return None, matches, misses


def build_page(
    src_html: str,
    args: argparse.Namespace,
) -> str:
    """Inject enhancements into the ttyd HTML.

    Returns the enhanced HTML.
    Raises SystemExit on version mismatch (fatal for 1.6.3 mode).
    """
    version, _matches, misses = _detect_version(src_html)

    if version == "1.6.3":
        print(f"build-page: detected ttyd {version} — injecting enhancements", file=sys.stderr)
    elif version == "1.7.x":
        print(
            "build-page: WARNING — ttyd 1.7.x detected. Enhanced page is experimental.",
            file=sys.stderr,
        )
        print(
            "  xterm.js 5.x uses addon-based API; private API injection may fail.",
            file=sys.stderr,
        )
        print(
            "  Capability detection will run in the browser; features degrade gracefully.",
            file=sys.stderr,
        )
        if not args.force:
            print(
                "  Use --force to inject anyway, or install ttyd 1.6.3 for full support.",
                file=sys.stderr,
            )
            print(
                "  Falling back to bare page (no injection).",
                file=sys.stderr,
            )
            return src_html
    else:
        print(
            "build-page: ERROR — HTML anchor validation FAILED:",
            file=sys.stderr,
        )
        for miss in misses:
            print(f"  missing: {miss}", file=sys.stderr)
        print(
            "  The source HTML does not match ttyd 1.6.3 or 1.7.x fingerprints.",
            file=sys.stderr,
        )
        print(
            "  Refusing to inject. Use --force to override (unsupported).",
            file=sys.stderr,
        )
        if not args.force:
            return src_html

    html = src_html

    # Remove existing viewport meta, add ours
    html = re.sub(r'<meta\s+name="viewport"[^>]*>', "", html, count=1)
    theme_color = "#191724" if args.theme == "dark" else "#e1e2e7"
    viewport = _make_viewport(args)
    html = html.replace('<meta charset="UTF-8">', f'<meta charset="UTF-8">{viewport}', 1)

    # Inject early status monitor after <body>
    early = _make_early_script(args)
    html = html.replace("<body>", "<body>" + early, 1)

    # Inject main enhancements before </body>
    enhance = _make_enhance_script(args)
    html = html.replace("</body></html>", enhance + "</body></html>", 1)

    return html


def main() -> None:
    parser = argparse.ArgumentParser(
        description="pocket-term build-page — inject mobile enhancements into ttyd HTML",
    )
    parser.add_argument(
        "--index-src",
        required=True,
        type=Path,
        help="Path to ttyd original index.html (e.g. from ttyd 1.6.3)",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Output path for the enhanced index.html",
    )
    parser.add_argument(
        "--lang",
        choices=["en", "zh"],
        default="en",
        help="UI language (default: en)",
    )
    parser.add_argument(
        "--theme",
        choices=["dark", "light"],
        default="dark",
        help="Color theme (default: dark)",
    )
    parser.add_argument(
        "--with-upload",
        action="store_true",
        default=False,
        help="Inject file upload button and /up integration",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        default=False,
        help="Inject even if anchor validation fails (unsupported)",
    )
    args = parser.parse_args()

    if not args.index_src.exists():
        print(f"ERROR: index source not found: {args.index_src}", file=sys.stderr)
        sys.exit(1)

    src_html = args.index_src.read_text(encoding="utf-8")
    enhanced = build_page(src_html, args)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(enhanced, encoding="utf-8")
    print(f"build-page: wrote {len(enhanced)} bytes to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
