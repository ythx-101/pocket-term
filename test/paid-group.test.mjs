import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPaidGroupConfig } from '../server.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('paid group runtime configuration', () => {
  it('is disabled unless all fields are present', async () => {
    assert.deepEqual(await readPaidGroupConfig({}, '/tmp/not-a-real-root'), { enabled: false });
  });

  it('returns only a whitelisted image path when configured', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-paid-group-'));
    roots.push(root);
    const qr = path.join(root, 'group.png');
    await fs.writeFile(qr, PNG);
    const config = await readPaidGroupConfig({
      PT2_PAID_GROUP_NAME: 'QingYue skill 答疑群',
      PT2_PAID_GROUP_PRICE: '55',
      PT2_PAID_GROUP_QR_PATH: qr,
      PT2_PAID_GROUP_EXPIRES: '2026-07-28',
    }, root);
    assert.deepEqual(config, {
      enabled: true,
      name: 'QingYue skill 答疑群',
      price: '55',
      qr_path: qr,
      expires: '2026-07-28',
    });
  });

  it('fails closed for outside, missing, and non-image QR paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-paid-group-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-paid-group-outside-'));
    roots.push(root, outside);
    const secret = path.join(outside, 'secret.txt');
    await fs.writeFile(secret, 'not a QR');
    const base = {
      PT2_PAID_GROUP_NAME: 'QingYue skill 答疑群',
      PT2_PAID_GROUP_PRICE: '55',
      PT2_PAID_GROUP_EXPIRES: '2026-07-28',
    };
    assert.deepEqual(await readPaidGroupConfig({ ...base, PT2_PAID_GROUP_QR_PATH: secret }, root), { enabled: false });
    assert.deepEqual(await readPaidGroupConfig({ ...base, PT2_PAID_GROUP_QR_PATH: path.join(root, 'missing.png') }, root), { enabled: false });
  });
});
