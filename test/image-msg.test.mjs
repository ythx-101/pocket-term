/**
 * M2-P2: message image segment parse + attach preview state machine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMessageImageSegments,
  parseMessageAttachmentSegments,
  composeImageSendText,
  composeHtmlSendText,
  reduceAttachPreview,
  initialAttachPreview,
  fileAssetUrl,
  isChatUploadImagePath,
  isChatUploadHtmlPath,
} from '../public/spa-utils.js';

describe('parseMessageImageSegments', () => {
  it('plain text stays one text segment', () => {
    const segs = parseMessageImageSegments('hello world');
    assert.deepEqual(segs, [{ type: 'text', text: 'hello world' }]);
    assert.equal(
      segs.some((s) => s.type === 'image'),
      false
    );
  });

  it('parses bracket token alone', () => {
    const p = '/srv/term-uploads/20260719-120000-shot.jpg';
    const segs = parseMessageImageSegments(`[图片: ${p}]`);
    assert.equal(segs.length, 1);
    assert.deepEqual(segs[0], { type: 'image', path: p });
    assert.equal(
      segs.some((s) => s.type === 'image'),
      true
    );
  });

  it('parses bracket + CJK caption', () => {
    const p = '/srv/term-uploads/20260719-120000-shot.jpg';
    const segs = parseMessageImageSegments(`[图片: ${p}] 看看这张图，挺好的`);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].type, 'image');
    assert.equal(segs[0].path, p);
    assert.equal(segs[1].type, 'text');
    assert.match(segs[1].text, /看看这张图/);
  });

  it('parses bare path with extension', () => {
    const p = '/srv/term-uploads/a.webp';
    const segs = parseMessageImageSegments(`see ${p} please`);
    assert.equal(segs.length, 3);
    assert.equal(segs[0].type, 'text');
    assert.equal(segs[0].text, 'see ');
    assert.deepEqual(segs[1], { type: 'image', path: p });
    assert.equal(segs[2].type, 'text');
    assert.equal(segs[2].text, ' please');
  });

  it('multi-image + mixed text', () => {
    const a = '/srv/term-uploads/one.png';
    const b = '/srv/term-uploads/two.gif';
    const text = `前缀 [图片: ${a}] 中间 ${b} 后缀中文`;
    const segs = parseMessageImageSegments(text);
    const types = segs.map((s) => s.type);
    assert.deepEqual(types, ['text', 'image', 'text', 'image', 'text']);
    assert.equal(segs[1].path, a);
    assert.equal(segs[3].path, b);
    assert.match(segs[4].text, /后缀中文/);
  });

  it('does not treat non-upload paths as images', () => {
    const segs = parseMessageImageSegments(
      '[图片: /etc/passwd.jpg] and /tmp/x.png'
    );
    assert.ok(segs.every((s) => s.type === 'text'));
  });

  it('isChatUploadImagePath validates basename + ext', () => {
    assert.equal(isChatUploadImagePath('/srv/term-uploads/a.jpg'), true);
    assert.equal(isChatUploadImagePath('/srv/term-uploads/a.JPEG'), true);
    assert.equal(isChatUploadImagePath('/srv/term-uploads/../x.jpg'), false);
    assert.equal(isChatUploadImagePath('/srv/term-uploads/sub/a.jpg'), false);
    assert.equal(isChatUploadImagePath('/srv/term-uploads/a.txt'), false);
  });

  it('empty / null', () => {
    assert.deepEqual(parseMessageImageSegments(''), [{ type: 'text', text: '' }]);
    assert.deepEqual(parseMessageImageSegments(null), [
      { type: 'text', text: '' },
    ]);
  });
});

describe('HTML attachment tokens', () => {
  it('parses HTML bracket/bare tokens but not Markdown', () => {
    const p = '/srv/term-uploads/20260719-120000-report.html';
    assert.deepEqual(parseMessageAttachmentSegments(`[HTML: ${p}]`), [
      { type: 'html', path: p },
    ]);
    assert.deepEqual(parseMessageAttachmentSegments(`see ${p}`), [
      { type: 'text', text: 'see ' },
      { type: 'html', path: p },
    ]);
    assert.deepEqual(parseMessageAttachmentSegments('report.md'), [
      { type: 'text', text: 'report.md' },
    ]);
    assert.equal(isChatUploadHtmlPath(p), true);
    assert.equal(isChatUploadHtmlPath('/srv/term-uploads/../x.html'), false);
  });

  it('composes HTML token and preserves attachment kind state', () => {
    const p = '/srv/term-uploads/report.htm';
    assert.equal(composeHtmlSendText('', p), `[HTML: ${p}]`);
    assert.equal(composeHtmlSendText('说明', p), `[HTML: ${p}] 说明`);
    const selected = reduceAttachPreview(null, { type: 'set', path: p, kind: 'html' });
    assert.deepEqual(selected, { path: p, kind: 'html' });
    assert.deepEqual(reduceAttachPreview(selected, { type: 'send' }), { path: null });
  });
});

describe('composeImageSendText', () => {
  it('path only', () => {
    assert.equal(
      composeImageSendText('', '/srv/term-uploads/a.jpg'),
      '[图片: /srv/term-uploads/a.jpg]'
    );
    assert.equal(
      composeImageSendText('   ', '/srv/term-uploads/a.jpg'),
      '[图片: /srv/term-uploads/a.jpg]'
    );
  });

  it('path + CJK caption', () => {
    assert.equal(
      composeImageSendText('你好世界', '/srv/term-uploads/a.jpg'),
      '[图片: /srv/term-uploads/a.jpg] 你好世界'
    );
  });

  it('no path returns caption', () => {
    assert.equal(composeImageSendText('hi', null), 'hi');
    assert.equal(composeImageSendText('hi', ''), 'hi');
  });
});

describe('reduceAttachPreview state machine', () => {
  it('select → remove → clear', () => {
    let s = initialAttachPreview();
    assert.equal(s.path, null);

    s = reduceAttachPreview(s, {
      type: 'set',
      path: '/srv/term-uploads/a.jpg',
    });
    assert.equal(s.path, '/srv/term-uploads/a.jpg');

    s = reduceAttachPreview(s, { type: 'remove' });
    assert.equal(s.path, null);

    s = reduceAttachPreview(s, {
      type: 'set',
      path: '/srv/term-uploads/b.png',
    });
    assert.equal(s.path, '/srv/term-uploads/b.png');

    s = reduceAttachPreview(s, { type: 'send' });
    assert.equal(s.path, null);

    s = reduceAttachPreview(s, {
      type: 'set',
      path: '/srv/term-uploads/c.webp',
    });
    s = reduceAttachPreview(s, { type: 'clear' });
    assert.equal(s.path, null);
  });

  it('set with empty path clears', () => {
    const s = reduceAttachPreview({ path: '/x' }, { type: 'set', path: '' });
    assert.equal(s.path, null);
  });

  it('replacing path overwrites previous', () => {
    let s = reduceAttachPreview(null, {
      type: 'set',
      path: '/srv/term-uploads/1.jpg',
    });
    s = reduceAttachPreview(s, {
      type: 'set',
      path: '/srv/term-uploads/2.jpg',
    });
    assert.equal(s.path, '/srv/term-uploads/2.jpg');
  });
});

describe('fileAssetUrl', () => {
  it('builds query under base', () => {
    assert.equal(
      fileAssetUrl('/herd', '/srv/term-uploads/a.jpg'),
      '/herd/api/file?path=' + encodeURIComponent('/srv/term-uploads/a.jpg')
    );
    assert.equal(
      fileAssetUrl('/herd/', '/srv/term-uploads/a.jpg'),
      '/herd/api/file?path=' + encodeURIComponent('/srv/term-uploads/a.jpg')
    );
  });
});
