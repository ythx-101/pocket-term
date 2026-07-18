/**
 * Live bridge tests against herdr.sock (read-only via herdr-client).
 * Server binds a random high port; t.after cleans up.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** @type {Awaited<ReturnType<typeof startServer>>} */
let srv;
let base;
let stateDir;

before(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-state-'));
  srv = await startServer({
    host: '127.0.0.1',
    port: 0, // ephemeral
    stateDir,
  });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  if (srv) await srv.close();
  try {
    await fs.rm(stateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('bridge /herd/api/state', () => {
  it('returns 200 with panes array including w9:p8', async () => {
    // Snapshot refresh may need a moment after start
    let body;
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${base}/herd/api/state`);
      assert.equal(res.status, 200);
      body = await res.json();
      if (Array.isArray(body.panes) && body.panes.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(Array.isArray(body.panes), 'panes should be array');
    const ids = body.panes.map((p) => p.pane_id);
    assert.ok(ids.includes('w9:p8'), `expected w9:p8 in ${ids.join(',')}`);
    assert.ok('herdr' in body);
  });
});

describe('bridge /herd/api/events', () => {
  it('receives state event and heartbeat within 5s', async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 16000);
    try {
      const res = await fetch(`${base}/herd/api/events`, {
        signal: ac.signal,
        headers: { Accept: 'text/event-stream' },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let sawState = false;
      let sawHeartbeat = false;
      const deadline = Date.now() + 5000;

      while (Date.now() < deadline && !(sawState && sawHeartbeat)) {
        const remain = Math.max(50, deadline - Date.now());
        const readResult = await Promise.race([
          reader.read(),
          new Promise((resolve) =>
            setTimeout(() => resolve({ timeout: true }), remain)
          ),
        ]);
        if (readResult.timeout) break;
        const { value, done } = readResult;
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (/event:\s*state/.test(buf) || /"panes"\s*:/.test(buf)) {
          sawState = true;
        }
        // Heartbeat is SSE comment line `:heartbeat`
        if (/:heartbeat/.test(buf) || /:\s*heartbeat/.test(buf)) {
          sawHeartbeat = true;
        }
      }

      assert.ok(sawState, `expected state SSE within 5s, got: ${buf.slice(0, 200)}`);
      assert.ok(
        sawHeartbeat,
        `expected heartbeat comment within 5s; buffer=${buf.slice(0, 300)}`
      );

      await reader.cancel().catch(() => {});
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  });
});

describe('bridge messages + seen', () => {
  it('GET pane messages returns array (Tier B path)', async () => {
    const res = await fetch(`${base}/herd/api/pane/w9:p8/messages?limit=20`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body), 'messages response must be array');
  });

  it('POST seen flips unread for a done pane in state', async () => {
    const paneId = 'w9:p8';
    const m = srv.manager;
    m._internal.pushBubble(paneId, {
      ts: Date.now(),
      text: 'synthetic done output for unread test',
      role: 'agent',
    });
    // Force done + activity without last_seen → unread true
    m._internal.forcePaneStatus(paneId, 'done');

    const before = (await (await fetch(`${base}/herd/api/state`)).json()).panes.find(
      (p) => p.pane_id === paneId
    );
    assert.ok(before);
    assert.equal(before.unread, true);

    const post = await fetch(`${base}/herd/api/seen/${encodeURIComponent(paneId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(post.status, 200);
    const seenBody = await post.json();
    assert.equal(seenBody.pane_id, paneId);
    assert.ok(seenBody.last_seen > 0);

    const after = (await (await fetch(`${base}/herd/api/state`)).json()).panes.find(
      (p) => p.pane_id === paneId
    );
    assert.ok(after);
    assert.equal(after.unread, false);
  });
});

describe('bridge static safety', () => {
  it('serves placeholder index at /herd/', async () => {
    const res = await fetch(`${base}/herd/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /pocket-term-2/i);
  });

  it('rejects path traversal under /herd', async () => {
    const tries = [
      `${base}/herd/../etc/passwd`,
      `${base}/herd/%2e%2e/%2e%2e/etc/passwd`,
      `${base}/herd/../../../../etc/passwd`,
    ];
    for (const url of tries) {
      const res = await fetch(url, { redirect: 'manual' });
      assert.ok(
        res.status === 403 || res.status === 404,
        `expected reject for ${url}, got ${res.status}`
      );
      const text = await res.text();
      assert.ok(!text.includes('root:'), 'must not leak passwd content');
    }
  });

  it('404 for unknown api', async () => {
    const res = await fetch(`${base}/herd/api/nope`);
    assert.equal(res.status, 404);
  });
});
