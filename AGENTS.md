# AGENTS.md — pocket-term-2 machine onboarding

> For automated agents (Claude Code, Pi, GPT, etc.).
> Every step includes a machine-verifiable check. No context-dependent hints.

## Safety rules for ALL agents

1. **Never bind to `0.0.0.0` by default.** Keep `PT2_HOST=127.0.0.1`.
2. **Never commit secrets.** `state/` is gitignored; VAPID keys stay in env / `state/pt2.env`.
3. **Never hardcode private domains, emails, or absolute machine paths** in committed files.
   Use `example.com` placeholders and `$HOME` / `$REPO` variables.
4. **Never push to a public remote** or restart production services unless the human
   explicitly ordered that action for this host.
5. **Do not invent** Cloudflare / Tailscale hostnames; ask or use examples only.

## Setup (install)

```bash
cd "$REPO"   # repository root containing server.js
bash scripts/install.sh --port 7690
```

Flags worth knowing:

| Flag | Effect |
| ---- | ------ |
| `--dry-run` | Print actions only |
| `--no-start` | Render/install unit without enable/start |
| `--no-herdr-integ` | Skip `herdr integration install claude` |
| `--with-push --vapid-subject mailto:admin@example.com` | Write VAPID into env file |
| `--system` / `--user-unit` | systemd scope |
| `--workdir DIR` | Repo path if not invoking from clone |

### Check: Node ≥ 20

```bash
node -v | grep -E '^v(2[0-9]|[3-9][0-9])\.' && echo "PASS: node" || echo "NEED: node>=20"
```

### Check: dependencies installed

```bash
test -d node_modules/web-push && echo "PASS: npm ci" || echo "NEED: npm ci"
```

### Check: unit template renders without private paths

```bash
test -f systemd/pocket-term-2.service.tmpl && echo "PASS: tmpl"
grep -E '__WORKDIR__|__HOME__|__NODE_' systemd/pocket-term-2.service.tmpl \
  && echo "PASS: placeholders" || echo "FAIL: missing placeholders"
# Generated unit (after install) must not be committed:
test -f systemd/pocket-term-2.service.generated && echo "WARN: generated unit present (gitignored?)" || true
```

### Check: service health (after install without --no-start)

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7690/herd/api/state
# Expect: 200

curl -s http://127.0.0.1:7690/herd/api/state | head -c 120
# Expect: JSON including "panes" and/or "herdr"
```

### Check: herdr socket default

```bash
SOCK="${PT2_HERDR_SOCK:-$HOME/.config/herdr/herdr.sock}"
test -S "$SOCK" && echo "PASS: sock $SOCK" || echo "NEED: herdr server + sock at $SOCK"
```

### Check: projects root default

```bash
ROOT="${PT2_PROJECTS_ROOT:-$HOME/.claude/projects}"
echo "projects root: $ROOT"
# Directory may be absent until Claude Code runs; absence is OK (Tier B only).
```

## Verify (tests)

```bash
cd "$REPO"
npm test
# or: node --test test/**/*.test.mjs
# Expect: all tests pass (353+ assertions; count must not regress)
```

Smoke against a running instance:

```bash
PT2_BASE=http://127.0.0.1:7690 ./scripts/smoke.sh
```

## Uninstall

```bash
# system unit
systemctl disable --now pocket-term-2 2>/dev/null || true
rm -f /etc/systemd/system/pocket-term-2.service
systemctl daemon-reload

# user unit
systemctl --user disable --now pocket-term-2 2>/dev/null || true
rm -f "${HOME}/.config/systemd/user/pocket-term-2.service"
systemctl --user daemon-reload

# optional cleanup (destructive — confirm with human)
# rm -f "$REPO/state/pt2.env" "$REPO/systemd/pocket-term-2.service.generated"
```

Verify clean:

```bash
systemctl is-active pocket-term-2 2>/dev/null && echo "FAIL: still active" || echo "PASS: inactive"
curl -s -o /dev/null -w '%{http_code}\n' --max-time 1 http://127.0.0.1:7690/herd/api/state \
  | grep -E '000|7..' >/dev/null && echo "PASS: bridge down" || echo "WARN: something still responds on 7690"
```

## Sensitive-data grep (before publish)

Never embed real private terms in the repo as a “leak check.” Parameterize:

```bash
# Create ./.private-terms.local (gitignored) with one regex fragment per line.
PATTERN="$(paste -sd'|' .private-terms.local 2>/dev/null || true)"
if [ -n "$PATTERN" ]; then
  grep -riE "$PATTERN" \
    --include='*.js' --include='*.mjs' --include='*.md' --include='*.sh' \
    --include='*.tmpl' --include='*.html' --include='*.css' . \
    | grep -v node_modules | grep -v 'example\.com' | grep -v 'placeholder' || true
fi
# Expect: zero matches for real private terms.
```

Quick structural check (no private terms required):

```bash
# Committed tree should not contain raw VAPID private key material or state secrets
! git ls-files state/ 2>/dev/null | grep -q . && echo "PASS: state/ not tracked"
git grep -n 'BEGIN PRIVATE KEY' -- ':!node_modules' && echo "FAIL" || echo "PASS: no private keys"
```
