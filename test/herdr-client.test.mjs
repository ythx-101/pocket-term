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
  errorFromRpcPayload,
  ALLOWED_SEND_KEYS,
  DEFAULT_SOCKET_PATH,
  HerdrError,
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
  it('WRITE_METHODS is pane.send_text + pane.send_keys', () => {
    assert.deepEqual([...WRITE_METHODS], ['pane.send_text', 'pane.send_keys']);
    assert.deepEqual([...ALLOWED_SEND_KEYS], ['enter']);
  });

  it('default client rejects write methods (M0 behavior)', async () => {
    const ro = createClient({ socketPath: DEFAULT_SOCKET_PATH });
    assert.equal(ro.allowWrite, false);
    await assert.rejects(
      () => ro.rpc('pane.send_text', { pane_id: 'w9:p8', text: 'nope' }),
      (err) => err && err.code === 'method_not_allowed'
    );
    await assert.rejects(
      () =>
        ro.rpc('pane.send_keys', { pane_id: 'w9:p8', keys: ['enter'] }),
      (err) => err && err.code === 'method_not_allowed'
    );
    // pane.run is not on the whitelist at all (CLI sugar only).
    await assert.rejects(
      () => ro.rpc('pane.run', { pane_id: 'w9:p8', text: 'nope' }),
      (err) => err && err.code === 'method_not_allowed'
    );
  });

  it('mapWriteMethod forces pane.send_keys keys to [enter]', () => {
    const mapped = mapWriteMethod('pane.send_keys', {
      pane_id: 'x',
      keys: ['ctrl-c', 'a', 'escape'],
    });
    assert.equal(mapped.method, 'pane.send_keys');
    assert.deepEqual(mapped.params.keys, ['enter']);
    assert.equal(mapped.params.pane_id, 'x');

    const passthrough = mapWriteMethod('pane.send_text', {
      pane_id: 'x',
      text: 'hi',
    });
    assert.equal(passthrough.method, 'pane.send_text');
    assert.equal(passthrough.params.text, 'hi');
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
      // still rejects non-whitelisted writes (incl. pane.run)
      await assert.rejects(
        () => w.rpc('pane.close', { pane_id: 'scratch:test' }),
        (err) => err && err.code === 'method_not_allowed'
      );
      await assert.rejects(
        () => w.rpc('pane.run', { pane_id: 'scratch:test', text: 'x' }),
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

  it('allowWrite: pane.send_keys always wires keys:[enter]', async () => {
    const sockPath = path.join(
      os.tmpdir(),
      `pt2-mock-keys-${process.pid}-${Date.now()}.sock`
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
      await w.rpc('pane.send_keys', {
        pane_id: 'scratch:test',
        keys: ['ctrl-c', 'escape'],
      });
      assert.equal(received.method, 'pane.send_keys');
      assert.deepEqual(received.params.keys, ['enter']);
      assert.equal(received.params.pane_id, 'scratch:test');
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

describe('rpc error propagation (must not swallow {error})', () => {
  it('errorFromRpcPayload maps code/message', () => {
    const err = errorFromRpcPayload({
      code: 'invalid_request',
      message: "unknown variant `pane.run`",
    });
    assert.ok(err instanceof HerdrError);
    assert.equal(err.code, 'invalid_request');
    assert.match(err.message, /pane\.run/);
  });

  it('rpc rejects when server replies {id:"", error:...} (herdr shape)', async () => {
    const sockPath = path.join(
      os.tmpdir(),
      `pt2-err-empty-id-${process.pid}-${Date.now()}.sock`
    );
    try {
      await fs.promises.unlink(sockPath);
    } catch {
      /* ignore */
    }

    const server = net.createServer((socket) => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        if (!buf.includes('\n')) return;
        // Real herdr shape for unknown method: empty id + error object.
        socket.write(
          JSON.stringify({
            id: '',
            error: {
              code: 'invalid_request',
              message:
                'invalid request: unknown variant `pane.run`, expected one of ...',
            },
          }) + '\n'
        );
      });
    });

    await new Promise((resolve, reject) => {
      server.listen(sockPath, () => resolve());
      server.once('error', reject);
    });

    try {
      const w = createClient({
        socketPath: sockPath,
        allowWrite: true,
        timeoutMs: 2000,
      });
      // send_text is whitelisted; mock always returns the empty-id error.
      await assert.rejects(
        () =>
          w.rpc('pane.send_text', {
            pane_id: 'scratch:test',
            text: 'should fail',
          }),
        (err) =>
          err instanceof HerdrError &&
          err.code === 'invalid_request' &&
          /unknown variant|pane\.run/i.test(err.message)
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

  it('rpc rejects error even when id mismatches request id', async () => {
    const sockPath = path.join(
      os.tmpdir(),
      `pt2-err-mismatch-${process.pid}-${Date.now()}.sock`
    );
    try {
      await fs.promises.unlink(sockPath);
    } catch {
      /* ignore */
    }

    const server = net.createServer((socket) => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        if (!buf.includes('\n')) return;
        socket.write(
          JSON.stringify({
            id: 'not-the-request-id',
            error: { code: 'rpc_error', message: 'boom mismatched id' },
          }) + '\n'
        );
      });
    });

    await new Promise((resolve, reject) => {
      server.listen(sockPath, () => resolve());
      server.once('error', reject);
    });

    try {
      const w = createClient({
        socketPath: sockPath,
        allowWrite: true,
        timeoutMs: 2000,
      });
      await assert.rejects(
        () =>
          w.rpc('pane.send_text', { pane_id: 'x', text: 'y' }),
        (err) =>
          err instanceof HerdrError &&
          err.code === 'rpc_error' &&
          /mismatched id/.test(err.message)
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
});

describe('real-socket: pane.run is unknown (regression guard)', () => {
  it('raw socket pane.run → invalid_request unknown variant', async () => {
    // Bypass client whitelist: herdr has no pane.run on the wire (CLI sugar).
    // Regression guard so we never reintroduce mapping that pretends it exists.
    const raw = await new Promise((resolve, reject) => {
      const socket = net.createConnection(DEFAULT_SOCKET_PATH);
      let buf = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timeout waiting for pane.run error'));
      }, 5000);
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(
          JSON.stringify({
            id: 'reg-pane-run',
            method: 'pane.run',
            params: { pane_id: 'w9:p8', text: 'should-not-work' },
          }) + '\n'
        );
      });
      socket.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        socket.destroy();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.ok(raw.error, `expected error payload, got ${JSON.stringify(raw)}`);
    assert.equal(raw.id, '', 'herdr unknown-method errors use empty id');
    assert.equal(raw.error.code, 'invalid_request');
    assert.match(
      String(raw.error.message),
      /unknown variant\s*`?pane\.run`?/i
    );
    // Client whitelist must also reject pane.run (never reach socket via rpc).
    const w = createClient({
      socketPath: DEFAULT_SOCKET_PATH,
      allowWrite: true,
    });
    await assert.rejects(
      () => w.rpc('pane.run', { pane_id: 'w9:p8', text: 'x' }),
      (err) => err && err.code === 'method_not_allowed'
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
