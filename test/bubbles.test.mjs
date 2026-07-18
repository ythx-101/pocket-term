/**
 * Tier B bubbles pure-function tests (no herdr, no network).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffNewText,
  foldBubbles,
  stripAnsi,
  compressBlankLines,
} from '../lib/bubbles.js';

describe('stripAnsi + compressBlankLines', () => {
  it('strips CSI / OSC ANSI sequences', () => {
    const raw = '\x1b[31mred\x1b[0m normal \x1b]0;title\x07 done';
    const out = stripAnsi(raw);
    assert.equal(out.includes('\x1b'), false);
    assert.match(out, /red/);
    assert.match(out, /normal/);
    assert.match(out, /done/);
  });

  it('compresses runs of blank lines to one', () => {
    assert.deepEqual(compressBlankLines(['a', '', '', '', 'b', '', 'c']), [
      'a',
      '',
      'b',
      '',
      'c',
    ]);
  });
});

describe('diffNewText', () => {
  it('returns all lines when prev is empty', () => {
    assert.deepEqual(diffNewText('', 'one\ntwo\n'), ['one', 'two']);
  });

  it('detects pure append', () => {
    const prev = 'a\nb\n';
    const next = 'a\nb\nc\n';
    assert.deepEqual(diffNewText(prev, next), ['c']);
  });

  it('handles scroll: common prefix of next with suffix of prev', () => {
    const prev = 'A\nB\nC\nD\nE\n';
    const next = 'C\nD\nE\nF\nG\n';
    assert.deepEqual(diffNewText(prev, next), ['F', 'G']);
  });

  it('full redraw: prefers over-including (all next lines)', () => {
    const prev = 'old1\nold2\n';
    const next = 'new1\nnew2\nnew3\n';
    assert.deepEqual(diffNewText(prev, next), ['new1', 'new2', 'new3']);
  });

  it('CJK append without losing characters', () => {
    const prev = '你好\n';
    const next = '你好\n世界\n';
    assert.deepEqual(diffNewText(prev, next), ['世界']);
  });

  it('identical text → empty', () => {
    assert.deepEqual(diffNewText('same\n', 'same\n'), []);
  });
});

describe('foldBubbles', () => {
  it('seals bubble after silence ≥ 2000ms', () => {
    const bubbles = foldBubbles([
      { ts: 1000, lines: ['hello', 'world'] },
      { ts: 1500, lines: ['more'] },
      { ts: 4000, lines: ['next bubble'] }, // 2500ms silence
    ]);
    assert.ok(bubbles.length >= 2);
    assert.match(bubbles[0].text, /hello/);
    assert.match(bubbles[0].text, /more/);
    assert.match(bubbles[1].text, /next bubble/);
    assert.ok(bubbles.every((b) => typeof b.ts === 'number'));
  });

  it('seals on working → idle / done', () => {
    const bubbles = foldBubbles([
      { ts: 1000, status: 'working' },
      { ts: 1100, lines: ['working output line 1'] },
      { ts: 1200, lines: ['working output line 2'] },
      { ts: 1300, status: 'idle' },
      { ts: 1400, lines: ['after idle'] },
    ]);
    assert.ok(bubbles.length >= 2);
    const first = bubbles[0].text;
    assert.match(first, /working output/);
    assert.ok(!first.includes('after idle'));
    assert.match(bubbles[1].text, /after idle/);
  });

  it('seals on working → done', () => {
    const bubbles = foldBubbles([
      { ts: 0, status: 'working' },
      { ts: 10, lines: ['\x1b[32mdone-ish\x1b[0m'] },
      { ts: 20, status: 'done' },
    ]);
    assert.equal(bubbles.length, 1);
    assert.equal(bubbles[0].text.includes('\x1b'), false);
    assert.match(bubbles[0].text, /done-ish/);
  });

  it('strips ANSI and compresses blank lines inside a bubble', () => {
    const bubbles = foldBubbles([
      {
        ts: 0,
        lines: ['\x1b[1mTitle\x1b[0m', '', '', '', 'body'],
      },
      { ts: 5000, lines: ['later'] },
    ]);
    assert.ok(bubbles.length >= 1);
    const text = bubbles[0].text;
    assert.equal(text.includes('\x1b'), false);
    assert.ok(!/\n\n\n/.test(text), 'blank runs should be compressed');
    assert.match(text, /Title/);
    assert.match(text, /body/);
  });

  it('handles long stream as one bubble when under silence threshold', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i} 中文`);
    const events = lines.map((line, i) => ({ ts: 1000 + i * 50, lines: [line] }));
    const bubbles = foldBubbles(events);
    assert.equal(bubbles.length, 1);
    assert.match(bubbles[0].text, /L0/);
    assert.match(bubbles[0].text, /L39/);
    assert.match(bubbles[0].text, /中文/);
  });
});
