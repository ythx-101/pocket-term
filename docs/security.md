# pocket-term Security

## Threat model

**A web terminal = complete shell access to your machine.** Anyone who authenticates
to the terminal can run arbitrary commands as the user running ttyd. This is not a
"view-only" tool — treat it like handing someone your keyboard.

### Assets protected

| Asset | Protection |
|-------|-----------|
| Shell access | Basic auth (`ttyd -c`) on every tier |
| File uploads | Basic auth + extension whitelist + path sanitization |
| Credentials file | `chmod 600`, stored in `<prefix>/credentials` |
| Network exposure | ttyd binds `127.0.0.1` only — never a public interface |

### Attack surface

| Vector | Mitigation |
|--------|-----------|
| Password in `ps` output | ttyd 1.6.3 passes `-c` via argv, visible to same-user processes on the local machine. Acceptable on single-user machines. For multi-user, use L1 **serve-only** (zero public exposure). Recorded in known limitations. |
| Anonymous tunnel access | Tunnel is transport-only. Auth is `ttyd -c` — the tunnel URL alone gives a 401 page. |
| Path traversal in upload | `os.path.basename()` + `re.sub(r"[^\w.\-]", "_", name)` sanitizes filenames. |
| Concurrent upload overwrite | `os.open(..., O_EXCL)` ensures atomic create-or-fail. |
| Symlink following | `os.fstat(fd)` checks for regular file before write. |
| Oversized uploads | `Content-Length` checked against `MAX_BYTES` before reading body. |

## Tier-by-tier security

### L0 — Quick Tunnel
- **Auth**: `ttyd -c user:password` (24-char random)
- **Tunnel**: Cloudflare Quick Tunnel (random `*.trycloudflare.com` URL)
- **Risk**: URL is guessable if someone sniffs Cloudflare's edge. Mitigated by 24-char password.
- **Duration**: Process lifetime. Ctrl-C = tunnel gone, ttyd stopped.

### L1 — Tailscale Serve/Funnel
- **Auth**: `ttyd -c user:password` (24-char random, persisted)
- **Serve**: Only accessible from your Tailscale tailnet (zero public exposure). This is the recommended default.
- **Funnel**: Public internet + password. Use only when you need external access.
- **/up**: Shares ttyd credentials via Basic auth. Browser auto-sends credential on same origin.
- **systemd**: Two sandbox profiles:
  - `pocket-term.service`: Mild (NoNewPrivileges, PrivateTmp, UMask=0077). Interactive shell needs full filesystem.
  - `pocket-term-upload.service`: Strict (NoNewPrivileges, ProtectSystem=strict, `ProtectHome=tmpfs`, UMask=0077). `ProtectHome=tmpfs` hides the rest of `$HOME` behind an empty ephemeral mount; `BindPaths`/`BindReadOnlyPaths` punch through only the upload directory (read-write) and the credentials file (read-only). Verified with a real `systemd-run` test — see `docs/test-evidence.md`.
- **macOS upload is manual-only**: `install-l1.sh --with-upload` on Darwin writes the upload server and credentials but does not install a launchd job for it (only the ttyd terminal gets one). Start it by hand — see `AGENTS.md` for the exact command.

### L2 — Cloudflare Access + Named Tunnel
- **Auth**: Two-layer — Cloudflare Access (email/OIDC) at the edge, then `ttyd -c` at the origin.
- **Defense in depth**: Even if CF Access is bypassed, Basic auth still required.
- See `docs/L2-advanced.md` for configuration templates.

## Known limitations

### Password in process list
ttyd 1.6.3 receives credentials via `-c user:password` command-line argument.
On Linux, any user on the same machine can see this with `ps aux`. This is
acceptable for single-user machines. For shared machines:

- Use L1 **serve-only** mode (Tailscale tailnet, zero public exposure).
- Or upgrade to ttyd >=1.7.x which supports `-H` (auth header from reverse proxy) — note this is experimental and the enhanced page hasn't been validated for 1.7.x.

### systemd ProtectHome + BindReadOnlyPaths pitfall
`ProtectHome=true` (or its default `yes`) makes `/home`, `/root`, and
`/run/user` fully **inaccessible** — and a `BindReadOnlyPaths=` entry whose
source is under one of those directories fails with "No such file or
directory" even though the source file genuinely exists, because the bind
target can't be created inside an already-inaccessible tree. Confirmed with
`systemd-run` (see `docs/test-evidence.md`). `pocket-term-upload.service`
uses `ProtectHome=tmpfs` instead: it hides the tree the same way but still
lets `BindPaths=`/`BindReadOnlyPaths=` mount specific paths back in. If you
ever change this back to `read-only`, note that mode does *not* need the bind
at all (the whole home tree stays readable) — which is weaker isolation, not
stronger, so prefer `tmpfs`.

### No HTTPS on 127.0.0.1
ttyd serves plain HTTP on localhost. The tunnel (quick tunnel/serve/funnel)
provides TLS termination. An attacker on the same machine could sniff localhost
traffic — but if they're on your machine, you have bigger problems.

## Responsible disclosure

Found a security issue? Open a GitHub issue or email the maintainers.
Do not disclose publicly until a fix is available.
