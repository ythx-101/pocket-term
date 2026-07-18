/**
 * P3.2 review fixes: Tier A/B dedupe + clean shutdown.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createStateManager,
  shouldEmitTierB,
} from '../lib/state-manager.js';

describe('shouldEmitTierB / no A+B duplicate', () => {
  it('suppresses Tier B when tier A or transcriptPath set', () => {
    assert.equal(shouldEmitTierB({ tier: 'B', transcriptPath: null }), true);
    assert.equal(shouldEmitTierB({ tier: 'A', transcriptPath: null }), false);
    assert.equal(
      shouldEmitTierB({
        tier: 'B',
        transcriptPath: '/root/.claude/projects/x/y.jsonl',
      }),
      false
    );
  });

  it('ingestPaneOutput does not push stream bubbles when Tier A active', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-dedupe-'));
    const sub = path.join(tmp, 'proj');
    await fs.mkdir(sub, { recursive: true });
    const id = 'cccccccc-dddd-eeee-ffff-000000000001';
    const jsonl = path.join(sub, `${id}.jsonl`);
    await fs.writeFile(
      jsonl,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'tier-a-only' }],
        },
      }) + '\n',
      'utf8'
    );
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);

    let screenText = 'line-one\nline-two\n';
    const client = {
      rpc: async (method) => {
        if (method === 'pane.read') {
          return { type: 'pane_read', read: { text: screenText } };
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
      // Activate Tier A
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
      assert.equal(rt.tier, 'A');
      assert.equal(shouldEmitTierB(rt), false);

      // Seed prev empty so diff yields new lines
      rt.prevText = '';
      screenText = 'screen-only-line\nanother\n';
      await mgr._internal.ingestPaneOutput('w1:p1');

      const streamBubbles = rt.buffer.filter((b) => b.stream === true);
      const agentBubbles = rt.buffer.filter(
        (b) => b.role === 'agent' && b.stream !== true
      );
      assert.equal(streamBubbles.length, 0, 'no Tier B stream bubbles on Tier A');
      assert.ok(
        agentBubbles.some((b) => /tier-a-only/.test(b.text)),
        'Tier A transcript messages present'
      );
      assert.equal(rt.openLines.length, 0);
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('B→A transition purges sealed Tier B buffer', () => {
  it('leaves zero stream bubbles after successful Tier A resolve', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-ba-'));
    const sub = path.join(tmp, 'proj');
    await fs.mkdir(sub, { recursive: true });
    const id = 'dddddddd-eeee-ffff-aaaa-111111111111';
    const jsonl = path.join(sub, `${id}.jsonl`);
    await fs.writeFile(
      jsonl,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'from-transcript' }],
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
      const paneId = 'w1:p9';
      // Simulate Tier B history already sealed into the ring buffer
      mgr._internal.pushBubble(paneId, {
        ts: 1,
        text: 'old screen card',
        role: 'agent',
        stream: true,
      });
      mgr._internal.pushBubble(paneId, {
        ts: 2,
        text: 'another stream',
        role: 'agent',
        stream: true,
      });
      mgr._internal.appendTierBLines(paneId, ['open draft'], 3);
      const rtBefore = mgr._internal.ensureRuntime(paneId);
      assert.equal(rtBefore.tier, 'B');
      assert.ok(rtBefore.buffer.some((b) => b.stream));
      assert.ok(rtBefore.openLines.length > 0);

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
        'all stream bubbles purged on B→A'
      );
      assert.equal(rt.openLines.length, 0);
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('stop() with mid-flight snapshot', () => {
  it('aborts and awaits in-flight session.snapshot cleanly', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-snap-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);

    let snapshotEntered = false;
    let snapshotSettled = false;
    let sawAbortSignal = false;

    const emptySnap = {
      type: 'snapshot',
      snapshot: { panes: [], workspaces: [], tabs: [] },
    };

    const client = {
      // Non-async so the tracked promise is the same object we hang/abort.
      rpc(method, _params, opts = {}) {
        if (method === 'ping') {
          return Promise.resolve({ type: 'pong', protocol: 16 });
        }
        if (method === 'session.snapshot') {
          snapshotEntered = true;
          return new Promise((resolve) => {
            const finish = () => {
              snapshotSettled = true;
              resolve(emptySnap);
            };
            const onAbort = () => {
              sawAbortSignal = true;
              // Complete the RPC on abort (mirrors socket destroy + settle).
              finish();
            };
            if (opts.signal?.aborted) {
              onAbort();
              return;
            }
            opts.signal?.addEventListener('abort', onAbort, { once: true });
            // Without stop(), this would hang past the test timeout.
          });
        }
        if (method === 'pane.read') {
          return Promise.resolve({ type: 'pane_read', read: { text: '' } });
        }
        if (method === 'events.wait') {
          const err = new Error('timeout');
          err.code = 'timeout';
          return Promise.reject(err);
        }
        return Promise.reject(new Error(`unexpected ${method}`));
      },
      subscribe: () => ({ dead: false, close() {} }),
    };

    const mgr = createStateManager({ client, stateDir, allowedRoot: tmp });
    const startP = mgr.start();
    for (let i = 0; i < 50 && !snapshotEntered; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(snapshotEntered, 'snapshot RPC should have started');
    assert.ok(mgr._internal.inFlightSnapshots.size >= 1);
    assert.equal(snapshotSettled, false);

    const t0 = Date.now();
    await mgr.stop();
    await startP;
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, `stop should finish quickly, took ${elapsed}ms`);
    assert.ok(sawAbortSignal, 'snapshot RPC should observe AbortSignal');
    assert.ok(snapshotSettled, 'in-flight snapshot must settle before stop returns');
    assert.equal(mgr._internal.inFlightSnapshots.size, 0);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('seedInitialPaneState', () => {
  it('fills Tier B summary and last_activity from first pane.read', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-seed-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);

    const client = {
      rpc: async (method) => {
        if (method === 'ping') return { type: 'pong', protocol: 16 };
        if (method === 'session.snapshot') {
          return {
            type: 'snapshot',
            snapshot: {
              panes: [
                {
                  pane_id: 'w1:p1',
                  agent: 'grok',
                  agent_status: 'idle',
                  label: 'seed-me',
                },
              ],
              workspaces: [],
              tabs: [],
            },
          };
        }
        if (method === 'pane.read') {
          return {
            type: 'pane_read',
            read: { text: 'noise\n\n最终摘要行\n' },
          };
        }
        if (method === 'events.wait') {
          const err = new Error('timeout');
          err.code = 'timeout';
          throw err;
        }
        throw new Error(`unexpected ${method}`);
      },
      subscribe: () => ({ dead: false, close() {} }),
    };

    const mgr = createStateManager({ client, stateDir, allowedRoot: tmp });
    try {
      await mgr.start();
      const pane = mgr.getState().panes.find((p) => p.pane_id === 'w1:p1');
      assert.ok(pane);
      assert.match(pane.summary || '', /最终摘要行/);
      assert.ok(pane.last_activity > 0);
      const rt = mgr._internal.ensureRuntime('w1:p1');
      assert.match(rt.prevText, /最终摘要行/);
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('clean stop awaits output loops', () => {
  it('stop() aborts in-flight wait RPC and settles without hanging', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-stop-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);

    let waitEntered = false;
    /** @type {(() => void) | null} */
    let releaseWait = null;

    const client = {
      rpc: async (method, _params, opts = {}) => {
        if (method === 'ping') return { type: 'pong', protocol: 16 };
        if (method === 'session.snapshot') {
          return {
            type: 'snapshot',
            snapshot: {
              panes: [
                {
                  pane_id: 'w1:p1',
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
        if (method === 'pane.read') {
          return { type: 'pane_read', read: { text: 'x\n' } };
        }
        if (method === 'events.wait') {
          waitEntered = true;
          return new Promise((resolve, reject) => {
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
            // Also allow manual release (should not be needed if abort works)
            releaseWait = () => {
              const err = new Error('timeout');
              err.code = 'timeout';
              reject(err);
            };
            // Long hang if abort broken
            setTimeout(() => {
              const err = new Error('timeout');
              err.code = 'timeout';
              reject(err);
            }, 60_000).unref?.();
          });
        }
        throw new Error(`unexpected ${method}`);
      },
      subscribe: () => ({ dead: false, close() {} }),
    };

    const mgr = createStateManager({ client, stateDir, allowedRoot: tmp });
    const t0 = Date.now();
    await mgr.start();
    // Wait until output loop enters events.wait
    for (let i = 0; i < 50 && !waitEntered; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(waitEntered, 'output loop should call events.wait');
    assert.ok(mgr._internal.outputLoops.size >= 1);

    await mgr.stop();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `stop should be quick, took ${elapsed}ms`);
    assert.equal(mgr._internal.outputLoops.size, 0);
    void releaseWait;
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
