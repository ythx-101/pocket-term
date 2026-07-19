/**
 * M2.7-P1: H1 reconnect subscription, H2 notify push prefs,
 * M3 bubble id uniqueness past 200, UX#1 enterkeyhint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateManager } from '../lib/state-manager.js';
import { createPushService } from '../lib/push-service.js';
import { startServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const subscription = {
  endpoint: 'https://push.example.test/send/m27',
  expirationTime: null,
  keys: { p256dh: 'Abc_123-xyz', auth: 'auth_123' },
};
const pushConfig = {
  configured: true,
  subject: 'mailto:test@example.test',
  publicKey: 'public-test',
  privateKey: 'private-test',
};

function snapshotWithPane(paneId = 'w1:p1') {
  return {
    type: 'snapshot',
    snapshot: {
      panes: [
        {
          pane_id: paneId,
          agent: 'grok',
          agent_status: 'idle',
          label: 't',
        },
      ],
      workspaces: [],
      tabs: [],
    },
  };
}

describe('H1: reconnect rebuilds events.subscribe for same pane set', () => {
  it(
    'dead subHandle + reconnect re-calls subscribe even when pane ids unchanged',
    { timeout: 10_000 },
    async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-h1-'));
      const stateDir = path.join(tmp, 'state');
      await fs.mkdir(stateDir);

      /** @type {{ dead: boolean, close: () => void, _check?: unknown }[]} */
      const handles = [];
      let subscribeCalls = 0;

      const client = {
        // Hang events.wait on AbortSignal so the output loop does not busy-spin
        // and starve the 1s dead-handle check interval.
        rpc(method, _params, opts = {}) {
          if (method === 'ping') return Promise.resolve({ type: 'pong', protocol: 16 });
          if (method === 'session.snapshot') {
            return Promise.resolve(snapshotWithPane('w1:p1'));
          }
          if (method === 'pane.read') {
            return Promise.resolve({ type: 'pane_read', read: { text: 'seed\n' } });
          }
          if (method === 'events.wait') {
            return new Promise((_resolve, reject) => {
              const onAbort = () => {
                const err = new Error('aborted');
                err.code = 'aborted';
                reject(err);
              };
              if (opts.signal?.aborted) {
                onAbort();
                return;
              }
              opts.signal?.addEventListener('abort', onAbort, { once: true });
              // Long hang (aborted on stop); do not tight-loop timeout.
              setTimeout(() => {
                const err = new Error('timeout');
                err.code = 'timeout';
                reject(err);
              }, 60_000).unref?.();
            });
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
        subscribe: () => {
          subscribeCalls += 1;
          const h = { dead: false, close() {} };
          handles.push(h);
          return h;
        },
      };

      const mgr = createStateManager({
        client,
        stateDir,
        allowedRoot: tmp,
        // Short reconnect so the test finishes quickly (prod default 5s).
        reconnectMs: 50,
      });
      try {
        await mgr.start();
        // Wait until first subscription is established
        for (let i = 0; i < 50 && subscribeCalls < 1; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.ok(subscribeCalls >= 1, 'initial subscribe expected');
        const afterStart = subscribeCalls;
        assert.ok(handles.length >= 1, 'handle recorded');

        // Inject dead handle — same pane set will return on reconnect.
        handles[handles.length - 1].dead = true;

        // Dead-check interval is 1s; reconnectMs is 50ms; allow headroom.
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && subscribeCalls <= afterStart) {
          await new Promise((r) => setTimeout(r, 50));
        }

        assert.ok(
          subscribeCalls > afterStart,
          `expected re-subscribe after dead reconnect, got ${subscribeCalls} (was ${afterStart})`
        );
      } finally {
        await mgr.stop();
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
  );
});

