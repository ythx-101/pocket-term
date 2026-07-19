/**
 * M2-P1 image upload: magic/ext/limit/origin/READONLY + atomic write.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  startServer,
  parseUploadFilename,
  detectImageMagic,
  magicMatchesExt,
  buildUploadStoredName,
  writeUploadAtomic,
  handleImageUpload,
  UPLOAD_MAX_BYTES,
} from '../server.js';
import { isSafeWallpaperName } from '../lib/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FIXTURE_JPG = path.join(ROOT, 'state', 'wallpapers', 'kimetsu-01.jpg');

/** Minimal valid image buffers (magic only — enough for type detection). */
const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PNG_MIN = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
const GIF_MIN = Buffer.from('GIF89a', 'ascii');
const WEBP_MIN = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const TEXT_FAKE = Buffer.from('not an image at all');

/**
 * @param {string} base
 * @param {string} urlPath
 * @param {RequestInit & { Origin?: string }} [opts]
 */
async function api(base, urlPath, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.Origin !== undefined) {
    if (opts.Origin !== null) headers.Origin = opts.Origin;
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

describe('pure: upload filename + magic', () => {
  it('parseUploadFilename accepts basename images', () => {
    const ok = parseUploadFilename('photo.JPG');
    assert.equal(ok.ok, true);
    assert.equal(ok.ext, '.jpg');
    assert.equal(ok.slug, 'photo');

    const png = parseUploadFilename('my wall art.png');
    assert.equal(png.ok, true);
    assert.equal(png.ext, '.png');
    assert.match(png.slug, /wall/);
  });

  it('parseUploadFilename rejects path injection, null, overlong, bad ext', () => {
    assert.equal(parseUploadFilename('../etc/passwd.jpg').ok, false);
    assert.equal(parseUploadFilename('foo/bar.jpg').ok, false);
    assert.equal(parseUploadFilename('foo\\bar.jpg').ok, false);
    assert.equal(parseUploadFilename('evil..jpg').ok, false);
    assert.equal(parseUploadFilename('x\0.jpg').ok, false);
    assert.equal(parseUploadFilename('a'.repeat(600) + '.jpg').ok, false);
    assert.equal(parseUploadFilename('notes.txt').ok, false);
    assert.equal(parseUploadFilename('noext').ok, false);
    assert.equal(parseUploadFilename('').ok, false);
    assert.equal(parseUploadFilename(null).ok, false);
  });

  it('detectImageMagic + magicMatchesExt', () => {
    assert.equal(detectImageMagic(JPEG_MIN), '.jpg');
    assert.equal(detectImageMagic(PNG_MIN), '.png');
    assert.equal(detectImageMagic(GIF_MIN), '.gif');
    assert.equal(detectImageMagic(WEBP_MIN), '.webp');
    assert.equal(detectImageMagic(TEXT_FAKE), null);
    assert.equal(magicMatchesExt('.jpg', '.jpg'), true);
    assert.equal(magicMatchesExt('.jpeg', '.jpg'), true);
    assert.equal(magicMatchesExt('.png', '.jpg'), false);
    assert.equal(magicMatchesExt('.png', null), false);
  });

  it('buildUploadStoredName stamps + slugs', () => {
    const d = new Date(2026, 6, 19, 15, 4, 5); // local
    const name = buildUploadStoredName('my_photo', '.jpeg', d);
    assert.match(name, /^20260719-150405-my_photo\.jpg$/);
  });

  it('isSafeWallpaperName accepts gif after M2-P1', () => {
    assert.equal(isSafeWallpaperName('a.gif'), true);
  });
});

describe('writeUploadAtomic + handleImageUpload', () => {
  /** @type {string} */
  let tmpRoot;

  before(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-up-'));
  });

  after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('atomic write lands file and leaves no .tmp residue', async () => {
    const dir = path.join(tmpRoot, 'atom');
    const r = await writeUploadAtomic(dir, '20260719-000000-test.jpg', JPEG_MIN);
    assert.equal(r.ok, true);
    const st = await fs.stat(r.path);
    assert.ok(st.isFile());
    assert.equal(st.size, JPEG_MIN.length);
    const entries = await fs.readdir(dir);
    assert.ok(!entries.some((n) => n.endsWith('.tmp') || n.startsWith('.upload-')));
  });

  it('handleImageUpload chat vs wallpaper paths', async () => {
    const chatDir = path.join(tmpRoot, 'chat-up');
    const stateDir = path.join(tmpRoot, 'state-up');
    await fs.mkdir(path.join(stateDir, 'wallpapers'), { recursive: true });

    const chat = await handleImageUpload({
      target: 'chat',
      rawFilename: 'shot.png',
      body: PNG_MIN,
      chatUploadDir: chatDir,
      stateDir,
      readonly: false,
      now: new Date(2026, 0, 2, 3, 4, 5),
    });
    assert.equal(chat.ok, true);
    assert.ok(chat.body.path);
    assert.ok(chat.body.path.endsWith('.png'));
    assert.ok(fsSync.existsSync(chat.body.path));

    const wp = await handleImageUpload({
      target: 'wallpaper',
      rawFilename: 'bg.webp',
      body: WEBP_MIN,
      chatUploadDir: chatDir,
      stateDir,
      readonly: false,
      now: new Date(2026, 0, 2, 3, 4, 6),
    });
    assert.equal(wp.ok, true);
    assert.ok(wp.body.name);
    assert.ok(wp.body.name.endsWith('.webp'));
    const wpPath = path.join(stateDir, 'wallpapers', wp.body.name);
    assert.ok(fsSync.existsSync(wpPath));
  });

  it('READONLY blocks chat upload but allows wallpaper', async () => {
    const chatDir = path.join(tmpRoot, 'ro-chat');
    const stateDir = path.join(tmpRoot, 'ro-state');
    await fs.mkdir(path.join(stateDir, 'wallpapers'), { recursive: true });

    const chat = await handleImageUpload({
      target: 'chat',
      rawFilename: 'a.jpg',
      body: JPEG_MIN,
      chatUploadDir: chatDir,
      stateDir,
      readonly: true,
    });
    assert.equal(chat.ok, false);
    assert.equal(chat.status, 403);
    assert.equal(chat.error, 'readonly');

    const wp = await handleImageUpload({
      target: 'wallpaper',
      rawFilename: 'b.jpg',
      body: JPEG_MIN,
      chatUploadDir: chatDir,
      stateDir,
      readonly: true,
      now: new Date(2026, 0, 3, 0, 0, 0),
    });
    assert.equal(wp.ok, true);
    assert.ok(wp.body.name);
  });

  it('rejects magic mismatch and empty body', async () => {
    const chatDir = path.join(tmpRoot, 'bad');
    const stateDir = path.join(tmpRoot, 'bad-st');
    const bad = await handleImageUpload({
      target: 'chat',
      rawFilename: 'a.png',
      body: JPEG_MIN, // jpeg magic, png ext
      chatUploadDir: chatDir,
      stateDir,
      readonly: false,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'magic_mismatch');

    const empty = await handleImageUpload({
      target: 'chat',
      rawFilename: 'a.jpg',
      body: Buffer.alloc(0),
      chatUploadDir: chatDir,
      stateDir,
      readonly: false,
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, 'empty_body');
  });
});

describe('bridge POST /herd/api/upload HTTP', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let srv;
  let base;
  /** @type {string} */
  let stateDir;
  /** @type {string} */
  let chatUploadDir;
  /** @type {Awaited<ReturnType<typeof startServer>>|null} */
  let roSrv = null;
  let roBase = '';

  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-up-http-'));
    chatUploadDir = path.join(stateDir, 'term-uploads');
    await fs.mkdir(path.join(stateDir, 'wallpapers'), { recursive: true });
    await fs.mkdir(chatUploadDir, { recursive: true });
    try {
      await fs.copyFile(FIXTURE_JPG, path.join(stateDir, 'wallpapers', 'kimetsu-01.jpg'));
    } catch {
      await fs.writeFile(
        path.join(stateDir, 'wallpapers', 'kimetsu-01.jpg'),
        JPEG_MIN
      );
    }
    srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir,
      chatUploadDir,
    });
    base = `http://127.0.0.1:${srv.port}`;
  });

  after(async () => {
    if (roSrv) await roSrv.close();
    if (srv) await srv.close();
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('successful chat upload writes file and returns path', async () => {
    let body = JPEG_MIN;
    try {
      body = await fs.readFile(FIXTURE_JPG);
    } catch {
      /* use min */
    }
    const { res, json } = await api(base, '/herd/api/upload?target=chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Filename': 'Screenshot_demo.jpg',
      },
      body,
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.ok(json.path);
    assert.ok(json.path.includes(chatUploadDir) || json.path.startsWith('/'));
    assert.match(path.basename(json.path), /^\d{8}-\d{6}-Screenshot_demo\.jpg$/);
    const st = await fs.stat(json.path);
    assert.equal(st.size, body.length);
    // no tmp leftovers
    const entries = await fs.readdir(chatUploadDir);
    assert.ok(!entries.some((n) => n.includes('.tmp') || n.startsWith('.upload-')));
  });

  it('successful wallpaper upload appears in list', async () => {
    const { res, json } = await api(base, '/herd/api/upload?target=wallpaper', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'X-Filename': 'new_bg.png',
      },
      body: PNG_MIN,
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.ok(json.name);
    assert.match(json.name, /^\d{8}-\d{6}-new_bg\.png$/);
    const onDisk = path.join(stateDir, 'wallpapers', json.name);
    assert.ok(fsSync.existsSync(onDisk));

    const list = await api(base, '/herd/api/wallpapers');
    assert.equal(list.res.status, 200);
    assert.ok(list.json.wallpapers.some((w) => w.name === json.name));
  });

  it('rejects bad extension', async () => {
    const { res, json } = await api(base, '/herd/api/upload?target=chat', {
      method: 'POST',
      headers: { 'X-Filename': 'notes.txt' },
      body: TEXT_FAKE,
    });
    assert.equal(res.status, 400);
    assert.equal(json.error, 'invalid_extension');
  });

  it('rejects magic mismatch', async () => {
    const { res, json } = await api(base, '/herd/api/upload?target=chat', {
      method: 'POST',
      headers: { 'X-Filename': 'fake.png' },
      body: JPEG_MIN,
    });
    assert.equal(res.status, 400);
    assert.equal(json.error, 'magic_mismatch');
  });

  it('rejects oversize via Content-Length (413)', async () => {
    // Raw HTTP so we can claim CL > max without shipping 10MB+ (fetch rewrites CL).
    const u = new URL(base);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: '/herd/api/upload?target=chat',
          method: 'POST',
          headers: {
            Origin: `http://${u.host}`,
            'X-Filename': 'big.jpg',
            'Content-Type': 'image/jpeg',
            'Content-Length': String(UPLOAD_MAX_BYTES + 1),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => {
            data += c;
          });
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve({ status: res.statusCode, json });
            } catch {
              resolve({ status: res.statusCode, json: null });
            }
          });
        }
      );
      req.on('error', reject);
      // Do not write body — server rejects on CL before needing full payload.
      req.end();
    });
    assert.equal(status.status, 413);
    assert.equal(status.json?.error, 'payload_too_large');
  });

  it('rejects cross-origin and missing Origin', async () => {
    const cross = await api(base, '/herd/api/upload?target=chat', {
      method: 'POST',
      Origin: 'https://evil.example',
      headers: { 'X-Filename': 'a.jpg' },
      body: JPEG_MIN,
    });
    assert.equal(cross.res.status, 403);
    assert.equal(cross.json.error, 'cross_origin');

    const res = await fetch(`${base}/herd/api/upload?target=chat`, {
      method: 'POST',
      headers: { 'X-Filename': 'a.jpg', 'Content-Type': 'image/jpeg' },
      body: JPEG_MIN,
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'cross_origin');
  });

  it('rejects filename injection', async () => {
    // Null-byte headers are rejected by fetch/undici client-side; pure unit
    // covers parseUploadFilename('\0'). HTTP path covers path/long names.
    for (const name of [
      '../etc/passwd.jpg',
      'a/b.jpg',
      'evil..jpg',
      `${'z'.repeat(600)}.jpg`,
    ]) {
      const { res, json } = await api(base, '/herd/api/upload?target=chat', {
        method: 'POST',
        headers: { 'X-Filename': name },
        body: JPEG_MIN,
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(name)}`);
      assert.ok(
        json.error === 'invalid_filename' ||
          json.error === 'filename_too_long' ||
          json.error === 'invalid_extension',
        json.error
      );
    }
  });

  it('rejects invalid target', async () => {
    const { res, json } = await api(base, '/herd/api/upload?target=other', {
      method: 'POST',
      headers: { 'X-Filename': 'a.jpg' },
      body: JPEG_MIN,
    });
    assert.equal(res.status, 400);
    assert.equal(json.error, 'invalid_target');
  });

  it('PT2_READONLY blocks chat upload, allows wallpaper', async () => {
    const roState = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-up-ro-'));
    const roChat = path.join(roState, 'term-uploads');
    await fs.mkdir(path.join(roState, 'wallpapers'), { recursive: true });
    await fs.mkdir(roChat, { recursive: true });
    roSrv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir: roState,
      chatUploadDir: roChat,
      readonly: true,
    });
    roBase = `http://127.0.0.1:${roSrv.port}`;

    const chat = await api(roBase, '/herd/api/upload?target=chat', {
      method: 'POST',
      headers: { 'X-Filename': 'a.jpg' },
      body: JPEG_MIN,
    });
    assert.equal(chat.res.status, 403);
    assert.equal(chat.json.error, 'readonly');

    const wp = await api(roBase, '/herd/api/upload?target=wallpaper', {
      method: 'POST',
      headers: { 'X-Filename': 'ok.jpg' },
      body: JPEG_MIN,
    });
    assert.equal(wp.res.status, 200, JSON.stringify(wp.json));
    assert.ok(wp.json.name);

    await roSrv.close();
    roSrv = null;
    await fs.rm(roState, { recursive: true, force: true }).catch(() => {});
  });

  it('failed magic leaves no tmp files in chat dir', async () => {
    const before = new Set(await fs.readdir(chatUploadDir));
    await api(base, '/herd/api/upload?target=chat', {
      method: 'POST',
      headers: { 'X-Filename': 'x.png' },
      body: TEXT_FAKE,
    });
    const after = await fs.readdir(chatUploadDir);
    for (const n of after) {
      if (!before.has(n)) {
        assert.ok(!n.endsWith('.tmp') && !n.startsWith('.upload-'), n);
      }
    }
    // magic fails before write — no new files at all
    assert.deepEqual(after.sort(), [...before].sort());
  });
});
