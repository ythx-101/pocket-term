/**
 * M2-P0 wallpaper system: list/serve/settings + pure dim mapping.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  startServer,
  listWallpapers,
  resolveWallpaperFile,
} from '../server.js';
import {
  isSafeWallpaperName,
  validateSettingsPayload,
  normalizeStoredSettings,
  DEFAULT_SETTINGS,
} from '../lib/state-manager.js';
import {
  dimPercentToCssVar,
  dimToPercent,
  dimPercentToApi,
  wallpaperAssetUrl,
  DIM_SLIDER_MAX,
  DIM_DEFAULT_PERCENT,
} from '../public/spa-utils.js';

/**
 * Raw GET that does not normalize `..` (unlike fetch/WHATWG URL).
 * @param {string} base
 * @param {string} rawPath
 * @returns {Promise<number>}
 */
function rawGetStatus(base, rawPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http
      .get({ hostname: u.hostname, port: u.port, path: rawPath }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      })
      .on('error', reject);
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FIXTURE_JPG = path.join(ROOT, 'state', 'wallpapers', 'kimetsu-01.jpg');

/**
 * @param {string} base
 * @param {string} urlPath
 * @param {RequestInit & { Origin?: string }} [opts]
 */
async function api(base, urlPath, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.Origin !== undefined) {
    headers.Origin = opts.Origin;
  } else if (opts.method && opts.method !== 'GET' && opts.method !== 'HEAD') {
    const u = new URL(base);
    headers.Origin = `http://${u.host}`;
  }
  const res = await fetch(`${base}${urlPath}`, { ...opts, headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, text, json };
}

describe('pure: wallpaper name + settings validation', () => {
  it('isSafeWallpaperName accepts basename images only', () => {
    assert.equal(isSafeWallpaperName('kimetsu-01.jpg'), true);
    assert.equal(isSafeWallpaperName('a.PNG'), true);
    assert.equal(isSafeWallpaperName('x.webp'), true);
    assert.equal(isSafeWallpaperName('foo.jpeg'), true);
    assert.equal(isSafeWallpaperName('anim.gif'), true);
    assert.equal(isSafeWallpaperName('../etc/passwd'), false);
    assert.equal(isSafeWallpaperName('a/b.jpg'), false);
    assert.equal(isSafeWallpaperName('..'), false);
    assert.equal(isSafeWallpaperName('x.txt'), false);
    assert.equal(isSafeWallpaperName(''), false);
    assert.equal(isSafeWallpaperName(null), false);
  });

  it('validateSettingsPayload rejects unknown fields and bad dim', () => {
    assert.equal(validateSettingsPayload({ theme: 'dark' }).ok, false);
    assert.equal(validateSettingsPayload({ theme: 'dark' }).error, 'unknown_field');
    assert.equal(validateSettingsPayload({ dim: 0.95 }).ok, false);
    assert.equal(validateSettingsPayload({ dim: 0.95 }).error, 'invalid_dim');
    assert.equal(validateSettingsPayload({ dim: -0.1 }).ok, false);
    assert.equal(validateSettingsPayload({ dim: '0.3' }).ok, false);
    assert.equal(validateSettingsPayload({ wallpaper: '../x.jpg' }).ok, false);
    assert.equal(validateSettingsPayload({ wallpaper: 'ok.jpg' }).ok, true);
    assert.equal(validateSettingsPayload({ wallpaper: null, dim: 0.5 }).ok, true);
    assert.deepEqual(validateSettingsPayload({ dim: 0.9 }).patch, { dim: 0.9 });
  });

  it('normalizeStoredSettings clamps dim and drops bad wallpaper', () => {
    assert.deepEqual(normalizeStoredSettings(null), {
      wallpaper: null,
      dim: DEFAULT_SETTINGS.dim,
    });
    assert.equal(normalizeStoredSettings({ dim: 1.5 }).dim, 0.9);
    assert.equal(normalizeStoredSettings({ wallpaper: '../x' }).wallpaper, null);
    assert.equal(
      normalizeStoredSettings({ wallpaper: 'kimetsu-01.jpg' }).wallpaper,
      'kimetsu-01.jpg'
    );
  });
});

