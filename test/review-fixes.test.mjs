/**
 * P3.2 review fixes: Tier A/B dedupe + clean shutdown.
 * M1-fix4: Tier B multi-frame redraw dedupe.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createStateManager,
  shouldEmitTierB,
  isDuplicateStreamBubble,
  TIER_B_STREAM_DEDUPE_MS,
} from '../lib/state-manager.js';

describe('isDuplicateStreamBubble (Tier B redraw dedupe)', () => {
  it('matches trimmed text within window among recent stream bubbles', () => {
    const rt = {
      buffer: [
        { stream: true, text: '  hello 世界  ', ts: 1000 },
        { stream: true, text: 'other', ts: 2000 },
      ],
      recentStreamBroadcasts: [{ text: 'hello 世界', ts: 1000 }],
    };
    assert.equal(isDuplicateStreamBubble(rt, 'hello 世界', 5000), true);
    assert.equal(isDuplicateStreamBubble(rt, 'hello 世界', 1000 + TIER_B_STREAM_DEDUPE_MS + 1), false);
    assert.equal(isDuplicateStreamBubble(rt, 'brand new', 5000), false);
  });
});

describe('Tier B multi-frame TUI redraw: body only once', () => {
  it('same body + changing spinner/border frames → one stream bubble; re-allow after window; CJK', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-redraw-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);

    /** @type {string} */
    let screenText = '';
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
      const paneId = 'w9:p8';
      const rt = mgr._internal.ensureRuntime(paneId);
      assert.equal(shouldEmitTierB(rt), true);

      const bodyLines = [
        '╭────────────────────────╮',
        '│ 任务结果：已完成         │',
        '│ summary: all green     │',
        '╰────────────────────────╯',
      ];
      const spinners = ['✻ Thinking…', '✶ Working…', '✳ Crunching…', '✦ Finishing…'];

      // Seed prevText as empty first frame is ingested as baseline via explicit seed
      // (mirrors runOutputLoop seed) then feed multi-frame redraw sequence.
      screenText = [...bodyLines, spinners[0]].join('\n') + '\n';
      rt.prevText = screenText;

      // 13 frames of redraw: same body, churning spinner + re-drawn frame
      // (reproduces live w9:p8 13× duplicate-bubble pattern).
      for (let i = 0; i < 13; i++) {
        const spin = spinners[i % spinners.length];
        // Slight border pad change every other frame (breaks string anchors).
        const top =
          i % 2 === 0
            ? '╭────────────────────────╮'
            : '╭─────────────────────────╮';
        const frame = [
          top,
          '│ 任务结果：已完成         │',
          '│ summary: all green     │',
          '╰────────────────────────╯',
          spin,
        ];
        screenText = frame.join('\n') + '\n';
        await mgr._internal.ingestPaneOutput(paneId);
      }

      // Force seal of any open Tier B lines
      mgr._internal.sealOpen(paneId);

      const stream1 = rt.buffer.filter((b) => b.stream === true);
      const bodyHits1 = stream1.filter(
        (b) =>
          /任务结果：已完成/.test(b.text || '') ||
          /summary: all green/.test(b.text || '')
      );
      assert.ok(
        bodyHits1.length <= 1,
        `body must broadcast at most once after 13 redraw frames, got ${bodyHits1.length}: ${bodyHits1.map((b) => b.text).join(' || ')}`
      );

      // Pure append of genuinely new CJK content must still produce a bubble.
      const tNew = 10_000;
      screenText =
        [...bodyLines, '新的输出行：中文追加', '✶ Working…'].join('\n') + '\n';
      // Force prev to a state with no common anchor so path is full-redraw-ish,
      // but new CJK line is absent from prev → must emit.
      rt.prevText = ['unrelated old screen', '✻ Thinking…'].join('\n') + '\n';
      await mgr._internal.ingestPaneOutput(paneId);
      // Use synthetic silence seal via append gap
      mgr._internal.appendTierBLines(paneId, [], tNew);
      mgr._internal.sealOpen(paneId);

      const afterNew = rt.buffer.filter((b) => b.stream === true);
      assert.ok(
        afterNew.some((b) => /新的输出行：中文追加/.test(b.text || '')),
        'new CJK content must still form a stream bubble'
      );

      // After the dedupe window, identical body may broadcast again (re-run).
      const tLater = 1000 + TIER_B_STREAM_DEDUPE_MS + 5_000;
      // Push a sealed bubble with old ts already present; now seal same text later.
      mgr._internal.appendTierBLines(
        paneId,
        ['任务结果：已完成', 'summary: all green'],
        tLater
      );
      mgr._internal.sealOpen(paneId);

      const bodyHitsLater = rt.buffer.filter(
        (b) =>
          b.stream === true &&
          /任务结果：已完成/.test(b.text || '') &&
          /summary: all green/.test(b.text || '') &&
          !/新的输出行/.test(b.text || '')
      );
      assert.ok(
        bodyHitsLater.length >= 1,
        'identical body after dedupe window must be allowed (not cross-session kill)'
      );
      // At least one of them should carry the late timestamp (or be a second copy).
      const lateCopy = bodyHitsLater.filter((b) => (Number(b.ts) || 0) >= tLater - 1);
      assert.ok(
        lateCopy.length >= 1 || bodyHitsLater.length >= 2,
        'expected a post-window re-broadcast of the same body'
      );
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('13-frame redraw via appendTierBLines+seal only seals unique body once', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-redraw2-'));
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
      const paneId = 'w9:p8';
      const body = '最终摘要行\nstatus ok';
      // Simulate 13 seal cycles of the same cleaned body (worst-case redraw spam).
      for (let i = 0; i < 13; i++) {
        mgr._internal.appendTierBLines(
          paneId,
          [
            '╭──────────╮',
            '│ 最终摘要行 │',
            '│ status ok │',
            '╰──────────╯',
            i % 2 === 0 ? '✻ Thinking…' : '✶ Working…',
          ],
          1000 + i * 100
        );
        // Seal each frame as if silence/status closed the card every time.
        mgr._internal.sealOpen(paneId);
      }

      const rt = mgr._internal.ensureRuntime(paneId);
      const stream = rt.buffer.filter((b) => b.stream === true);
      const bodyBubbles = stream.filter((b) => {
        const t = (b.text || '').trim();
        return t.includes('最终摘要行') && t.includes('status ok');
      });
      assert.equal(
        bodyBubbles.length,
        1,
        `expected exactly 1 body bubble after 13 seals, got ${bodyBubbles.length}`
      );
      assert.equal(bodyBubbles[0].text.includes('✻'), false);
      assert.equal(bodyBubbles[0].text.includes('✶'), false);

      // Past window: same body allowed again.
      const later = 1000 + TIER_B_STREAM_DEDUPE_MS + 1000;
      mgr._internal.appendTierBLines(
        paneId,
        ['最终摘要行', 'status ok'],
        later
      );
      mgr._internal.sealOpen(paneId);
      const bodyBubbles2 = rt.buffer.filter(
        (b) =>
          b.stream === true &&
          (b.text || '').includes('最终摘要行') &&
          (b.text || '').includes('status ok')
      );
      assert.equal(bodyBubbles2.length, 2, 'second copy after window');
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('shouldEmitTierB / no A+B duplicate', () => {
  it('suppresses Tier B when tier A or transcriptPath set', () => {
    assert.equal(shouldEmitTierB({ tier: 'B', transcriptPath: null }), true);
    assert.equal(shouldEmitTierB({ tier: 'A', transcriptPath: null }), false);
    assert.equal(
      shouldEmitTierB({
        tier: 'B',
        transcriptPath: '/home/user/.claude/projects/x/y.jsonl',
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
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (err) => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);

    const client = {
      // Non-async so the tracked promise is the same object we hang/abort.
      rpc(method, _params, opts = {}) {
        if (method === 'ping') {
          return Promise.resolve({ type: 'pong', protocol: 16 });
        }
        if (method === 'session.snapshot') {
          snapshotEntered = true;
          return new Promise((resolve, reject) => {
            const onAbort = () => {
              sawAbortSignal = true;
              const err = new Error('aborted');
              err.code = 'aborted';
              // Real herdr-client path: destroy socket → reject aborted
              reject(err);
              snapshotSettled = true;
            };
            if (opts.signal?.aborted) {
              onAbort();
              return;
            }
            opts.signal?.addEventListener('abort', onAbort, { once: true });
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
    try {
      const startP = mgr.start();
      for (let i = 0; i < 50 && !snapshotEntered; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(snapshotEntered, 'snapshot RPC should have started');
      assert.ok(mgr._internal.inFlightSnapshots.size >= 1);

      const t0 = Date.now();
      await mgr.stop();
      await startP;
      // Allow any stray rejection microtasks to surface
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 3000, `stop should finish quickly, took ${elapsed}ms`);
      assert.ok(sawAbortSignal, 'snapshot RPC should observe AbortSignal');
      assert.ok(snapshotSettled, 'in-flight snapshot must settle before stop returns');
      assert.equal(mgr._internal.inFlightSnapshots.size, 0);
      assert.equal(
        unhandled.length,
        0,
        `no unhandledRejection expected, got: ${unhandled.map((e) => e && e.message).join('; ')}`
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await fs.rm(tmp, { recursive: true, force: true });
    }
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
