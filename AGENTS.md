# AGENTS.md — pocket-term agent onboarding

> This document is for **automated agents** (Claude Code, Pi, GPT, etc.).
> Every step includes a machine-verifiable check. No context-dependent hints.

## Safety rules for ALL agents

1. **Never bind ttyd to `0.0.0.0` or any public interface.** Always `-i 127.0.0.1`.
2. **Never run ttyd as root.** Install scripts exit with a warning if UID is 0.
3. **Never use `ttyd` without `-c <user>:<password>`.** Every tier requires basic auth.
4. **Never expose `/up` without basic auth.** The upload server must validate `Authorization: Basic`.
4a. **macOS upload is manual-only.** `install-l1.sh --with-upload` on Darwin writes
   the upload server files but does NOT install/enable/start a launchd job for
   it (no automated persistence yet — only the ttyd terminal itself gets a
   launchd plist). Start it by hand: `python3 <prefix>/upload-server.py
   --upload-dir <prefix>/uploads --port <upload-port> --credentials <prefix>/credentials &`
5. **Never touch production files.** Reference paths are read-only. Copy, never move.
6. **Never print or commit secrets, tokens, passwords, or private URLs.**
7. **Test on 127.0.0.1 high ports (7682, 7698).** Kill and clean up after smoke tests.

## Machine-verifiable procedure

### Check: Is ttyd installed and is it the right version?

A version string alone is spoofable (a tampered or repackaged binary can
report any `--version` string it likes), so it only tells you what a normal
ttyd on PATH claims to be — it does NOT prove the pinned binary L1 downloads
is genuine. Use it as a quick human-readable sanity check only:

```bash
ttyd --version 2>&1 | grep -q "1.6.3" && echo "PASS: ttyd 1.6.3" || echo "NEED: ttyd 1.6.3"
```

To actually verify the pinned binary L1 downloads and runs, check its SHA256
against the value hardcoded in `scripts/install-l1.sh`/`scripts/l0-quick.sh`
(both download to `/tmp/pocket-term-ttyd-1.6.3` and always re-verify, even if
cached from a previous run):

```bash
ARCH=$(uname -m); case "$ARCH" in x86_64) A=x86_64;; aarch64|arm64) A=aarch64;; armv7l) A=arm;; armv6l) A=armhf;; esac
EXPECTED=$(grep "TTYD_SHA256\[\"$A\"\]" scripts/install-l1.sh | sed -E 's/.*"([0-9a-f]{64})".*/\1/')
ACTUAL=$(sha256sum /tmp/pocket-term-ttyd-1.6.3 2>/dev/null | awk '{print $1}')
[ -n "$ACTUAL" ] && [ "$ACTUAL" = "$EXPECTED" ] && echo "PASS: sha256 matches pin" || echo "NEED: run install-l1.sh/l0-quick.sh first, or hash mismatch"
```

### Check: Is cloudflared available?

```bash
which cloudflared >/dev/null 2>&1 && echo "PASS: cloudflared in PATH" || echo "NEED: cloudflared"
```

### Check: Is Tailscale installed and authenticated?

```bash
tailscale status --json >/dev/null 2>&1 && echo "PASS: Tailscale running" || echo "NEED: tailscale up"
```

## Tier selection decision tree

```
Is this a one-off / share-with-friend session?
  YES → L0 (l0-quick.sh). No install. Ctrl-C = gone.
  NO  → Is Tailscale available and authenticated on this machine?
          YES → L1 (install-l1.sh). Persistent, stable address.
          NO  → L1 (install-l1.sh --without-upload).
                 Upload requires same-origin routing (serve/funnel).

Do you need a custom domain + Cloudflare Access?
  → L2 (docs/L2-advanced.md). Read-only templates.
```

## L0 verification

After running `l0-quick.sh`:

```bash
# 1. Auth-protected
curl -s -o /dev/null -w '%{http_code}' -u pocket:test http://127.0.0.1:7682/
# Expect: 200 (with correct password) or 401 (wrong password)

# 2. Anonymous access blocked
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7682/
# Expect: 401

# 3. Process killed after Ctrl-C
pgrep -f "ttyd.*7682" && echo "FAIL: ttyd still running" || echo "PASS"
```

## L1 verification

After running `install-l1.sh --prefix /tmp/pocket-term-test`:

```bash
# 1. Manifest exists and is valid JSON
python3 -c "import json; json.load(open('/tmp/pocket-term-test/manifest.json'))" && echo "PASS"

# 2. Service file installed
test -f /tmp/pocket-term-test/pocket-term.service && echo "PASS"

# 3. Upload server responds to auth
curl -s -o /dev/null -w '%{http_code}' \
  -u user:$(head -1 /tmp/pocket-term-test/credentials | cut -d: -f2) \
  http://127.0.0.1:7698/up
# Expect: 400 (no file in body, but auth passed)

# 4. Upload rejects anonymous
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7698/up
# Expect: 401
```

## Uninstall

```bash
./scripts/uninstall.sh --prefix /tmp/pocket-term-test
# Then verify no residue:
test -f /tmp/pocket-term-test/manifest.json && echo "FAIL: manifest remains" || echo "PASS"
test -d /tmp/pocket-term-test && echo "WARN: prefix dir remains (may be intentional)" || echo "PASS"
```

## Sensitive-data grep (run before any publish)

This repo's own template files must never hardcode a real secret-format
fragment (a real token prefix, a real private hostname, a real key
filename) as a literal — a committed "leak check" that itself contains the
literal it searches for is a leak. So this check is deliberately
parameterized: put YOUR deployment's real private terms in a local,
**uncommitted** file (or an env var) before running it, and never commit
real values back into this template.

```bash
# Create ./.private-terms.local (gitignored) with one regex fragment per
# line: your real private hostname, secret-manager paths, real token
# prefixes you use, etc. Then:
PATTERN="$(paste -sd'|' .private-terms.local 2>/dev/null)"
if [ -n "$PATTERN" ]; then
  grep -riE "$PATTERN" \
    --include='*.sh' --include='*.py' --include='*.md' --include='*.html' \
    --include='*.tmpl' --include='*.svg' . | grep -v 'example\.com' | grep -v 'placeholder'
fi
# Expect: zero matches (allowed: example.com placeholders). An empty
# .private-terms.local (or none at all) is a no-op, not a false pass —
# fill it in with your own deployment's real terms before trusting this.
```
