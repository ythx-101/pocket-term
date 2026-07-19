/**
 * M2.7-P2 edge-case correctness: M4 B→A purge, M5 badge decay,
 * L8 seed offset race, L10 run Ctrl+U rollback, L7 HEAD empty body.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createStateManager,
  RUN_ENTER_DELAY_MS,
} from '../lib/state-manager.js';
import {
  initialNotifyState,
  reduceNotifications,
  pendingNotifyCount,
  purgeTierBStreamItems,
} from '../public/spa-utils.js';
import { startServer } from '../server.js';

const T0 = Date.parse('2026-07-19T12:00:00.000Z');

function pane(paneId, status) {
  return { pane_id: paneId, agent_status: status };
}

/** Collect SSE frames written to a fake ServerResponse. */
function makeSseSink() {
  /** @type {string[]} */
  const chunks = [];
  return {
    chunks,
    res: {
      write(s) {
        chunks.push(String(s));
        return true;
      },
      end() {},
    },
    events() {
      /** @type {Array<{ event: string, data: unknown }>} */
      const out = [];
      for (const c of chunks) {
        const em = c.match(/^event: (\w+)\ndata: (.*)\n\n$/s);
        if (em) {
          try {
            out.push({ event: em[1], data: JSON.parse(em[2]) });
          } catch {
            out.push({ event: em[1], data: em[2] });
          }
        }
      }
      return out;
    },
  };
}

describe('M4: B→A purge SSE + frontend stream reconcile', () => {
  it('purgeTierBStreamItems drops only stream cards', () => {
    const items = [
      { id: '1', text: 'screen card', stream: true, role: 'agent' },
      { id: '2', text: 'user hi', role: 'user' },
      { id: '3', text: 'from transcript', role: 'agent' },
      { id: '4', text: 'another stream', stream: true, role: 'agent' },
    ];
    const next = purgeTierBStreamItems(items);
    assert.deepEqual(
      next.map((b) => b.id),
      ['2', '3']
    );
    // Original not mutated
    assert.equal(items.length, 4);
  });

  it('B→A broadcasts purge; reconcile leaves no stream + Tier A duplicate body', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-m4-'));
    const sub = path.join(tmp, 'proj');
    await fs.mkdir(sub, { recursive: true });
    const id = 'eeeeeeee-ffff-aaaa-bbbb-222222222222';
    const jsonl = path.join(sub, `${id}.jsonl`);
    const body = '任务结果：已完成';
    await fs.writeFile(
      jsonl,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: body }],
        },
      }) + '\n',
      'utf8'
    );
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
      const paneId = 'w1:p4';
      const sink = makeSseSink();
      mgr.addSseClient(sink.res);

      // Client already shows a Tier B stream card with the same body
      /** @type {object[]} */
      let clientItems = [
        {
          id: `${paneId}:1:1`,
          ts: 1,
          text: body,
          role: 'agent',
          stream: true,
        },
      ];

      mgr._internal.pushBubble(paneId, {
        ts: 1,
        text: body,
        role: 'agent',
        stream: true,
      });
      assert.ok(
        mgr._internal.ensureRuntime(paneId).buffer.some((b) => b.stream)
      );

      await mgr._internal.resolvePaneTranscript({
        pane_id: paneId,
        agent_session: {
          source: 'herdr:claude',
          agent: 'claude',
          kind: 'id',
          value: id,
        },
      });

      const rt = mgr._internal.ensureRuntime(paneId);
      assert.equal(rt.tier, 'A');
      assert.equal(
        rt.buffer.filter((b) => b.stream === true).length,
        0,
        'server buffer purged of stream cards'
      );

      const purges = sink.events().filter((e) => e.event === 'purge');
      assert.ok(purges.length >= 1, 'SSE purge event expected');
      assert.equal(purges[0].data.pane_id, paneId);

      // Frontend reconcile: drop streams, then append Tier A messages
      clientItems = purgeTierBStreamItems(clientItems);
      // Simulate loading Tier A transcript into the open chat
      clientItems.push({
        id: `a:${paneId}:0`,
        ts: Date.parse('2026-07-01T00:00:00.000Z'),
        text: body,
        role: 'agent',
      });
      const bodies = clientItems.filter((b) => (b.text || '').includes(body));
      assert.equal(bodies.length, 1, 'no duplicate body after purge reconcile');
      assert.equal(bodies[0].stream, undefined);
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('M5: badge decays when leaving blocked/done', () => {
  it('done → working removes pending (badge -1); still-done keeps pending', () => {
    const base = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'working'), pane('w9:p2', 'working')],
      {},
      T0
    ).state;

    const withDone = reduceNotifications(
      base,
      [pane('w9:p1', 'done'), pane('w9:p2', 'done')],
      {},
      T0 + 1000
    );
    assert.equal(pendingNotifyCount(withDone.state), 2);

    // p1 leaves done → working: pending for p1 must drop
    const p1Working = reduceNotifications(
      withDone.state,
      [pane('w9:p1', 'working'), pane('w9:p2', 'done')],
      {},
      T0 + 2000
    );
    assert.deepEqual(p1Working.emitted, []);
    assert.equal(pendingNotifyCount(p1Working.state), 1);
    assert.equal(p1Working.state.pending[0].paneId, 'w9:p2');
    assert.equal(p1Working.state.pending[0].status, 'done');

    // p2 stays done: pending retained (unread done still counts)
    const stillDone = reduceNotifications(
      p1Working.state,
      [pane('w9:p1', 'working'), pane('w9:p2', 'done')],
      {},
      T0 + 3000
    );
    assert.equal(pendingNotifyCount(stillDone.state), 1);
    assert.equal(stillDone.state.pending[0].paneId, 'w9:p2');
  });

  it('blocked → idle clears pending for that pane', () => {
    const base = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'working')],
      {},
      T0
    ).state;
    const blocked = reduceNotifications(
      base,
      [pane('w9:p1', 'blocked')],
      {},
      T0 + 1000
    );
    assert.equal(pendingNotifyCount(blocked.state), 1);
    const idle = reduceNotifications(
      blocked.state,
      [pane('w9:p1', 'idle')],
      {},
      T0 + 2000
    );
    assert.equal(pendingNotifyCount(idle.state), 0);
  });
});

