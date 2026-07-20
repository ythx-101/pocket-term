/**
 * M2.8 Tier B stream-card hierarchy tests.
 * P1: structural spinner matching (no ● false kills; asterisk/✽/✢ must not leak).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSpinnerLine,
  isChromeLine,
  cleanStreamLines,
  diffNewText,
} from '../lib/bubbles.js';

describe('M2.8-P1 spinner: real-world lines that MUST be filtered', () => {
  const spinners = [
    '* Levitating… (1m 34s · ↓ 3.2k tokens)',
    '· Levitating… (5s · ↓ 861 tokens)',
    '✻ Crunched for 2m 41s',
    '✻ Cogitated for 31s · 1 shell still running',
    '⠹ Thinking… 12s                6m7s ⇣80.2k [stop]',
    '✽ Simmering… (2s · ↑ 120 tokens)',
    '✢ Pondering…',
    '✹ Working… (esc to interrupt)',
    '✻ Worked for 5m 2s',
    '  * Levitating… (1m 34s · ↓ 3.2k tokens)',
  ];
  for (const line of spinners) {
    it(`filters: ${JSON.stringify(line)}`, () => {
      assert.equal(isSpinnerLine(line), true);
    });
  }

  it('rotation glyph churn does not produce new cards (full-redraw diff)', () => {
    const body = ['● 已完成三个文件的修改', '  ⎿  test/all.test.mjs'];
    const prev = [...body, '* Levitating… (1m 30s · ↓ 3.1k tokens)'].join('\n') + '\n';
    const next = [...body, '✽ Levitating… (1m 32s · ↓ 3.2k tokens)'].join('\n') + '\n';
    assert.deepEqual(diffNewText(prev, next), []);
  });
});

describe('M2.8-P1 spinner: body lines that MUST be kept', () => {
  const bodies = [
    '● grok 还在 working（4分29秒，改了 3 个文件但还没到 commit）。',
    '  ⎿  $ git -C /root/pocket-term-2 log --oneline -1',
    '● Done. All tests pass.',
    '● 修复完成',
    '* fixed the parser bug in lib/bubbles.js',
    '* done',
    '· 要点：先跑测试再提交',
    '最终摘要：完成',
    '███░░░ 60%',
    'plain output',
  ];
  for (const line of bodies) {
    it(`keeps: ${JSON.stringify(line)}`, () => {
      assert.equal(isSpinnerLine(line), false);
    });
  }

  it('cleanStreamLines keeps ● body rows and tool sub-rows, drops spinners', () => {
    const out = cleanStreamLines([
      '● grok 还在 working（4分29秒，改了 3 个文件但还没到 commit）。',
      '  ⎿  $ git -C /root/pocket-term-2 log --oneline -1',
      '* Levitating… (1m 34s · ↓ 3.2k tokens)',
    ]);
    assert.deepEqual(out, [
      '● grok 还在 working（4分29秒，改了 3 个文件但还没到 commit）。',
      '  ⎿  $ git -C /root/pocket-term-2 log --oneline -1',
    ]);
  });

  it('legacy glyph set still recognized (regression)', () => {
    assert.equal(isSpinnerLine('✻ Thinking…'), true);
    assert.equal(isSpinnerLine('  ✶ Working…'), true);
    assert.equal(isSpinnerLine('⠋ running'), true);
    assert.equal(isSpinnerLine('✳ Crunching…'), true);
    assert.equal(isSpinnerLine('✦ Finishing…'), true);
  });
});

describe('M2.8-P2 chrome: TUI footer/hotkey lines that MUST be filtered', () => {
  const chrome = [
    '  Opus 4.8 · pocket-term-2 · ⎇ master* · +961/-87',
    'Sonnet 4.5 · /root/pocket-term-2 · ⎇ m2.8-stream-hierarchy · +12/-3',
    '  ⏵⏵ auto mode on · 1 shell · ← for agents',
    '⏵⏵ accept edits on (shift+tab to cycle)',
    '❯',
    '  ❯  ',
    '  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts',
    'Shift+Tab:mode │ Ctrl+c:cancel',
    'Allowed by auto mode classifier',
    '  esc to interrupt',
    '(esc to interrupt)',
    '6m7s ⇣80.2k [stop]',
    '12s [stop]',
  ];
  for (const line of chrome) {
    it(`filters: ${JSON.stringify(line)}`, () => {
      assert.equal(isChromeLine(line), true);
    });
  }
});

describe('M2.8-P2 chrome: content lines that MUST be kept', () => {
  const bodies = [
    '● grok 还在 working（4分29秒，改了 3 个文件但还没到 commit）。',
    '  ⎿  $ git -C /root/pocket-term-2 log --oneline -1',
    '❯ git status',
    'git checkout master · then rebase',
    '说明：mode 字段的取值是 a · b · c 三种',
    'stop the service before deploying',
    '进度 12s 内完成',
    'plain output',
  ];
  for (const line of bodies) {
    it(`keeps: ${JSON.stringify(line)}`, () => {
      assert.equal(isChromeLine(line), false);
    });
  }

  it('cleanStreamLines drops chrome rows', () => {
    const out = cleanStreamLines([
      '● 修好了，测试全绿。',
      '  Opus 4.8 · pocket-term-2 · ⎇ master* · +961/-87',
      '  ⏵⏵ auto mode on · 1 shell · ← for agents',
      '❯',
      '  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts',
      'Allowed by auto mode classifier',
    ]);
    assert.deepEqual(out, ['● 修好了，测试全绿。']);
  });

  it('full-redraw diff treats chrome churn as noise (no new cards)', () => {
    const body = ['● 正文要点'];
    const prev =
      [...body, '  Opus 4.8 · pocket-term-2 · ⎇ master* · +961/-87'].join('\n') + '\n';
    const next =
      [...body, '  Opus 4.8 · pocket-term-2 · ⎇ master* · +963/-90'].join('\n') + '\n';
    assert.deepEqual(diffNewText(prev, next), []);
  });
});
