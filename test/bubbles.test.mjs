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
  isDecorativeLine,
  isSpinnerLine,
  stripFrameBorders,
  cleanStreamLines,
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

  it('full redraw: emits all truly new content lines', () => {
    const prev = 'old1\nold2\n';
    const next = 'new1\nnew2\nnew3\n';
    assert.deepEqual(diffNewText(prev, next), ['new1', 'new2', 'new3']);
  });

  it('full redraw: same body + spinner/frame churn → empty (no dump)', () => {
    const body = [
      '╭──────────────────╮',
      '│ 最终摘要：完成     │',
      '│ done with task   │',
      '╰──────────────────╯',
    ];
    const prev = [...body, '✻ Thinking…'].join('\n') + '\n';
    const next = [...body, '✶ Working…'].join('\n') + '\n';
    assert.deepEqual(diffNewText(prev, next), []);
  });

  it('full redraw: drops decorative/spinner; keeps only new content', () => {
    const prev = ['────────', 'old line', '✻ Thinking…'].join('\n') + '\n';
    const next =
      ['────────', 'old line', '新内容行', '✶ Working…'].join('\n') + '\n';
    assert.deepEqual(diffNewText(prev, next), ['新内容行']);
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

describe('review fixes: OSC ST termination + indented frames', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);

  it('stripAnsi removes ST-terminated OSC (ESC \\) without leaking bytes', () => {
    const raw = `${ESC}]0;window title${ESC}\\after`;
    const out = stripAnsi(raw);
    assert.equal(out, 'after');
    assert.equal(/[\u0000-\u0008\u000b-\u001f]/.test(out), false);
  });

  it('stripAnsi still removes BEL-terminated OSC', () => {
    assert.equal(stripAnsi(`${ESC}]2;title${BEL}kept`), 'kept');
  });

  it('stripAnsi drops unterminated OSC fragment without control bytes', () => {
    const out = stripAnsi(`${ESC}]0;partial title slice`);
    assert.equal(/[\u0000-\u0008\u000b-\u001f]/.test(out), false);
    assert.equal(out.includes('partial title'), false);
  });

  it('stripAnsi: ST-terminated OSC followed by CSI color', () => {
    const raw = `${ESC}]0;t${ESC}\\${ESC}[32mok${ESC}[0m`;
    assert.equal(stripAnsi(raw), 'ok');
  });

  it('cleanStreamLines: indented CJK frame lines lose frame, keep text', () => {
    assert.deepEqual(cleanStreamLines(['  │ 中文内容 │']), ['中文内容']);
    assert.deepEqual(
      cleanStreamLines(['  ╭──────╮', '  │ 你好 │', '  ╰──────╯']),
      ['你好']
    );
  });

  it('stripFrameBorders: indentation before a border is frame padding', () => {
    assert.equal(stripFrameBorders('  │ 中文内容 │'), '中文内容');
    assert.equal(stripFrameBorders('  │ a │ b │'), 'a │ b');
    // borderless indented lines keep their indentation (code blocks)
    assert.equal(stripFrameBorders('    code line'), '    code line');
  });
});

describe('spinner lines (Tier B redraw noise)', () => {
  it('isSpinnerLine: Claude Code / braille glyphs', () => {
    assert.equal(isSpinnerLine('✻ Thinking…'), true);
    assert.equal(isSpinnerLine('  ✶ Working…'), true);
    assert.equal(isSpinnerLine('⠋ running'), true);
    assert.equal(isSpinnerLine('最终摘要：完成'), false);
    assert.equal(isSpinnerLine('███░░░ 60%'), false);
    assert.equal(isSpinnerLine('plain output'), false);
  });

  it('cleanStreamLines drops spinner rows (blank-compressed like frames)', () => {
    // Spinner → empty slot; compressBlankLines keeps a single blank between body.
    assert.deepEqual(
      cleanStreamLines(['body line', '✻ Thinking…', 'after']),
      ['body line', '', 'after']
    );
    assert.deepEqual(cleanStreamLines(['✻ Thinking…', '✶ Working…']), []);
  });
});

