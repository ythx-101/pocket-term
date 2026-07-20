/**
 * M2-P2: GET /herd/api/file whitelist / escape / ext / HEAD + pure helpers.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {
  startServer,
  resolveChatUploadFile,
  readChatUploadLimited,
  DEFAULT_FILE_SERVE_ROOT,
  CACHE_FILE,
  FILE_IMAGE_EXTS,
  FILE_HTML_EXTS,
  HTML_PREVIEW_CSP,
  HTML_FILE_SERVE_MAX_BYTES,
} from '../server.js';

const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PNG_MIN = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

describe('pure: resolveChatUploadFile', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let outside;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-file-root-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-file-out-'));
    await fs.writeFile(path.join(root, 'ok.jpg'), JPEG_MIN);
    await fs.writeFile(path.join(root, 'ok.png'), PNG_MIN);
    await fs.writeFile(path.join(root, 'notes.txt'), 'not image');
    await fs.writeFile(path.join(root, 'doc.html'), '<!doctype html><h1>safe</h1>');
    await fs.writeFile(path.join(root, 'doc.htm'), '<p>safe</p>');
    await fs.writeFile(path.join(root, 'too-large.html'), Buffer.alloc(HTML_FILE_SERVE_MAX_BYTES + 1));
    await fs.writeFile(path.join(outside, 'secret.jpg'), JPEG_MIN);
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  });

  it('allows image under root', async () => {
    const r = await resolveChatUploadFile(path.join(root, 'ok.jpg'), root);
    assert.equal(r.ok, true);
    assert.equal(r.ext, '.jpg');
    assert.ok(r.file.endsWith('ok.jpg'));
  });

  it('rejects path outside root', async () => {
    const r = await resolveChatUploadFile(path.join(outside, 'secret.jpg'), root);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it('rejects traversal', async () => {
    const r = await resolveChatUploadFile(
      path.join(root, '..', path.basename(outside), 'secret.jpg'),
      root
    );
    // Either blocked by `..` token or lexical containment
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it('allows HTML extensions and rejects oversized HTML', async () => {
    const r = await resolveChatUploadFile(path.join(root, 'doc.html'), root);
    assert.equal(r.ok, true);
    assert.equal(r.ext, '.html');
    const htm = await resolveChatUploadFile(path.join(root, 'doc.htm'), root);
    assert.equal(htm.ok, true);
    const large = await resolveChatUploadFile(path.join(root, 'too-large.html'), root);
    assert.equal(large.ok, false);
    assert.equal(large.status, 413);
  });

  it('enforces the HTML byte cap again while reading the opened descriptor', async () => {
    const read = await readChatUploadLimited(path.join(root, 'too-large.html'), '.html', root);
    assert.equal(read.ok, false);
    assert.equal(read.status, 413);
  });

  it('rejects non-image/non-HTML extension', async () => {
    const r = await resolveChatUploadFile(path.join(root, 'notes.txt'), root);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it('rejects missing file with 404', async () => {
    const r = await resolveChatUploadFile(path.join(root, 'nope.webp'), root);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  });

  it('rejects symlink escape', async () => {
    const link = path.join(root, 'escape.jpg');
    try {
      await fs.symlink(path.join(outside, 'secret.jpg'), link);
    } catch (err) {
      // Some FS may disallow symlinks — skip
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') {
        return;
      }
      throw err;
    }
    const r = await resolveChatUploadFile(link, root);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    try {
      await fs.unlink(link);
    } catch {
      /* ignore */
    }
  });

  it('rejects empty / relative / null-byte', async () => {
    assert.equal((await resolveChatUploadFile('', root)).status, 403);
    assert.equal((await resolveChatUploadFile(null, root)).status, 403);
    assert.equal((await resolveChatUploadFile('ok.jpg', root)).status, 403);
    assert.equal(
      (await resolveChatUploadFile(path.join(root, 'ok\0.jpg'), root)).status,
      403
    );
  });

  it('exports constants', () => {
    assert.equal(DEFAULT_FILE_SERVE_ROOT, '/srv/term-uploads');
    assert.equal(CACHE_FILE, 'public, max-age=86400');
    assert.ok(FILE_IMAGE_EXTS.has('.jpg'));
    assert.ok(FILE_IMAGE_EXTS.has('.webp'));
    assert.ok(FILE_HTML_EXTS.has('.html'));
    assert.match(HTML_PREVIEW_CSP, /frame-ancestors 'self'/);
    assert.match(HTML_PREVIEW_CSP, /script-src 'none'/);
  });
});

