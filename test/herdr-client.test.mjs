/**
 * Live read-only tests against herdr.sock.
 * Hard rule: only ping / session.snapshot / pane.read / events.* (via client whitelist).
 * pane.read targets w9:p8 only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClient,
  READ_ONLY_METHODS,
  DEFAULT_SOCKET_PATH,
} from '../lib/herdr-client.js';

const client = createClient({ socketPath: DEFAULT_SOCKET_PATH });

describe('herdr-client read-only rpc', () => {
  it('ping → protocol === 16', async () => {
    const result = await client.rpc('ping');
    assert.equal(result.type, 'pong');
    assert.equal(result.protocol, 16);
  });

  it('session.snapshot → workspaces/tabs/panes/agents keys', async () => {
    const result = await client.rpc('session.snapshot');
    const snap = result.snapshot ?? result;
    for (const key of ['workspaces', 'tabs', 'panes', 'agents']) {
      assert.ok(key in snap, `missing key: ${key}`);
    }
  });

  it('pane.read w9:p8 (source recent, lines 5) → text', async () => {
    const result = await client.rpc('pane.read', {
      pane_id: 'w9:p8',
      source: 'recent',
      lines: 5,
    });
    const text =
      result?.read?.text ??
      result?.text ??
      (typeof result === 'string' ? result : null);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, 'expected non-empty text from pane.read');
  });

  it('rpc("pane.close") rejected by whitelist (no socket send)', async () => {
    assert.ok(!READ_ONLY_METHODS.includes('pane.close'));
    await assert.rejects(
      () => client.rpc('pane.close', { pane_id: 'w9:p8' }),
      (err) =>
        err &&
        err.code === 'method_not_allowed' &&
        /whitelist|not allowed|not on read-only/i.test(err.message)
    );
  });
});

describe('herdr-client subscribe', () => {
  it('subscribe layout.updated → subscription_started then close (no leak)', async () => {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          handle.close();
        } catch {
          /* ignore */
        }
        reject(new Error('timeout waiting for subscription_started / first event'));
      }, 5000);

      let sawStarted = false;
      const handle = client.subscribe([{ type: 'layout.updated' }], (event) => {
        const type =
          event?.type ??
          event?.result?.type ??
          event?.data?.type ??
          null;
        if (type === 'subscription_started' || event?.result?.type === 'subscription_started') {
          sawStarted = true;
          clearTimeout(timeout);
          handle.close();
          assert.equal(handle.dead, true);
          // Process must be able to exit: closed handle leaves no open socket.
          setImmediate(resolve);
          return;
        }
        // First post-start event also proves the stream is live.
        if (!sawStarted) {
          sawStarted = true;
          clearTimeout(timeout);
          handle.close();
          assert.equal(handle.dead, true);
          setImmediate(resolve);
        }
      });

      assert.equal(typeof handle.close, 'function');
      assert.equal(handle.dead, false);
    });
  });
});
