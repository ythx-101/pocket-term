# pocket-term-2

**中文** | **English** below.

`pocket-term-2` 是 **pocket-term 产品线** 的第二个产品：把 [herdr](https://github.com/) agent 舰队做成微信式会话客户端——在手机上浏览会话列表、点进某个 pane 看消息气泡、看状态灯与未读，而不是再嵌一整屏共享终端。支持页内通知，并可选启用标准 Web Push。

数据主要来自 herdr Unix socket +（可选）Claude Code 会话 JSONL。Bridge 的应用状态写入限制在忽略版本控制的 `state/`；Web Push 订阅只写入 `state/push-subscriptions.json`。

---

## Product (EN)

**pocket-term-2** is the second app in the **pocket-term product line**: a WeChat-style chat front-end for your herdr agent fleet. The browser talks only to a small local Node bridge; the bridge talks to `herdr.sock` with a hard-coded **read-only** method whitelist.

The bridge supports guarded pane sends and optional Web Push; its emergency `PT2_READONLY` fuse remains available.

---

## Architecture

```
Browser ──(CF Access)── reverse proxy ──► 127.0.0.1:7690  pocket-term-2 bridge
                                              │
                                              ├─ GET  /herd/            SPA
                                              ├─ GET  /herd/api/state
                                              ├─ GET  /herd/api/pane/:id/messages
                                              ├─ GET  /herd/api/events  (SSE)
                                              └─ POST /herd/api/seen/:id
                                              │
                                              ▼
                                         herdr.sock (read-only RPC + subscribe)
                                              │
                                              └─ ~/.claude/projects/**.jsonl  (Tier A, optional)
```

- **Tier A**: Claude transcript JSONL → real user/agent/tool bubbles (when `agent_session` is present).
- **Tier B**: `pane.read` screen diffs → monospace stream cards (fallback for any pane).

---

## HTTP endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/herd/` | Chat SPA (static) |
| GET | `/herd/api/state` | Session list JSON |
| GET | `/herd/api/pane/:id/messages?before=&limit=` | Bubble history |
| GET | `/herd/api/events` | SSE (`state`, `bubble`, `:heartbeat`) |
| POST | `/herd/api/seen/:id` | Mark pane seen (writes `state/last-seen.json` only) |
| GET | `/herd/api/push/vapid-public` | Web Push public key (503 when unconfigured) |
| POST | `/herd/api/push/subscribe` | Register a same-origin browser subscription |
| DELETE | `/herd/api/push/subscribe` | Remove a same-origin browser subscription |

Default bind: `PT2_HOST=127.0.0.1` `PT2_PORT=7690` (override via env).

---

## Local run

Requirements: **Node.js ≥ 20**, a running herdr server with its Unix socket.

```bash
cd /path/to/pocket-term-2
# optional:
# export PT2_HOST=127.0.0.1 PT2_PORT=7690
# export PT2_HERDR_SOCK=/path/to/herdr.sock
node server.js
# open http://127.0.0.1:7690/herd/
```

Smoke (against a running instance):

```bash
PT2_BASE=http://127.0.0.1:7690 ./scripts/smoke.sh
```

---

## Tests

The runtime uses the maintained `web-push` package; tests use Node's built-in runner:

```bash
node --test test/**/*.test.mjs
# or
npm test
```

## Optional Web Push

Set `PT2_VAPID_SUBJECT`, `PT2_VAPID_PUBLIC_KEY`, and `PT2_VAPID_PRIVATE_KEY` in the deployment environment. Generate and manage these outside the repository; never commit them. Browser subscriptions are stored only in ignored `state/push-subscriptions.json`. Without all three variables, Web Push reports `push_not_configured` and the existing page banner/badge fallback continues normally.

The worker is served at `/herd/sw.js`, scoped to `/herd/`, and displays notifications entirely from the encrypted push payload without fetching an Access-protected API.

Live tests that touch herdr use **read-only** methods only (`ping`, `session.snapshot`, `pane.read`, `events.*`).

---

## systemd (install later — not done by the app itself)

Unit file lives in-repo at `systemd/pocket-term-2.service`. Install on the host (example):

```bash
sudo cp systemd/pocket-term-2.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pocket-term-2
```

See `docs/ops.md` for deploy / rollback runbook.

---

## cloudflared ingress (example)

Do **not** commit private hostnames. Pattern only:

```yaml
# example — path front door to local bridge
ingress:
  - hostname: term.example.com
    path: ^/herd(/.*)?$
    service: http://127.0.0.1:7690
  - hostname: term.example.com
    path: ^/up$
    service: http://127.0.0.1:7699
  - hostname: term.example.com
    service: http://127.0.0.1:7681
  - service: http_status:404
```

Validate config, restart tunnel, then health-check `/herd/api/state`, existing `/`, and `/up` (see ops runbook).

---

## License / lineage

Part of the **pocket-term** open-source product line (pocket terminal → pocket agent fleet chat). Code and docs are written to be publishable: no hardcoded private domains, tokens, or machine-local secrets in source.
