import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  startServer,
  DOCUMENT_MAX_BYTES,
  FILE_DOCUMENT_EXTS,
  handleMarkdownUpload,
  parseUploadFilename,
  resolveChatUploadFile,
} from '../server.js';
import {
  parseMessageSegments,
  isChatUploadDocumentPath,
  composeDocumentSendText,
} from '../public/attachment-utils.js';
import {
  isSafeMarkdownUrl,
  normalizeMarkdown,
  MARKDOWN_MAX_BYTES,
} from '../public/markdown.js';

const markdown = '# Hello\n\n**safe**\n\n<script>alert(1)</script>\n';

function api(base, pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.method && opts.method !== 'GET' && opts.method !== 'HEAD') {
    headers.Origin = `http://${new URL(base).host}`;
  }
  return fetch(`${base}${pathname}`, { ...opts, headers });
}

describe('Markdown upload and path boundaries', () => {
  it('allows only .md through the document allowlist', () => {
    assert.equal(FILE_DOCUMENT_EXTS.has('.md'), true);
    assert.equal(parseUploadFilename('notes.md', FILE_DOCUMENT_EXTS).ok, true);
    assert.equal(parseUploadFilename('notes.html', FILE_DOCUMENT_EXTS).ok, false);
    assert.equal(parseUploadFilename('../notes.md', FILE_DOCUMENT_EXTS).ok, false);
  });

  it('enforces the 512 KiB handler limit and generated basename', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-md-up-'));
    try {
      const ok = await handleMarkdownUpload({
        rawFilename: 'notes.md',
        body: Buffer.from(markdown),
        chatUploadDir: root,
        readonly: false,
        now: new Date(2026, 0, 2, 3, 4, 5),
      });
      assert.equal(ok.ok, true);
      assert.match(path.basename(ok.body.path), /^20260102-030405-notes\.md$/);
      assert.equal(fsSync.existsSync(ok.body.path), true);
      const tooLarge = await handleMarkdownUpload({
        rawFilename: 'large.md',
        body: Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 0x61),
        chatUploadDir: root,
        readonly: false,
      });
      assert.deepEqual(tooLarge, { ok: false, status: 413, error: 'payload_too_large' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects outside root, symlink escape and oversized documents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-md-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-md-out-'));
    try {
      const inside = path.join(root, 'ok.md');
      await fs.writeFile(inside, markdown);
      await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
      assert.equal((await resolveChatUploadFile(inside, root)).ok, true);
      assert.equal((await resolveChatUploadFile(path.join(outside, 'secret.md'), root)).status, 403);
      const link = path.join(root, 'escape.md');
      try {
        await fs.symlink(path.join(outside, 'secret.md'), link);
        assert.equal((await resolveChatUploadFile(link, root)).status, 403);
      } catch (err) {
        if (err?.code !== 'EPERM') throw err;
      }
      await fs.writeFile(inside, Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 0x61));
      assert.equal((await resolveChatUploadFile(inside, root)).status, 413);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('Markdown HTTP surface', () => {
  let stateDir;
  let uploadDir;
  let srv;
  let base;
  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-md-http-'));
    uploadDir = path.join(stateDir, 'term-uploads');
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(path.join(stateDir, 'wallpapers'), { recursive: true });
    srv = await startServer({ host: '127.0.0.1', port: 0, stateDir, chatUploadDir: uploadDir, fileServeRoot: uploadDir });
    base = `http://127.0.0.1:${srv.port}`;
  });
  after(async () => {
    await srv?.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  it('serves Markdown preview assets without adding an HTML preview route', async () => {
    const html = await api(base, '/herd/');
    assert.equal(html.status, 200);
    const htmlText = await html.text();
    assert.match(htmlText, /id="markdown-viewer"/);
    assert.doesNotMatch(htmlText, /accept="[^"\n]*\.html/);
    const app = await api(base, '/herd/app.js');
    assert.equal(app.status, 200);
    const appText = await app.text();
    assert.match(appText, /attachment-utils\.js\?v=/);
    assert.match(appText, /markdown\.js\?v=/);
    const js = await api(base, '/herd/markdown.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') || '', /javascript/);
    assert.match(js.headers.get('cache-control') || '', /immutable/);
  });

  it('uploads and serves Markdown as text/plain with nosniff', async () => {
    const upload = await api(base, '/herd/api/upload?target=chat', {
      method: 'POST',
      headers: { 'X-Filename': 'readme.md', 'Content-Type': 'text/markdown' },
      body: Buffer.from(markdown),
    });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json();
    assert.match(uploaded.path, /readme\.md$/);
    const res = await api(base, `/herd/api/file?path=${encodeURIComponent(uploaded.path)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/plain/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await res.text(), markdown);
  });
});

describe('safe attachment and Markdown policy helpers', () => {
  it('recognizes only canonical document token paths', () => {
    const p = '/srv/term-uploads/20260102-030405-notes.md';
    assert.equal(isChatUploadDocumentPath(p), true);
    assert.equal(isChatUploadDocumentPath('/srv/term-uploads/../secret.md'), false);
    assert.deepEqual(parseMessageSegments(`[文档: ${p}] 看看`), [
      { type: 'document', path: p },
      { type: 'text', text: ' 看看' },
    ]);
    assert.deepEqual(parseMessageSegments('[文档: /etc/passwd.md]'), [
      { type: 'text', text: '[文档: /etc/passwd.md]' },
    ]);
    assert.equal(composeDocumentSendText('说明', p), `[文档: ${p}] 说明`);
  });

  it('allows only explicit http(s)/mailto links and caps normalization', () => {
    assert.equal(isSafeMarkdownUrl('https://example.com/a'), true);
    assert.equal(isSafeMarkdownUrl('http://example.com'), true);
    assert.equal(isSafeMarkdownUrl('mailto:user@example.com'), true);
    assert.equal(isSafeMarkdownUrl('javascript:alert(1)'), false);
    assert.equal(isSafeMarkdownUrl('//example.com'), false);
    assert.equal(isSafeMarkdownUrl('data:text/html,x'), false);
    assert.equal(normalizeMarkdown('\u0000<script>'), '\ufffd<script>');
    assert.equal(new TextEncoder().encode(normalizeMarkdown('a'.repeat(MARKDOWN_MAX_BYTES + 1))).length, MARKDOWN_MAX_BYTES);
  });
});
