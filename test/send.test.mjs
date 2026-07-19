/**
 * M1 send channel: guards + scratch-pane live send.
 * Hard rule: only send to a scratch pane this file creates and closes.
 * Never target other agents' panes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../server.js';
import {
  createStateManager,
  isDuplicateUserMessage,
  USER_BUBBLE_DEDUPE_MS,
} from '../lib/state-manager.js';
import { createClient, DEFAULT_SOCKET_PATH } from '../lib/herdr-client.js';

const execFileAsync = promisify(execFile);

const MY_PANE = process.env.HERDR_PANE_ID || 'w9:pJ';

/**
 * @param {string[]} args
 */
async function herdrJson(...args) {
  const { stdout } = await execFileAsync('herdr', args, {
    encoding: 'utf8',
    timeout: 15000,
    env: process.env,
  });
  return JSON.parse(stdout);
}

/**
 * @param {string} base
 * @param {string} paneId
 * @param {object} body
 * @param {Record<string, string>} [headers]
 */
async function postSend(base, paneId, body, headers = {}) {
  const origin =
    headers.Origin ?? headers.origin ?? `http://127.0.0.1`;
  const url = new URL(base);
  // Match host:port for same-origin
  const sameOrigin = `http://${url.host}`;
  const res = await fetch(
    `${base}/herd/api/pane/${encodeURIComponent(paneId)}/send`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: headers.Origin !== undefined ? headers.Origin : sameOrigin,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { res, json, text };
}

describe('isDuplicateUserMessage (Tier A optimistic dedupe)', () => {
  it('detects same text within ±10s from recentUserSends or buffer', () => {
    const now = Date.now();
    const rt = {
      buffer: [{ role: 'user', text: 'hello', ts: now }],
      recentUserSends: [],
    };
    assert.equal(isDuplicateUserMessage(rt, 'hello', now + 1000), true);
    assert.equal(isDuplicateUserMessage(rt, 'hello', now + USER_BUBBLE_DEDUPE_MS + 1), false);
    assert.equal(isDuplicateUserMessage(rt, 'other', now), false);

    const rt2 = {
      buffer: [],
      recentUserSends: [{ text: 'sent', ts: now }],
    };
    assert.equal(isDuplicateUserMessage(rt2, 'sent', now + 5000), true);
    assert.equal(isDuplicateUserMessage(rt2, 'sent', now - 5000), true);
  });

  it('ingestPaneOutput skips duplicate transcript user messages', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-user-dedupe-'));
    const sub = path.join(tmp, 'proj');
    await fs.mkdir(sub, { recursive: true });
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const jsonl = path.join(sub, `${id}.jsonl`);
    const userText = 'optimistic-user-text';
    const tsIso = new Date().toISOString();
    await fs.writeFile(
      jsonl,
      JSON.stringify({
        type: 'user',
        timestamp: tsIso,
        message: { role: 'user', content: userText },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          timestamp: tsIso,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'agent reply' }],
          },
        }) +
        '\n',
      'utf8'
    );
    // content string form is valid (see fixtures); extractUserText handles it.
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);

    const client = {
      rpc: async (method) => {
        if (method === 'pane.read') {
          return { type: 'pane_read', read: { text: '' } };
        }
        throw new Error(`unexpected ${method}`);
      },
      subscribe: () => ({ dead: false, close() {} }),
    };

    const mgr = createStateManager({
      client,
      stateDir,
      allowedRoot: tmp,
    });
    try {
      await mgr._internal.resolvePaneTranscript({
        pane_id: 'w1:p1',
        agent_session: {
          source: 'herdr:claude',
          agent: 'claude',
          kind: 'id',
          value: id,
        },
      });
      const rt = mgr._internal.ensureRuntime('w1:p1');
      const sendTs = Date.parse(tsIso) || Date.now();
      // Simulate optimistic bubble already on screen
      rt.recentUserSends = [{ text: userText, ts: sendTs }];
      mgr._internal.pushBubble('w1:p1', {
        ts: sendTs,
        text: userText,
        role: 'user',
      });
      assert.equal(rt.buffer.filter((b) => b.role === 'user').length, 1);

      await mgr._internal.ingestPaneOutput('w1:p1');
      const users = rt.buffer.filter((b) => b.role === 'user');
      assert.equal(users.length, 1, 'must not double-insert user bubble');
      assert.ok(rt.buffer.some((b) => b.role === 'agent' && /agent reply/.test(b.text)));
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('POST /herd/api/pane/:id/send guards', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let srv;
  let base;
  let stateDir;
  /** mock client for guard tests (no real herdr writes) */
  let lastRpc;

  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-send-'));
    lastRpc = null;
    const mockClient = {
      allowWrite: true,
      rpc: async (method, params, callOpts = {}) => {
        lastRpc = { method, params };
        if (method === 'ping') {
          return { type: 'pong', protocol: 16, version: '0.7.3' };
        }
        if (method === 'session.snapshot') {
          return {
            type: 'session_snapshot',
            snapshot: {
              workspaces: [],
              tabs: [],
              panes: [{ pane_id: 'w0:p0', agent_status: 'unknown' }],
              agents: [],
              focused_pane_id: null,
            },
          };
        }
        if (method === 'pane.read') {
          return { type: 'pane_read', read: { text: '' } };
        }
        if (method === 'events.wait') {
          // Avoid tight output-loop spin: sleep then timeout like real herdr.
          await new Promise((resolve, reject) => {
            const ms = 200;
            const t = setTimeout(resolve, ms);
            const sig = callOpts.signal;
            if (sig) {
              const onAbort = () => {
                clearTimeout(t);
                const err = new Error('aborted');
                err.code = 'aborted';
                reject(err);
              };
              if (sig.aborted) {
                onAbort();
                return;
              }
              sig.addEventListener('abort', onAbort, { once: true });
            }
          });
          const err = new Error('timeout');
          err.code = 'timeout';
          throw err;
        }
        if (method === 'pane.send_text' || method === 'pane.run') {
          return { type: 'ok' };
        }
        const err = new Error(`unexpected ${method}`);
        err.code = 'method_not_allowed';
        throw err;
      },
      subscribe: () => ({ dead: false, close() {} }),
    };
    srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir,
      client: mockClient,
    });
    base = `http://127.0.0.1:${srv.port}`;
    // wait for snapshot
    for (let i = 0; i < 30; i++) {
      const st = await (await fetch(`${base}/herd/api/state`)).json();
      if (st.panes?.some((p) => p.pane_id === 'w0:p0')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(async () => {
    if (srv) await srv.close();
    try {
      await fs.rm(stateDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects cross-origin / missing Origin (403)', async () => {
    const { res, json } = await postSend(
      base,
      'w0:p0',
      { text: 'x' },
      { Origin: 'https://evil.example' }
    );
    assert.equal(res.status, 403);
    assert.equal(json.error, 'cross_origin');

    // missing Origin and Referer
    const res2 = await fetch(`${base}/herd/api/pane/w0:p0/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(res2.status, 403);
    const j2 = await res2.json();
    assert.equal(j2.error, 'cross_origin');
  });

  it('rejects body > 8KB with 413', async () => {
    const big = 'x'.repeat(9 * 1024);
    const { res, json } = await postSend(base, 'w0:p0', { text: big });
    assert.equal(res.status, 413);
    assert.equal(json.error, 'payload_too_large');
  });

  it('rejects unknown pane with 404', async () => {
    const { res, json } = await postSend(base, 'w99:p99', { text: 'hi' });
    assert.equal(res.status, 404);
    assert.equal(json.error, 'pane_not_found');
  });

  it('rate limits second send within 2s (429 + Retry-After)', async () => {
    const first = await postSend(base, 'w0:p0', { text: 'first' });
    assert.equal(first.res.status, 200);
    assert.equal(first.json.sent, true);

    const second = await postSend(base, 'w0:p0', { text: 'second' });
    assert.equal(second.res.status, 429);
    assert.equal(second.json.error, 'rate_limited');
    const ra = second.res.headers.get('retry-after');
    assert.ok(ra != null && Number(ra) >= 1, `Retry-After=${ra}`);
  });
});

describe('PT2_READONLY send fuse', () => {
  it('returns 403 readonly and does not open allowWrite', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-ro-'));
    const mockClient = {
      allowWrite: false,
      rpc: async (method, _params, callOpts = {}) => {
        if (method === 'ping') return { type: 'pong', protocol: 16 };
        if (method === 'session.snapshot') {
          return {
            snapshot: {
              workspaces: [],
              tabs: [],
              panes: [{ pane_id: 'w0:p0' }],
              agents: [],
            },
          };
        }
        if (method === 'pane.read') return { read: { text: '' } };
        if (method === 'events.wait') {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 200);
            const sig = callOpts.signal;
            if (sig) {
              const onAbort = () => {
                clearTimeout(t);
                const err = new Error('aborted');
                err.code = 'aborted';
                reject(err);
              };
              if (sig.aborted) {
                onAbort();
                return;
              }
              sig.addEventListener('abort', onAbort, { once: true });
            }
          });
          const err = new Error('timeout');
          err.code = 'timeout';
          throw err;
        }
        if (method === 'pane.send_text' || method === 'pane.run') {
          throw new Error('must not send in readonly');
        }
        return {};
      },
      subscribe: () => ({ dead: false, close() {} }),
    };
    const srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir,
      client: mockClient,
      readonly: true,
    });
    try {
      assert.equal(srv.readonly, true);
      const base = `http://127.0.0.1:${srv.port}`;
      const { res, json } = await postSend(base, 'w0:p0', { text: 'nope' });
      assert.equal(res.status, 403);
      assert.equal(json.error, 'readonly');
    } finally {
      await srv.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('live send to self-owned scratch pane', () => {
  /** @type {string|null} */
  let scratchId = null;
  /** @type {Awaited<ReturnType<typeof startServer>>|null} */
  let srv = null;
  let stateDir = null;
  let base = null;

  before(async () => {
    // Create scratch by splitting OUR pane only (never other agents).
    const split = await herdrJson(
      'pane',
      'split',
      '--pane',
      MY_PANE,
      '--direction',
      'down',
      '--no-focus',
      '--ratio',
      '0.12'
    );
    scratchId = split?.result?.pane?.pane_id;
    assert.ok(scratchId, `expected scratch pane id from split: ${JSON.stringify(split)}`);
    // Let bash prompt settle before send.
    await new Promise((r) => setTimeout(r, 600));

    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-live-send-'));
    // Real herdr client with write for this integration test only.
    const client = createClient({
      socketPath: DEFAULT_SOCKET_PATH,
      allowWrite: true,
    });
    srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir,
      client,
    });
    base = `http://127.0.0.1:${srv.port}`;

    // Wait until scratch appears in bridge snapshot
    let found = false;
    for (let i = 0; i < 40; i++) {
      const st = await (await fetch(`${base}/herd/api/state`)).json();
      if (st.panes?.some((p) => p.pane_id === scratchId)) {
        found = true;
        break;
      }
      // nudge refresh
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!found) {
      // force manager refresh via internal if needed
      try {
        await client.rpc('session.snapshot');
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  });

  after(async () => {
    if (srv) {
      try {
        await srv.close();
      } catch {
        /* ignore */
      }
    }
    if (stateDir) {
      try {
        await fs.rm(stateDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (scratchId) {
      try {
        await herdrJson('pane', 'close', scratchId);
      } catch {
        /* best-effort cleanup */
      }
      scratchId = null;
    }
  });

  it('POST echo m1-test → 200 + pane.read shows output + user bubble SSE', async () => {
    assert.ok(scratchId && srv && base);

    // Ensure pane in snapshot (may need a moment after split)
    let inSnap = false;
    for (let i = 0; i < 30; i++) {
      if (srv.manager.paneExists(scratchId)) {
        inSnap = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // If still missing, inject into manager snapshot from live herdr
    if (!inSnap) {
      const live = createClient({ socketPath: DEFAULT_SOCKET_PATH });
      const snapRes = await live.rpc('session.snapshot');
      const snap = snapRes?.snapshot ?? snapRes;
      srv.manager._internal.setSnapshot(snap);
      inSnap = srv.manager.paneExists(scratchId);
    }
    assert.ok(inSnap, `scratch ${scratchId} must be in snapshot`);

    // SSE listener for user bubble
    const ac = new AbortController();
    const sseRes = await fetch(`${base}/herd/api/events`, {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const dec = new TextDecoder();
    let sseBuf = '';
    /** @type {Promise<boolean>} */
    const bubblePromise = (async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
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
        sseBuf += dec.decode(value, { stream: true });
        if (
          /event:\s*bubble/.test(sseBuf) &&
          /"role"\s*:\s*"user"/.test(sseBuf) &&
          /echo m1-test/.test(sseBuf)
        ) {
          return true;
        }
      }
      return false;
    })();

    // Give SSE a moment to attach
    await new Promise((r) => setTimeout(r, 100));

    const { res, json } = await postSend(base, scratchId, {
      text: 'echo m1-test',
      mode: 'run',
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.sent, true);

    // pane.read via read-only client. New scratch panes often have empty
    // `recent` scrollback; `visible` / `detection` show the live screen.
    const ro = createClient({ socketPath: DEFAULT_SOCKET_PATH });
    let sawOutput = false;
    let lastText = '';
    for (let i = 0; i < 25; i++) {
      for (const source of ['visible', 'detection', 'recent']) {
        const read = await ro.rpc('pane.read', {
          pane_id: scratchId,
          source,
          lines: 40,
        });
        const text = read?.read?.text ?? read?.text ?? '';
        if (typeof text === 'string' && text.length) lastText = text;
        if (typeof text === 'string' && text.includes('m1-test')) {
          sawOutput = true;
          break;
        }
      }
      if (sawOutput) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(
      sawOutput,
      `pane.read should show m1-test output on scratch pane; last=${JSON.stringify(lastText).slice(0, 200)}`
    );

    const sawBubble = await bubblePromise;
    await reader.cancel().catch(() => {});
    ac.abort();
    assert.ok(sawBubble, `expected user bubble SSE; buf=${sseBuf.slice(0, 400)}`);

    // Also in messages API
    const msgs = await (
      await fetch(
        `${base}/herd/api/pane/${encodeURIComponent(scratchId)}/messages?limit=20`
      )
    ).json();
    assert.ok(
      Array.isArray(msgs) &&
        msgs.some((m) => m.role === 'user' && /echo m1-test/.test(m.text || '')),
      'messages should include optimistic user bubble'
    );
  });
});