describe('pure: dim slider → CSS var mapping', () => {
  it('maps percent to fraction string and back', () => {
    assert.equal(dimPercentToCssVar(35), '0.35');
    assert.equal(dimPercentToCssVar(0), '0');
    assert.equal(dimPercentToCssVar(90), '0.9');
    assert.equal(dimPercentToCssVar(DIM_SLIDER_MAX + 50), '0.9');
    assert.equal(dimPercentToCssVar(-10), '0');
    assert.equal(dimPercentToCssVar('bogus'), dimPercentToCssVar(DIM_DEFAULT_PERCENT));
    assert.equal(dimToPercent(0.35), 35);
    assert.equal(dimToPercent(0.9), 90);
    assert.equal(dimToPercent(1.2), 90);
    assert.equal(dimPercentToApi(35), 0.35);
    assert.equal(dimPercentToApi(90), 0.9);
  });

  it('wallpaperAssetUrl encodes name', () => {
    assert.equal(
      wallpaperAssetUrl('/herd', 'kimetsu-01.jpg'),
      '/herd/api/wallpaper/kimetsu-01.jpg'
    );
  });
});

describe('listWallpapers / resolveWallpaperFile (fs)', () => {
  /** @type {string} */
  let stateDir;

  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-wp-'));
    await fs.mkdir(path.join(stateDir, 'wallpapers'), { recursive: true });
    // Prefer real fixture; else write a tiny fake jpeg header file.
    try {
      await fs.copyFile(
        FIXTURE_JPG,
        path.join(stateDir, 'wallpapers', 'kimetsu-01.jpg')
      );
    } catch {
      await fs.writeFile(
        path.join(stateDir, 'wallpapers', 'kimetsu-01.jpg'),
        Buffer.from([0xff, 0xd8, 0xff, 0xd9])
      );
    }
    await fs.writeFile(
      path.join(stateDir, 'wallpapers', 'notes.txt'),
      'ignore me'
    );
    await fs.writeFile(
      path.join(stateDir, 'wallpapers', 'extra.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
  });

  after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('lists only jpg/png/webp/gif with sizes', async () => {
    const list = await listWallpapers(stateDir);
    const names = list.map((x) => x.name).sort();
    assert.deepEqual(names, ['extra.png', 'kimetsu-01.jpg']);
    for (const item of list) {
      assert.ok(item.size > 0);
    }
  });

  it('resolveWallpaperFile serves safe names and rejects traversal', async () => {
    const ok = await resolveWallpaperFile(stateDir, 'kimetsu-01.jpg');
    assert.equal(ok.ok, true);
    assert.equal(ok.ext, '.jpg');

    const trav = await resolveWallpaperFile(stateDir, '../settings.json');
    assert.equal(trav.ok, false);
    assert.equal(trav.status, 403);

    const enc = await resolveWallpaperFile(stateDir, '%2e%2e%2fsettings.json');
    assert.equal(enc.ok, false);
    assert.equal(enc.status, 403);

    const enc2 = await resolveWallpaperFile(stateDir, '..%2fkimetsu-01.jpg');
    assert.equal(enc2.ok, false);

    const missing = await resolveWallpaperFile(stateDir, 'nope.jpg');
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  });
});

