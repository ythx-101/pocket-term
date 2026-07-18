# pocket-term-2

**中文** | **English** below.

`pocket-term-2` 是 **pocket-term 产品线** 的第二个产品：把 [herdr](https://github.com/) agent 舰队做成微信式会话客户端——在手机上浏览会话列表、点进某个 pane 看消息气泡、看状态灯与未读，而不是再嵌一整屏共享终端。

本仓库是 **M0 只读** 实现：数据全部来自 herdr Unix socket 的读接口 +（可选）Claude Code 会话 JSONL；唯一的“写”是 bridge 自己的 `state/last-seen.json`（标记已读）。发送指令属于 M1，不在本阶段。

---

## Product (EN)

**pocket-term-2** is the second app in the **pocket-term product line**: a WeChat-style chat front-end for your herdr agent fleet. The browser talks only to a small local Node bridge; the bridge talks to `herdr.sock` with a hard-coded **read-only** method whitelist.

M0 is read-only. Sending prompts is deferred to M1.

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

Zero npm dependencies. Built-in test runner only:

```bash
node --test test/**/*.test.mjs
# or
npm test
```

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
