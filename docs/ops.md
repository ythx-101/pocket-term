# pocket-term-2 ops runbook

Deploy / rollback for the local bridge + optional public path.  
**Gate③** (public cloudflared path) needs explicit human approval; this file is the checklist.

## Preconditions

- Repo at `/root/pocket-term-2`, tests green: `node --test test/**/*.test.mjs`
- herdr server up; socket readable by the service user (default root)
- Bridge binds **127.0.0.1 only** (default `PT2_PORT=7690`)
- Do not paste secrets into tickets or chat logs

## A. Local service only (systemd, no public path)

```bash
# install unit from repo (do not hand-edit /etc without backup)
cp /root/pocket-term-2/systemd/pocket-term-2.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pocket-term-2
systemctl status pocket-term-2 --no-pager
journalctl -u pocket-term-2 -n 50 --no-pager

# health
curl -fsS http://127.0.0.1:7690/herd/api/state | head -c 200
curl -fsS -m 3 -N http://127.0.0.1:7690/herd/api/events | head -c 200
```

Rollback local service:

```bash
systemctl disable --now pocket-term-2
# optional: rm /etc/systemd/system/pocket-term-2.service && systemctl daemon-reload
```

## B. Public path via cloudflared (gate③ — human batch)

### 1. Backup

```bash
ts=$(date +%Y%m%dT%H%M%S)
cp -a /etc/cloudflared/config.yml "/etc/cloudflared/config.yml.bak-${ts}"
```

### 2. Insert path rule

Add a **path-specific** ingress **before** the hostname catch-all that serves the existing web terminal, for example:

```yaml
  - hostname: term.example.com
    path: ^/herd(/.*)?$
    service: http://127.0.0.1:7690
```

Keep existing rules for `/`, `/up`, etc. untouched except for insertion order.

### 3. Validate

```bash
cloudflared tunnel ingress validate
# or project-specific validate command used on this host
```

### 4. Restart tunnel (brief interruption — approved window only)

```bash
systemctl restart cloudflared
# wait until active
systemctl is-active cloudflared
```

### 5. Health checks (regression)

```bash
# new surface
curl -fsS -o /dev/null -w '%{http_code}\n' https://term.example.com/herd/
curl -fsS https://term.example.com/herd/api/state | head -c 120

# existing surfaces must still work
curl -fsS -o /dev/null -w '%{http_code}\n' https://term.example.com/
curl -fsS -o /dev/null -w '%{http_code}\n' https://term.example.com/up

journalctl -u cloudflared -n 80 --no-pager
journalctl -u pocket-term-2 -n 80 --no-pager
```

Unauthenticated public access should still be blocked by **Cloudflare Access** (expect login challenge, not raw JSON).

### 6. Rollback path

```bash
# restore previous config
cp -a /etc/cloudflared/config.yml.bak-YYYYMMDDTHHMMSS /etc/cloudflared/config.yml
cloudflared tunnel ingress validate
systemctl restart cloudflared

# re-check terminal + upload
curl -fsS -o /dev/null -w '%{http_code}\n' https://term.example.com/
curl -fsS -o /dev/null -w '%{http_code}\n' https://term.example.com/up

# optional: stop bridge
systemctl disable --now pocket-term-2
```

If Claude integration was installed for Tier A and must be reversed:

```bash
herdr integration uninstall claude   # or project-documented reverse
```

## C. Failure signals

| Symptom | Check |
| ------- | ----- |
| `herdr: disconnected` in SPA / state | herdr server, socket path, `journalctl -u pocket-term-2` |
| `protocol_mismatch: true` | herdr upgraded; bridge still serves but UI may degrade |
| Empty summaries | Tier B seed read failed; pane.read errors in journal |
| 502 on `/herd` | bridge down or cloudflared rule points wrong port |
| `/` or `/up` broken after deploy | ingress order wrong — restore backup immediately |

## D. Security notes

- Bridge must not listen on `0.0.0.0` in production.
- herdr write surface is limited to `pane.send_text` / `pane.send_keys` (keys hard-forced to `['enter']` only). `pane.run` is CLI sugar, not a socket method. Other write methods stay off the whitelist.
- `POST /herd/api/pane/:id/send` is same-origin only (missing Origin/Referer rejected), body ≤8KB, 2s per-pane rate limit, pane must exist in the current snapshot.
- Transcript paths are constrained under the configured Claude projects root; `..` segments rejected.
- Static files under `/herd/` are realpath-checked to stay inside `public/`.

## E. PT2_READONLY fuse (M1 write channel rollback)

M1 opens a directed send channel (`POST /herd/api/pane/:id/send` → herdr `pane.send_text` + `pane.send_keys` Enter). To instantly return to M0 read-only behavior without a code revert:

```bash
# systemd drop-in or unit Environment=
Environment=PT2_READONLY=1

systemctl daemon-reload
systemctl restart pocket-term-2   # only after human approval to restart
```

Effects when `PT2_READONLY=1` (or `true`):

- Send endpoint responds `403 {"error":"readonly"}` before any herdr write.
- Bridge constructs `createClient({ allowWrite: false })` — same whitelist as M0; `pane.send_text` / `pane.send_keys` never reach the socket.
- Read APIs (`/state`, `/events`, `/messages`, static SPA) keep working.

Disable the fuse (re-enable send after review):

```bash
# remove PT2_READONLY from the unit / drop-in, then:
systemctl daemon-reload
systemctl restart pocket-term-2   # human-approved restart only
```

Alternate rollback: `git revert` the M1 send commit and restart (same restart gate).

**Do not restart any service from agent automation** unless a human has explicitly approved that restart for this host.