describe('frame / decorative-line cleaning (Tier B display)', () => {
  it('isDecorativeLine: pure box-drawing lines only', () => {
    assert.equal(isDecorativeLine('────────────'), true);
    assert.equal(isDecorativeLine('╭──────────╮'), true);
    assert.equal(isDecorativeLine('╰──────────╯'), true);
    assert.equal(isDecorativeLine('├─────┼────┤'), true);
    assert.equal(isDecorativeLine('║  ═══  ║'), true);
    assert.equal(isDecorativeLine('  │  '), true);
    // Not decorative: blanks, text, CJK, block-element progress bars
    assert.equal(isDecorativeLine(''), false);
    assert.equal(isDecorativeLine('   '), false);
    assert.equal(isDecorativeLine('── Title ──'), false);
    assert.equal(isDecorativeLine('一二三'), false);
    assert.equal(isDecorativeLine('███░░░ 60%'), false);
  });

  it('stripFrameBorders: peels side borders, keeps interior table separators', () => {
    assert.equal(stripFrameBorders('│ hello world │'), 'hello world');
    assert.equal(stripFrameBorders('│ name │ count │'), 'name │ count');
    assert.equal(stripFrameBorders('║ boxed ║'), 'boxed');
    assert.equal(stripFrameBorders('plain text'), 'plain text');
    assert.equal(stripFrameBorders('── Title ──'), '── Title ──');
    assert.equal(stripFrameBorders('│ 你好，世界 │'), '你好，世界');
    // trailing pad spaces trimmed
    assert.equal(stripFrameBorders('padded   '), 'padded');
  });

  it('cleanStreamLines: framed panel → readable text', () => {
    const out = cleanStreamLines([
      '╭──────────────────╮',
      '│ pocket-term-2    │',
      '│ 状态：正常        │',
      '╰──────────────────╯',
    ]);
    assert.deepEqual(out, ['pocket-term-2', '状态：正常']);
  });

  it('cleanStreamLines: preserves mixed content, meaningful tables, ANSI stripped', () => {
    const out = cleanStreamLines([
      '\x1b[1m── 结果 ──\x1b[0m',
      '│ file.js │ \x1b[32mok\x1b[0m │',
      '├─────────┼────┤',
      '│ next.js │ ok │',
      'normal tail line',
    ]);
    assert.deepEqual(out, [
      '── 结果 ──',
      'file.js │ ok',
      '',
      'next.js │ ok',
      'normal tail line',
    ]);
    assert.equal(out.join('\n').includes('\x1b'), false);
  });

  it('cleanStreamLines: decorative runs collapse with blank compression', () => {
    const out = cleanStreamLines(['a', '────', '────', '', 'b']);
    assert.deepEqual(out, ['a', '', 'b']);
  });

  it('foldBubbles drops frame lines from sealed bubble text', () => {
    const bubbles = foldBubbles([
      {
        ts: 0,
        lines: [
          '╭────────────╮',
          '│ 正文内容    │',
          '╰────────────╯',
          '────────────',
          'after frame',
        ],
      },
    ]);
    assert.equal(bubbles.length, 1);
    const text = bubbles[0].text;
    assert.equal(/[╭╮╰╯]/.test(text), false, 'no corner chars remain');
    assert.equal(/^─+$/m.test(text), false, 'no pure separator lines remain');
    assert.match(text, /正文内容/);
    assert.match(text, /after frame/);
  });

  it('foldBubbles yields no bubble for pure decorative noise', () => {
    const bubbles = foldBubbles([
      { ts: 0, lines: ['────────', '╭──╮', '│  │', '╰──╯'] },
    ]);
    assert.equal(bubbles.length, 0);
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
