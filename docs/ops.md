# pocket-term-2 ops runbook

Deploy / rollback for the local bridge + optional public path.  
**Public reverse-proxy / tunnel path** needs explicit human approval; this file is the checklist.

`$REPO` = path to the pocket-term-2 clone (wherever you installed it).

## Preconditions

- Repo at `$REPO`, tests green: `cd "$REPO" && node --test test/**/*.test.mjs`
- herdr server up; socket readable by the service user (default `$HOME/.config/herdr/herdr.sock`, override `PT2_HERDR_SOCK`)
- Bridge binds **127.0.0.1 only** (default `PT2_PORT=7690`)
- Do not paste secrets into tickets or chat logs
- Web Push is optional. Keep VAPID values in the service environment / `$REPO/state/pt2.env`, never in this repository; absence safely leaves page notifications enabled.

## A. Local service only (systemd, no public path)

Preferred: agent/script install (see `SKILL.md`):

```bash
cd "$REPO"
bash scripts/install.sh --port 7690
```

Manual unit install from template:

```bash
# render placeholders (__WORKDIR__, __HOME__, __NODE_PATH__, __NODE_BIN__, __USER__, __GROUP__)
# or use scripts/install.sh --no-start and copy the generated unit
cp "$REPO/systemd/pocket-term-2.service.generated" /etc/systemd/system/pocket-term-2.service
# user unit alternative:
# cp "$REPO/systemd/pocket-term-2.service.generated" "$HOME/.config/systemd/user/pocket-term-2.service"

systemctl daemon-reload          # or: systemctl --user daemon-reload
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

## B. Public path via reverse proxy / cloudflared (human-approved window)

### 1. Backup

```bash
ts=$(date +%Y%m%dT%H%M%S)
cp -a /etc/cloudflared/config.yml "/etc/cloudflared/config.yml.bak-${ts}"
```

### 2. Insert path rule

Add a **path-specific** ingress **before** the hostname catch-all that serves any existing web terminal, for example:

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
| `herdr: disconnected` in SPA / state | herdr server, socket path (`PT2_HERDR_SOCK`), `journalctl -u pocket-term-2` |
| `protocol_mismatch: true` | herdr upgraded; bridge still serves but UI may degrade |
| Empty summaries | Tier B seed read failed; pane.read errors in journal |
| 502 on `/herd` | bridge down or proxy rule points wrong port |
| `/` or `/up` broken after deploy | ingress order wrong — restore backup immediately |
| Web Push button says `push_not_configured` | all three `PT2_VAPID_*` environment values are required; generate with `scripts/gen-vapid.sh` |
| Worker registration fails | confirm `/herd/sw.js` returns JavaScript (not an Access login response) and `Cache-Control: no-store` |

## D. Security notes

- Bridge must not listen on `0.0.0.0` in production.
- herdr write surface is limited to `pane.send_text` / `pane.send_keys` (keys hard-forced to `['enter']` only). `pane.run` is CLI sugar, not a socket method. Other write methods stay off the whitelist.
- `POST /herd/api/pane/:id/send` is same-origin only (missing Origin/Referer rejected), body ≤8KB, 2s per-pane rate limit, pane must exist in the current snapshot.
- Transcript paths are constrained under `PT2_PROJECTS_ROOT` (default `$HOME/.claude/projects`); `..` segments rejected.
- Static files under `/herd/` are realpath-checked to stay inside `public/`.

## E. PT2_READONLY fuse (write channel rollback)

Directed send (`POST /herd/api/pane/:id/send` → herdr `pane.send_text` + `pane.send_keys` Enter). To instantly return to read-only behavior without a code revert:

```bash
# systemd drop-in, unit Environment=, or state/pt2.env:
Environment=PT2_READONLY=1

systemctl daemon-reload
systemctl restart pocket-term-2   # only after human approval to restart
```

Effects when `PT2_READONLY=1` (or `true`):

- Send endpoint responds `403 {"error":"readonly"}` before any herdr write.
- Bridge constructs `createClient({ allowWrite: false })` — write methods never reach the socket.
- Read APIs (`/state`, `/events`, `/messages`, static SPA) keep working.

Disable the fuse (re-enable send after review):

```bash
# remove PT2_READONLY from the unit / drop-in / env file, then:
systemctl daemon-reload
systemctl restart pocket-term-2   # human-approved restart only
```

**Do not restart any service from agent automation** unless a human has explicitly approved that restart for this host.