describe('HTTP GET/HEAD /herd/api/file', () => {
  /** @type {string} */
  let stateDir;
  /** @type {string} */
  let fileRoot;
  /** @type {string} */
  let outside;
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let srv;
  /** @type {string} */
  let base;

  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-file-http-'));
    fileRoot = path.join(stateDir, 'term-uploads');
    outside = path.join(stateDir, 'outside');
    await fs.mkdir(fileRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(path.join(stateDir, 'wallpapers'), { recursive: true });
    await fs.writeFile(path.join(fileRoot, 'shot.jpg'), JPEG_MIN);
    await fs.writeFile(path.join(fileRoot, 'pic.png'), PNG_MIN);
    await fs.writeFile(path.join(fileRoot, 'readme.txt'), 'nope');
    await fs.writeFile(path.join(fileRoot, 'doc.html'), '<!doctype html><h1>safe</h1>');
    await fs.writeFile(path.join(fileRoot, 'doc.htm'), '<p>safe</p>');
    await fs.writeFile(path.join(fileRoot, 'too-large.html'), Buffer.alloc(HTML_FILE_SERVE_MAX_BYTES + 1));
    await fs.writeFile(path.join(outside, 'secret.jpg'), JPEG_MIN);
    srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir,
      chatUploadDir: fileRoot,
      fileServeRoot: fileRoot,
    });
    base = `http://127.0.0.1:${srv.port}`;
  });

  after(async () => {
    if (srv) await srv.close();
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('GET serves HTML with safe preview headers', async () => {
    const abs = path.join(fileRoot, 'doc.html');
    const res = await fetch(`${base}/herd/api/file?path=${encodeURIComponent(abs)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-disposition'), 'inline; filename="doc.html"');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /navigate-to 'none'/);
    assert.match(csp, /sandbox/);
    assert.match(csp, /script-src 'none'/);
    assert.doesNotMatch(csp, /allow-scripts/);
    assert.equal(await res.text(), '<!doctype html><h1>safe</h1>');
  });

  it('HEAD serves HTML headers without body', async () => {
    const abs = path.join(fileRoot, 'doc.htm');
    const res = await fetch(`${base}/herd/api/file?path=${encodeURIComponent(abs)}`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-disposition'), 'inline; filename="doc.htm"');
    assert.equal(await res.text(), '');
  });

  it('rejects oversized HTML before reading it', async () => {
    const abs = path.join(fileRoot, 'too-large.html');
    const res = await fetch(`${base}/herd/api/file?path=${encodeURIComponent(abs)}`);
    assert.equal(res.status, 413);
  });

  it('GET serves image with content-type and cache', async () => {
    const abs = path.join(fileRoot, 'shot.jpg');
    const res = await fetch(
      `${base}/herd/api/file?path=${encodeURIComponent(abs)}`
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/jpeg/);
    assert.equal(res.headers.get('cache-control'), CACHE_FILE);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, JPEG_MIN);
  });

  it('HEAD returns same headers without body', async () => {
    const abs = path.join(fileRoot, 'pic.png');
    const res = await fetch(
      `${base}/herd/api/file?path=${encodeURIComponent(abs)}`,
      { method: 'HEAD' }
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/png/);
    assert.equal(res.headers.get('cache-control'), CACHE_FILE);
    assert.equal(Number(res.headers.get('content-length')), PNG_MIN.length);
    // body should be empty for HEAD
    const text = await res.text();
    assert.equal(text, '');
  });

  it('403 for path outside whitelist root', async () => {
    const abs = path.join(outside, 'secret.jpg');
    const res = await fetch(
      `${base}/herd/api/file?path=${encodeURIComponent(abs)}`
    );
    assert.equal(res.status, 403);
  });

  it('403 for traversal via ..', async () => {
    const sneaky = path.join(fileRoot, '..', 'outside', 'secret.jpg');
    const res = await fetch(
      `${base}/herd/api/file?path=${encodeURIComponent(sneaky)}`
    );
    assert.equal(res.status, 403);
  });

  it('403 for non-image extension even if under root', async () => {
    const abs = path.join(fileRoot, 'readme.txt');
    const res = await fetch(
      `${base}/herd/api/file?path=${encodeURIComponent(abs)}`
    );
    assert.equal(res.status, 403);
  });

  it('404 for missing image under root', async () => {
    const abs = path.join(fileRoot, 'missing-xyz.webp');
    const res = await fetch(
      `${base}/herd/api/file?path=${encodeURIComponent(abs)}`
    );
    assert.equal(res.status, 404);
  });

  it('403 for symlink escape via HTTP', async () => {
    const link = path.join(fileRoot, 'link-escape.jpg');
    try {
      await fs.symlink(path.join(outside, 'secret.jpg'), link);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') return;
      throw err;
    }
    const res = await fetch(
      `${base}/herd/api/file?path=${encodeURIComponent(link)}`
    );
    assert.equal(res.status, 403);
    try {
      await fs.unlink(link);
    } catch {
      /* ignore */
    }
  });

  it('403 when path query missing', async () => {
    const res = await fetch(`${base}/herd/api/file`);
    assert.equal(res.status, 403);
  });
});
