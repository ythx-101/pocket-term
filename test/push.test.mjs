import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPushService, validatePushSubscription } from '../lib/push-service.js';
import { createStateManager } from '../lib/state-manager.js';
import { startServer } from '../server.js';
import { shouldRecoverLifecycle, vapidKeyToBytes } from '../public/spa-utils.js';

const subscription = {
  endpoint: 'https://push.example.test/send/abc',
  expirationTime: null,
  keys: { p256dh: 'Abc_123-xyz', auth: 'auth_123' },
};
const config = { configured: true, subject: 'mailto:test@example.test', publicKey: 'public-test', privateKey: 'private-test' };

function mockClient(panes = []) {
  return {
    rpc: async (method) => method === 'ping'
      ? { protocol: 16, version: 'test' }
      : method === 'session.snapshot'
        ? { snapshot: { workspaces: [], tabs: [], panes } }
        : method === 'pane.read' ? { read: { text: '' } } : {},
    subscribe: () => ({ dead: false, close() {} }),
  };
}

describe('push subscription service', () => {
  it('validates HTTPS subscription shape', () => {
    assert.equal(validatePushSubscription(subscription).ok, true);
    assert.equal(validatePushSubscription({ ...subscription, endpoint: 'http://push.test/x' }).error, 'invalid_endpoint');
    assert.equal(validatePushSubscription({ ...subscription, keys: {} }).error, 'invalid_keys');
  });

  it('deduplicates, persists privately, reloads, and deletes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-push-'));
    try {
      const service = await createPushService({ stateDir: dir, config, sender: async () => {} });
      assert.equal((await service.subscribe(subscription)).ok, true);
      await service.subscribe({ ...subscription, expirationTime: 123 });
      assert.equal(service._count(), 1);
      const file = path.join(dir, 'push-subscriptions.json');
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      assert.equal((await createPushService({ stateDir: dir, config, sender: async () => {} }))._count(), 1);
      assert.deepEqual(await service.unsubscribe(subscription.endpoint), { ok: true, deleted: true });
      assert.equal(service._count(), 0);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('recovers the persistence queue after one atomic write rejection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-push-recover-'));
    const dir = path.join(root, 'state');
    try {
      await fs.writeFile(dir, 'blocks mkdir');
      const service = await createPushService({ stateDir: dir, config, sender: async () => {} });
      await assert.rejects(service.subscribe(subscription));
      await fs.unlink(dir);
      await fs.mkdir(dir);
      assert.equal((await service.subscribe(subscription)).ok, true);
      const stored = JSON.parse(await fs.readFile(path.join(dir, 'push-subscriptions.json'), 'utf8'));
      assert.equal(stored.subscriptions.length, 1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('prunes only 404/410 and retains transient failures', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-push-send-'));
    try {
      let statusCode = 410;
      const service = await createPushService({ stateDir: dir, config, sender: async () => { throw Object.assign(new Error('vendor'), { statusCode }); } });
      await service.subscribe(subscription);
      assert.deepEqual(await service.dispatch({ paneId: 'w9:p1', status: 'done' }), { sent: 0, failed: 1, pruned: 1 });
      await service.subscribe(subscription);
      statusCode = 503;
      assert.equal((await service.dispatch({ paneId: 'w9:p1', status: 'blocked' })).pruned, 0);
      assert.equal(service._count(), 1);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('truncates an oversized Unicode body and still sends valid bounded JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-push-payload-'));
    let delivered = null;
    try {
      const service = await createPushService({
        stateDir: dir,
        config,
        sender: async (_subscription, payload) => { delivered = payload; },
      });
      await service.subscribe(subscription);
      const result = await service.dispatch({ paneId: 'w9:p1', status: 'done', title: '完成😀'.repeat(2000) });
      assert.deepEqual(result, { sent: 1, failed: 0, pruned: 0 });
      assert.ok(Buffer.byteLength(delivered) <= 3000);
      const parsed = JSON.parse(delivered);
      assert.equal(parsed.status, 'done');
      assert.match(parsed.body, /…$/);
      assert.ok(!parsed.body.includes('\uFFFD'));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe('server status edge dispatch', () => {
  it('suppresses initial status and debounces later blocked/done edges', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-push-state-'));
    const events = [];
    const manager = createStateManager({ client: mockClient(), stateDir: dir, onNotifyStatus: (event) => events.push(event) });
    try {
      manager._internal.onStatus('w9:p1', 'blocked', 1000);
      manager._internal.onStatus('w9:p1', 'working', 2000);
      manager._internal.onStatus('w9:p1', 'blocked', 3000);
      manager._internal.onStatus('w9:p1', 'working', 4000);
      manager._internal.onStatus('w9:p1', 'blocked', 5000);
      manager._internal.onStatus('w9:p1', 'done', 6000);
      await Promise.resolve();
      assert.deepEqual(events.map((e) => e.status), ['blocked', 'done']);
    } finally { await manager.stop(); await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe('push HTTP/static routes', () => {
  it('guards writes, redacts storage, and serves no-store worker', { timeout: 5000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-push-http-'));
    const calls = [];
    const pushService = {
      configured: true, publicKey: 'public-only', dispatch: async () => ({}),
      subscribe: async (body) => { calls.push(['post', body]); return { ok: true }; },
      unsubscribe: async (endpoint) => { calls.push(['delete', endpoint]); return { ok: true, deleted: true }; },
    };
    const srv = await startServer({ host: '127.0.0.1', port: 0, stateDir: dir, client: mockClient(), pushService });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const vapid = await (await fetch(`${base}/herd/api/push/vapid-public`)).json();
      assert.deepEqual(vapid, { publicKey: 'public-only' });
      const denied = await fetch(`${base}/herd/api/push/subscribe`, { method: 'POST', body: '{}' });
      assert.equal(denied.status, 403);
      const headers = { Origin: base, 'Content-Type': 'application/json' };
      assert.equal((await fetch(`${base}/herd/api/push/subscribe`, { method: 'POST', headers, body: JSON.stringify(subscription) })).status, 200);
      assert.equal((await fetch(`${base}/herd/api/push/subscribe`, { method: 'DELETE', headers, body: JSON.stringify({ endpoint: subscription.endpoint }) })).status, 200);
      assert.equal(calls.length, 2);
      const sw = await fetch(`${base}/herd/sw.js`);
      assert.equal(sw.status, 200);
      assert.equal(sw.headers.get('cache-control'), 'no-store');
      assert.match(sw.headers.get('content-type') || '', /javascript/);
      const source = await sw.text();
      assert.match(source, /showNotification/);
      assert.doesNotMatch(source, /fetch\s*\(/);
    } finally {
      srv.server.closeAllConnections?.();
      await srv.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('browser helpers and wiring', () => {
  it('decodes a 65-byte uncompressed VAPID key', () => {
    const raw = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
    assert.equal(vapidKeyToBytes(raw).length, 65);
    assert.throws(() => vapidKeyToBytes('bad'));
  });
  it('recovers only relevant lifecycle events with unhealthy SSE', () => {
    assert.equal(shouldRecoverLifecycle({ type: 'visibilitychange', visibilityState: 'visible', sseHealthy: false }), true);
    assert.equal(shouldRecoverLifecycle({ type: 'pageshow', persisted: true, sseHealthy: false }), true);
    assert.equal(shouldRecoverLifecycle({ type: 'online', online: true, sseHealthy: false }), true);
    assert.equal(shouldRecoverLifecycle({ type: 'online', online: true, sseHealthy: true }), false);
    assert.equal(shouldRecoverLifecycle({ type: 'online', online: true, sseHealthy: false, recoveryPending: true }), false);
    assert.equal(shouldRecoverLifecycle({ type: 'pageshow', persisted: false, sseHealthy: false }), false);
  });
});
