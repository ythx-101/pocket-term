/**
 * Live read-only tests against herdr.sock + mock-socket write whitelist tests.
 * Hard rule: live pane.read targets w9:p8 only; write methods only on mock socket
 * or self-owned scratch panes (never other agent panes).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createClient,
  READ_ONLY_METHODS,
  WRITE_METHODS,
  mapWriteMethod,
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

describe('herdr-client write whitelist', () => {
  it('WRITE_METHODS is pane.send_text + pane.run', () => {
    assert.deepEqual([...WRITE_METHODS], ['pane.send_text', 'pane.run']);
  });

  it('default client rejects pane.send_text (M0 behavior)', async () => {
    const ro = createClient({ socketPath: DEFAULT_SOCKET_PATH });
    assert.equal(ro.allowWrite, false);
    await assert.rejects(
      () => ro.rpc('pane.send_text', { pane_id: 'w9:p8', text: 'nope' }),
      (err) => err && err.code === 'method_not_allowed'
    );
    await assert.rejects(
      () => ro.rpc('pane.run', { pane_id: 'w9:p8', text: 'nope' }),
      (err) => err && err.code === 'method_not_allowed'
    );
  });

  it('mapWriteMethod maps pane.run → send_text + newline', () => {
    const mapped = mapWriteMethod('pane.run', {
      pane_id: 'x',
      text: 'echo hi',
    });
    assert.equal(mapped.method, 'pane.send_text');
    assert.equal(mapped.params.text, 'echo hi\n');
    assert.equal(mapped.params.pane_id, 'x');
  });

  it('allowWrite: pane.send_text reaches mock socket as wire method', async () => {
    const sockPath = path.join(
      os.tmpdir(),
      `pt2-mock-herdr-${process.pid}-${Date.now()}.sock`
    );
    try {
      await fs.promises.unlink(sockPath);
    } catch {
      /* ignore */
    }

    /** @type {object|null} */
    let received = null;
    const server = net.createServer((socket) => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          received = JSON.parse(buf.slice(0, nl));
        } catch {
          received = { parse_error: true, raw: buf.slice(0, nl) };
        }
        const id = received?.id ?? 'x';
        socket.write(
          JSON.stringify({ id, result: { type: 'ok' } }) + '\n'
        );
      });
    });

    await new Promise((resolve, reject) => {
      server.listen(sockPath, () => resolve());
      server.once('error', reject);
    });

    try {
      const w = createClient({ socketPath: sockPath, allowWrite: true });
      assert.equal(w.allowWrite, true);
      const result = await w.rpc('pane.send_text', {
        pane_id: 'scratch:test',
        text: 'echo mock',
      });
      assert.equal(result?.type, 'ok');
      assert.ok(received, 'expected wire message');
      assert.equal(received.method, 'pane.send_text');
      assert.equal(received.params.pane_id, 'scratch:test');
      assert.equal(received.params.text, 'echo mock');
      // still rejects non-whitelisted writes
      await assert.rejects(
        () => w.rpc('pane.close', { pane_id: 'scratch:test' }),
        (err) => err && err.code === 'method_not_allowed'
      );
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        await fs.promises.unlink(sockPath);
      } catch {
        /* ignore */
      }
    }
  });

  it('allowWrite: pane.run maps to pane.send_text on the wire', async () => {
    const sockPath = path.join(
      os.tmpdir(),
      `pt2-mock-run-${process.pid}-${Date.now()}.sock`
    );
    try {
      await fs.promises.unlink(sockPath);
    } catch {
      /* ignore */
    }

    /** @type {object|null} */
    let received = null;
    const server = net.createServer((socket) => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        received = JSON.parse(buf.slice(0, nl));
        socket.write(
          JSON.stringify({ id: received.id, result: { type: 'ok' } }) + '\n'
        );
      });
    });

    await new Promise((resolve, reject) => {
      server.listen(sockPath, () => resolve());
      server.once('error', reject);
    });

    try {
      const w = createClient({ socketPath: sockPath, allowWrite: true });
      await w.rpc('pane.run', { pane_id: 'scratch:test', text: 'echo run' });
      assert.equal(received.method, 'pane.send_text');
      assert.equal(received.params.text, 'echo run\n');
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        await fs.promises.unlink(sockPath);
      } catch {
        /* ignore */
      }
    }
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