describe('bridge wallpaper + settings HTTP', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let srv;
  let base;
  /** @type {string} */
  let stateDir;

  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-wp-http-'));
    await fs.mkdir(path.join(stateDir, 'wallpapers'), { recursive: true });
    try {
      await fs.copyFile(
        FIXTURE_JPG,
        path.join(stateDir, 'wallpapers', 'kimetsu-01.jpg')
      );
    } catch {
      await fs.writeFile(
        path.join(stateDir, 'wallpapers', 'kimetsu-01.jpg'),
        Buffer.from([0xff, 0xd8, 0xff, 0xd9])
      );
    }
    srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir,
    });
    base = `http://127.0.0.1:${srv.port}`;
  });

  after(async () => {
    if (srv) await srv.close();
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('GET /herd/api/wallpapers lists images', async () => {
    const { res, json } = await api(base, '/herd/api/wallpapers');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(json.wallpapers));
    assert.ok(json.wallpapers.some((w) => w.name === 'kimetsu-01.jpg'));
    const item = json.wallpapers.find((w) => w.name === 'kimetsu-01.jpg');
    assert.ok(item.size > 0);
  });

  it('GET /herd/api/wallpaper/:name serves image with cache + type', async () => {
    const { res, text } = await api(base, '/herd/api/wallpaper/kimetsu-01.jpg');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/jpeg/);
    assert.match(res.headers.get('cache-control') || '', /max-age=86400/);
    assert.ok(text.length > 0 || Number(res.headers.get('content-length')) > 0);
  });

  it('rejects path traversal variants with 403', async () => {
    // Use raw HTTP so `..` is not client-normalized away (fetch collapses it).
    const cases = [
      '/herd/api/wallpaper/../settings.json',
      '/herd/api/wallpaper/%2e%2e%2fsettings.json',
      '/herd/api/wallpaper/%2e%2e/%2e%2e/etc/passwd',
      '/herd/api/wallpaper/..%2fkimetsu-01.jpg',
    ];
    for (const p of cases) {
      const status = await rawGetStatus(base, p);
      assert.equal(status, 403, `expected 403 for ${p}, got ${status}`);
    }
  });

  it('GET/POST settings: persist, state includes settings, reject bad values', async () => {
    const get0 = await api(base, '/herd/api/settings');
    assert.equal(get0.res.status, 200);
    assert.equal(get0.json.wallpaper, null);
    assert.ok(typeof get0.json.dim === 'number');

    const post = await api(base, '/herd/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallpaper: 'kimetsu-01.jpg', dim: 0.5 }),
    });
    assert.equal(post.res.status, 200);
    assert.equal(post.json.wallpaper, 'kimetsu-01.jpg');
    assert.equal(post.json.dim, 0.5);

    // Atomic file on disk
    const raw = await fs.readFile(path.join(stateDir, 'settings.json'), 'utf8');
    const disk = JSON.parse(raw);
    assert.equal(disk.wallpaper, 'kimetsu-01.jpg');
    assert.equal(disk.dim, 0.5);

    // State payload carries settings
    const st = await api(base, '/herd/api/state');
    assert.equal(st.res.status, 200);
    assert.equal(st.json.settings.wallpaper, 'kimetsu-01.jpg');
    assert.equal(st.json.settings.dim, 0.5);

    // dim > 0.9
    const badDim = await api(base, '/herd/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dim: 0.91 }),
    });
    assert.equal(badDim.res.status, 400);
    assert.equal(badDim.json.error, 'invalid_dim');

    // unknown field
    const badField = await api(base, '/herd/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallpaper: null, secret: true }),
    });
    assert.equal(badField.res.status, 400);
    assert.equal(badField.json.error, 'unknown_field');

    // clear wallpaper
    const clear = await api(base, '/herd/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallpaper: null }),
    });
    assert.equal(clear.res.status, 200);
    assert.equal(clear.json.wallpaper, null);
    // dim preserved
    assert.equal(clear.json.dim, 0.5);
  });

  it('POST settings requires same-origin', async () => {
    const cross = await api(base, '/herd/api/settings', {
      method: 'POST',
      Origin: 'https://evil.example',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dim: 0.2 }),
    });
    assert.equal(cross.res.status, 403);
    assert.equal(cross.json.error, 'cross_origin');

    // missing Origin/Referer
    const res = await fetch(`${base}/herd/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dim: 0.2 }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'cross_origin');
  });
});
