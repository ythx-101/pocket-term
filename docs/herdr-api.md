# herdr socket API notes (P0)

Read-only wire notes used by `lib/herdr-client.js`.

- **Endpoint**: Unix domain socket, default `/root/.config/herdr/herdr.sock` (injectable).
- **Framing**: newline-delimited JSON. One short-lived connection per RPC request.
- **Request**: `{"id":"<uuid>","method":"<name>","params":{...}}\n`
- **Response**: `{"id":"...","result":{...}}` or `{"id":"...","error":{"code":"...","message":"..."}}`.
- **ping**: result `{type:"pong",version,protocol,capabilities}`; M0 expects `protocol === 16`.
- **session.snapshot**: result `{type, snapshot}` where `snapshot` has `workspaces`, `tabs`, `panes`, `agents`, layouts, focus ids.
- **pane.read**: params `{pane_id, source, lines, format?}`; text lives at `result.read.text`. Sources: `visible|recent|recent_unwrapped|detection`.
- **events.subscribe**: long-lived connection. First reply `result.type === "subscription_started"`, then event lines (`{"data":{...}}`). May replay backlog; treat events as triggers, truth from snapshot.
- **events.wait**: one-shot block for a match (e.g. `pane_output_changed`); also newline-JSON over a single connection.
- **Whitelist (code-enforced)**:
  - Read-only (always): `ping`, `session.snapshot`, `pane.read`, `events.subscribe`, `events.wait`.
  - Write (only when `createClient({ allowWrite: true })`, and only if `PT2_READONLY` is unset): `pane.send_text`, `pane.send_keys` (keys hard-forced to `['enter']` only — never client-supplied keys). `pane.run` is CLI sugar and is **not** a socket method.
  - All other write methods (close/create/arbitrary keys/…) stay rejected client-side and never hit the socket.
  - Error replies: reject on **any** `{error}` payload regardless of `id` (herdr returns `id:""` for some `invalid_request` / unknown-method replies).