describe('L8: seedInitialPaneState uses read offset (no post-stat race)', () => {
  it('seed offset equals bytes actually read; post-seed append is ingested', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-l8-'));
    const sub = path.join(tmp, 'proj');
    await fs.mkdir(sub, { recursive: true });
    const id = 'ffffffff-aaaa-bbbb-cccc-333333333333';
    const jsonl = path.join(sub, `${id}.jsonl`);
    const line1 =
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'seeded-agent' }],
        },
      }) + '\n';
    await fs.writeFile(jsonl, line1, 'utf8');
    const sizeAfterSeed = Buffer.byteLength(line1);

    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);
    const paneId = 'w1:p8';
    const agentSession = {
      source: 'herdr:claude',
      agent: 'claude',
      kind: 'id',
      value: id,
    };

    const mgr = createStateManager({
      client: {
        // Hang wait on abort so start() does not busy-spin the output loop.
        rpc(method, _params, opts = {}) {
          if (method === 'ping') {
            return Promise.resolve({ type: 'pong', protocol: 16 });
          }
          if (method === 'session.snapshot') {
            return Promise.resolve({
              type: 'snapshot',
              snapshot: {
                panes: [
                  {
                    pane_id: paneId,
                    agent: 'claude',
                    agent_status: 'idle',
                    agent_session: agentSession,
                  },
                ],
                workspaces: [],
                tabs: [],
              },
            });
          }
          if (method === 'pane.read') {
            return Promise.resolve({
              type: 'pane_read',
              read: { text: 'screen\n' },
            });
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
              setTimeout(() => {
                const err = new Error('timeout');
                err.code = 'timeout';
                reject(err);
              }, 60_000).unref?.();
            });
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
        subscribe: () => ({ dead: false, close() {} }),
      },
      stateDir,
      allowedRoot: tmp,
    });
    try {
      // start() → refreshSnapshot → resolvePaneTranscript → seedInitialPaneState
      await mgr.start();

      const rt = mgr._internal.ensureRuntime(paneId);
      assert.equal(rt.tier, 'A');
      assert.equal(
        rt.transcriptOffset,
        sizeAfterSeed,
        'offset must be size of complete lines read, not a later stat'
      );
      assert.match(rt.summary || '', /seeded-agent/);

      // Append after seed — must be visible to next incremental read
      const line2 =
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-01T00:01:00.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'appended-after-seed' }],
          },
        }) + '\n';
      await fs.appendFile(jsonl, line2, 'utf8');
      await mgr._internal.ingestPaneOutput(paneId);

      assert.ok(
        rt.buffer.some((b) => /appended-after-seed/.test(b.text || '')),
        'bytes after seed offset must still be ingested'
      );
      assert.equal(rt.transcriptOffset, sizeAfterSeed + Buffer.byteLength(line2));
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('L10: run enter failure clears typed line (Ctrl+U via send_text)', () => {
  it('send_text ok + enter fail → send_text \\x15, rate slot released', async () => {
    mock.timers.enable({ apis: ['setTimeout'], now: 0 });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-l10-'));
    /** @type {Array<{ method: string, params: object }>} */
    const calls = [];
    const client = {
      allowWrite: true,
      rpc: async (method, params = {}) => {
        calls.push({ method, params: { ...params } });
        if (method === 'pane.send_text') return { type: 'ok' };
        if (method === 'pane.send_keys') {
          const err = new Error('enter failed');
          err.code = 'send_failed';
          throw err;
        }
        throw new Error(`unexpected ${method}`);
      },
      subscribe: () => ({ dead: false, close() {} }),
    };
    const mgr = createStateManager({
      client,
      stateDir,
      runEnterDelayMs: RUN_ENTER_DELAY_MS,
    });
    mgr._internal.setSnapshot({
      workspaces: [],
      tabs: [],
      panes: [{ pane_id: 'w0:pL10', agent_status: 'unknown' }],
      agents: [],
    });
    try {
      const text = '你好，会残留的输入';
      const sendPromise = mgr.sendToPane('w0:pL10', text, 'run');
      await Promise.resolve();
      await Promise.resolve();
      mock.timers.tick(RUN_ENTER_DELAY_MS);
      const result = await sendPromise;
      assert.equal(result.ok, false);
      assert.equal(result.status, 502);

      // send_text user text → send_keys enter (fail) → send_text Ctrl+U
      assert.equal(calls.length, 3);
      assert.equal(calls[0].method, 'pane.send_text');
      assert.equal(calls[0].params.text, text);
      assert.equal(calls[1].method, 'pane.send_keys');
      assert.deepEqual(calls[1].params.keys, ['enter']);
      assert.equal(calls[2].method, 'pane.send_text');
      assert.equal(
        calls[2].params.text,
        '\x15',
        'Ctrl+U (\\x15) clears the line; send_keys cannot carry non-enter keys'
      );

      // Rate slot released → immediate retry reaches herdr again
      calls.length = 0;
      const client2Calls = calls;
      // Fix enter for retry
      client.rpc = async (method, params = {}) => {
        client2Calls.push({ method, params: { ...params } });
        return { type: 'ok' };
      };
      const retryPromise = mgr.sendToPane('w0:pL10', text, 'run');
      await Promise.resolve();
      await Promise.resolve();
      mock.timers.tick(RUN_ENTER_DELAY_MS);
      const retry = await retryPromise;
      assert.equal(retry.ok, true, 'rate slot must be released after failed run');
      assert.ok(client2Calls.some((c) => c.method === 'pane.send_text'));
    } finally {
      mock.timers.reset();
      await mgr.stop();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('L7: HEAD JSON routes return empty body', () => {
  it('HEAD /herd/api/state is 200 with empty body and Content-Length', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-l7-'));
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
    });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const get = await fetch(`${base}/herd/api/state`);
      assert.equal(get.status, 200);
      const getBody = await get.text();
      assert.ok(getBody.length > 0);
      assert.match(get.headers.get('content-type') || '', /json/);

      const head = await fetch(`${base}/herd/api/state`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      const headBody = await head.text();
      assert.equal(headBody, '', 'HEAD must not include a response body');
      const cl = head.headers.get('content-length');
      assert.ok(cl != null, 'Content-Length should still describe the would-be body');
      assert.equal(Number(cl), Buffer.byteLength(getBody));

      // messages + settings + wallpapers also empty on HEAD
      for (const path of [
        '/herd/api/settings',
        '/herd/api/wallpapers',
      ]) {
        const h = await fetch(`${base}${path}`, { method: 'HEAD' });
        assert.equal(h.status, 200, path);
        assert.equal(await h.text(), '', path);
      }
    } finally {
      srv.server.closeAllConnections?.();
      await srv.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
