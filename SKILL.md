# SKILL.md — pocket-term agent skill

> This skill is operated by agents, not hand-configured by humans.
> Read this file top to bottom, detect the environment, ask the human only
> for decisions (tier, GitHub account), and run the scripts with the right flags.
> Do NOT ask the human to edit files, copy commands, or make mechanical choices.

## Intent classification

When a human asks for a "web terminal," "browser terminal," or "phone terminal," classify:

1. **One-off share** → L0. Run `scripts/l0-quick.sh` directly.
2. **Daily driver** → L1. Run `scripts/install-l1.sh` with auto-detected flags.
3. **Own domain + access control** → L2. Read `docs/L2-advanced.md` and adapt the templates.

## Step 0: Environment detection

Run these checks and record results. Do NOT ask the human to run them.

```bash
uname -s                    # Linux or Darwin
uname -m                    # amd64, arm64, armv7
echo "$UID"                 # 0 = root (warn); non-zero = ok
which ttyd cloudflared tailscale 2>/dev/null || echo "missing"
tailscale status --json >/dev/null 2>&1 && echo "Tailscale: authenticated" || echo "Tailscale: not ready"
```

## Step 1: L0 — Quick tunnel

If the human wants a one-off session:

```bash
bash scripts/l0-quick.sh
```

The script:
- Downloads ttyd 1.6.3 (pinned, SHA256-verified) and cloudflared to `/tmp` if missing.
- Generates a 24-character random password.
- Starts ttyd on `127.0.0.1:<port>` with `-c user:password`.
- Spins up a Cloudflare quick tunnel.
- Prints a `trycloudflare.com` URL with credentials.
- Cleans everything on Ctrl-C.

**Verify:**
```bash
# ttyd auth check
curl -s -o /dev/null -w '%{http_code}' -u pocket:XXX http://127.0.0.1:7682/
# Expect: 200 with correct password

# Anonymous check
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7682/
# Expect: 401
```

## Step 2: L1 — Daily driver install

If the human wants a persistent setup:

```bash
# Detect Tailscale for automatic upload routing
USE_UPLOAD="--with-upload"
tailscale status --json >/dev/null 2>&1 || USE_UPLOAD="--without-upload"

bash scripts/install-l1.sh \
  --prefix "$HOME/.local/share/pocket-term" \
  --shell "$SHELL" \
  "$USE_UPLOAD"
```

**What it does:**
1. Generates a 24-char random password → `<prefix>/credentials` (0600).
2. Builds the enhanced page via `build-page.py` (only for pinned ttyd 1.6.3).
3. Writes the launch script from `templates/launch-ttyd.sh.tmpl`.
4. Installs systemd (Linux) or launchd (macOS) unit from templates.
5. If `--with-upload`: installs upload server, routes via `tailscale serve --set-path /up`.
6. Every step records to `<prefix>/manifest.json`. On failure, rolls back automatically.

**Verify:**
```bash
# Manifest integrity
python3 -c "import json; json.load(open('$HOME/.local/share/pocket-term/manifest.json'))"

# Service health (Linux)
systemctl --user status pocket-term.service

# Auth check
CREDS=$(cat "$HOME/.local/share/pocket-term/credentials")
USER=$(echo "$CREDS" | cut -d: -f1)
PASS=$(echo "$CREDS" | cut -d: -f2)
curl -s -o /dev/null -w '%{http_code}' -u "$USER:$PASS" http://127.0.0.1:7681/
# Expect: 200

curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7681/
# Expect: 401
```

## Step 3: L2 — Advanced (read-only templates)

Read `docs/L2-advanced.md`. It contains sanitized templates for:
- Custom domain with Cloudflare Access email gate
- Named Cloudflare tunnel
- nginx reverse proxy
- herdr multi-agent terminal

The agent adapts the templates to the local environment. Placeholders use `example.com`.

## Uninstall

```bash
bash scripts/uninstall.sh --prefix "$HOME/.local/share/pocket-term"
```

Verifies:
```bash
test -f "$HOME/.local/share/pocket-term/manifest.json" && echo "FAIL" || echo "PASS: clean"
```

## Decision points (ask the human, nothing else)

The agent may ask the human only these questions:

1. **Which tier?** L0 (one-off), L1 (daily driver), or L2 (custom domain).
2. **Preferred shell?** Default: `$SHELL`.
3. **GitHub account for publishing?** Only if the human asked to publish.
4. **Install prefix?** Default: `$HOME/.local/share/pocket-term`.
5. **Language?** en or zh for UI strings (default: en).

Everything else — platform detection, binary download, SHA256 verification,
password generation, page building, service installation, route configuration —
is fully automated.