describe('H2: push prefs filter dispatch (Web Push only)', () => {
  it('skips done when prefs.done=false; sends when true; blocked same', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-h2-prefs-'));
    /** @type {string[]} */
    const sent = [];
    try {
      const service = await createPushService({
        stateDir: dir,
        config: pushConfig,
        sender: async (sub, payload) => {
          sent.push(`${sub.endpoint}|${JSON.parse(payload).status}`);
        },
      });

      await service.subscribe({
        ...subscription,
        prefs: { blocked: true, done: false },
      });

      // done=false → no push
      let r = await service.dispatch({ paneId: 'w9:p1', status: 'done' });
      assert.deepEqual(r, { sent: 0, failed: 0, pruned: 0 });
      assert.equal(sent.length, 0);

      // blocked=true → push
      r = await service.dispatch({ paneId: 'w9:p1', status: 'blocked' });
      assert.deepEqual(r, { sent: 1, failed: 0, pruned: 0 });
      assert.equal(sent.length, 1);
      assert.match(sent[0], /blocked$/);

      // Flip prefs: done on, blocked off
      assert.equal(
        (await service.updatePrefs(subscription.endpoint, {
          blocked: false,
          done: true,
        })).ok,
        true
      );

      sent.length = 0;
      r = await service.dispatch({ paneId: 'w9:p1', status: 'blocked' });
      assert.equal(r.sent, 0);
      r = await service.dispatch({ paneId: 'w9:p1', status: 'done' });
      assert.equal(r.sent, 1);
      assert.match(sent[0], /done$/);

      // Prefs survive reload
      const reloaded = await createPushService({
        stateDir: dir,
        config: pushConfig,
        sender: async () => {},
      });
      const r2 = await reloaded.dispatch({ paneId: 'w9:p1', status: 'blocked' });
      assert.equal(r2.sent, 0, 'reloaded prefs.blocked=false must still filter');
      const r3 = await reloaded.dispatch({ paneId: 'w9:p1', status: 'done' });
      assert.equal(r3.sent, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('POST /herd/api/push/prefs is same-origin guarded and updates prefs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-h2-http-'));
    /** @type {unknown[]} */
    const calls = [];
    const pushService = {
      configured: true,
      publicKey: 'public-only',
      dispatch: async () => ({}),
      subscribe: async (body) => {
        calls.push(['post', body]);
        return { ok: true };
      },
      unsubscribe: async (endpoint) => {
        calls.push(['delete', endpoint]);
        return { ok: true, deleted: true };
      },
      updatePrefs: async (endpoint, prefs) => {
        calls.push(['prefs', endpoint, prefs]);
        return { ok: true };
      },
    };
    const srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir: dir,
      client: {
        rpc: async (method) =>
          method === 'ping'
            ? { protocol: 16, version: 'test' }
            : method === 'session.snapshot'
              ? { snapshot: { workspaces: [], tabs: [], panes: [] } }
              : method === 'pane.read'
                ? { read: { text: '' } }
                : {},
        subscribe: () => ({ dead: false, close() {} }),
      },
      pushService,
    });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const denied = await fetch(`${base}/herd/api/push/prefs`, {
        method: 'POST',
        body: '{}',
      });
      assert.equal(denied.status, 403);

      const headers = {
        Origin: base,
        'Content-Type': 'application/json',
      };
      const ok = await fetch(`${base}/herd/api/push/prefs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          prefs: { blocked: false, done: true },
        }),
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(calls, [
        [
          'prefs',
          subscription.endpoint,
          { blocked: false, done: true },
        ],
      ]);
    } finally {
      srv.server.closeAllConnections?.();
      await srv.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('M3: bubble ids unique past BUBBLE_LIMIT (200)', () => {
  it('>200 pushes with shared ts still yield all-unique ids', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-m3-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);

    const mgr = createStateManager({
      client: {
        rpc: async () => {
          throw new Error('no rpc');
        },
        subscribe: () => ({ dead: false, close() {} }),
      },
      stateDir,
      allowedRoot: tmp,
    });
    try {
      const paneId = 'w2:p3';
      const sharedTs = 1_700_000_000_000;
      const N = 220;
      for (let i = 0; i < N; i++) {
        // Alternate ts so two bubbles share the same ts at the end of the ring
        const ts = i >= N - 2 ? sharedTs : sharedTs + i;
        mgr._internal.pushBubble(paneId, {
          ts,
          text: `msg-${i}`,
          role: 'agent',
        });
      }
      const rt = mgr._internal.ensureRuntime(paneId);
      assert.equal(rt.buffer.length, 200, 'ring buffer caps at 200');
      const ids = rt.buffer.map((b) => b.id);
      const unique = new Set(ids);
      assert.equal(
        unique.size,
        ids.length,
        `duplicate bubble ids after >200 pushes: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`
      );
      // The two same-ts entries at the end of the push sequence must both still
      // be in the buffer (last 200 of 220) and must not collide.
      const sameTs = rt.buffer.filter((b) => b.ts === sharedTs);
      assert.ok(sameTs.length >= 2, 'at least two bubbles with shared ts remain');
      assert.equal(
        new Set(sameTs.map((b) => b.id)).size,
        sameTs.length,
        'same-ts bubbles must still have distinct ids'
      );
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('UX#1: composer enterkeyhint matches Enter=newline', () => {
  it('textarea enterkeyhint is enter, not send', async () => {
    const html = await fs.readFile(
      path.join(__dirname, '..', 'public', 'index.html'),
      'utf8'
    );
    assert.match(
      html,
      /id="composer-input"[\s\S]*?enterkeyhint="enter"/,
      'composer must hint enter (newline), not send'
    );
    assert.doesNotMatch(
      html,
      /id="composer-input"[\s\S]*?enterkeyhint="send"/,
      'enterkeyhint=send is the trap (soft key says send, Enter only newlines)'
    );
  });
});
