# SKILL.md — pocket-term-2 agent skill

> This skill is operated by agents, not hand-configured by humans.
> Read this file top to bottom, detect the environment, ask the human only
> for decisions (port, domain/push), and run the scripts with the right flags.
> Do NOT ask the human to edit files, copy long command blocks, or make
> mechanical choices.

## Intent

When a human asks for a “mobile agent chat,” “herdr WeChat UI,” “pocket-term v2,”
or “fleet chat on the phone,” install **pocket-term-2**: a local Node bridge +
SPA that talks to herdr over a Unix socket.

## Step 0: Environment detection

Run these checks. Do NOT ask the human to run them.

```bash
uname -s                          # Linux expected for systemd path
uname -m
echo "UID=$UID HOME=$HOME"
command -v node npm systemctl herdr curl 2>/dev/null || true
node -v 2>/dev/null               # need >= 20
test -S "${PT2_HERDR_SOCK:-$HOME/.config/herdr/herdr.sock}" \
  && echo "herdr.sock: present" || echo "herdr.sock: missing"
```

Record: Node version, whether herdr CLI/socket exist, whether systemd is usable
(system or `--user`).

## Step 1: Decisions (ask the human, nothing else)

1. **Listen port?** Default `7690` (bind stays `127.0.0.1`).
2. **Public domain / reverse proxy?** Optional. Use `term.example.com`-style
   placeholders in any tunnel/proxy config; never invent a private hostname.
3. **Enable Web Push?** If yes, need a contact subject (`mailto:…` or `https:…`).
   Keys are generated locally and must never be committed.
4. **Install scope?** system unit (root) vs user unit (default non-root).

Everything else — `npm ci`, unit templating, herdr Claude integration, env file,
enable/start, health check — is automated.

## Step 2: Install

From the repository root:

```bash
# Minimal (no push, auto user/system scope, start + verify)
bash scripts/install.sh --port 7690

# With Web Push (subject is a human decision)
bash scripts/install.sh --port 7690 --with-push \
  --vapid-subject 'mailto:admin@example.com'

# Dry-run / unit only
bash scripts/install.sh --dry-run
bash scripts/install.sh --no-start --no-herdr-integ
```

**What install.sh does:**

1. `npm ci` in the repo.
2. Optionally `herdr integration install claude` (Tier A transcripts).
3. Writes `state/pt2.env` (gitignored) with `PT2_HOST` / `PT2_PORT` and optional
   VAPID / path overrides.
4. Renders `systemd/pocket-term-2.service.tmpl` → generated unit with
   `__WORKDIR__` / `__HOME__` / `__NODE_PATH__` / `__NODE_BIN__` filled.
5. Installs system or user systemd unit, `daemon-reload`, `enable --now`
   (unless `--no-start`).
6. Verifies `GET http://127.0.0.1:<port>/herd/api/state` returns 200.

### Optional environment

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PT2_HOST` | `127.0.0.1` | Bind address (keep loopback in production) |
| `PT2_PORT` | `7690` | Listen port |
| `PT2_HERDR_SOCK` | `$HOME/.config/herdr/herdr.sock` | herdr Unix socket |
| `PT2_PROJECTS_ROOT` | `$HOME/.claude/projects` | Claude JSONL root (Tier A) |
| `PT2_CHAT_UPLOAD_DIR` | `/srv/term-uploads` | Chat image upload dir |
| `PT2_FILE_SERVE_ROOT` | `/srv/term-uploads` | Image/Markdown serve whitelist root |
| `PT2_READONLY` | unset | `1` → emergency read-only fuse |
| `PT2_VAPID_*` | unset | Web Push (all three required) |

Generate VAPID only (stdout, never to git):

```bash
bash scripts/gen-vapid.sh          # JSON
bash scripts/gen-vapid.sh --env    # export lines (edit subject)
```

## Step 3: Verify

```bash
curl -fsS "http://127.0.0.1:7690/herd/api/state" | head -c 200
# Expect: JSON with panes / herdr fields

curl -fsS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:7690/herd/"
# Expect: 200

# Unit health (system)
systemctl status pocket-term-2 --no-pager
# or user unit:
systemctl --user status pocket-term-2 --no-pager
```

Automated checks: see `AGENTS.md`.

## Step 4: Reverse proxy / tunnel (optional)

Do **not** commit private hostnames. Example pattern only:

```yaml
ingress:
  - hostname: term.example.com
    path: ^/herd(/.*)?$
    service: http://127.0.0.1:7690
  - service: http_status:404
```

Prefer Cloudflare Access (or equivalent) in front of any public path.
See `docs/ops.md`.

## Uninstall

```bash
# system
systemctl disable --now pocket-term-2
rm -f /etc/systemd/system/pocket-term-2.service
systemctl daemon-reload

# user
systemctl --user disable --now pocket-term-2
rm -f "$HOME/.config/systemd/user/pocket-term-2.service"
systemctl --user daemon-reload

# optional: remove local env (contains secrets if push was enabled)
# rm -f state/pt2.env
```

## Safety rules

1. **Never bind the bridge to `0.0.0.0` in production** unless the human explicitly
   requests it and understands the exposure.
2. **Never commit** `state/`, VAPID keys, credentials, or real hostnames/emails.
3. **Never print secrets** into tickets or chat logs.
4. **Do not restart unrelated host services** (cloudflared, etc.) without explicit
   human approval for that host.
5. Placeholders only: `example.com`, `mailto:admin@example.com`.
