/**
 * M2.8 Tier B stream-card hierarchy tests.
 * P1: structural spinner matching (no ● false kills; asterisk/✽/✢ must not leak).
 * P2: TUI chrome filtering (footers, hotkey bars, prompt rows).
 * P3: segmentStreamText body/tool segmentation + per-segment rendering.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  isSpinnerLine,
  isChromeLine,
  cleanStreamLines,
  diffNewText,
  segmentStreamText,
} from '../lib/bubbles.js';
import { createStateManager } from '../lib/state-manager.js';
import { mapBubbleToView } from '../public/spa-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');

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
    '  ⎿  $ git -C /home/user/project log --oneline -1',
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
      '  ⎿  $ git -C /home/user/project log --oneline -1',
      '* Levitating… (1m 34s · ↓ 3.2k tokens)',
    ]);
    assert.deepEqual(out, [
      '● grok 还在 working（4分29秒，改了 3 个文件但还没到 commit）。',
      '  ⎿  $ git -C /home/user/project log --oneline -1',
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
    'Sonnet 4.5 · /home/user/project · ⎇ m2.8-stream-hierarchy · +12/-3',
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
    '  ⎿  $ git -C /home/user/project log --oneline -1',
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

describe('M2.8-P3 segmentStreamText (pure)', () => {
  it('● starts a new body segment; ⎿ rows form a tool sub-segment', () => {
    const text = [
      '● 要点一：先跑测试',
      '  ⎿  $ git -C /home/user/project log --oneline -1',
      '● 要点二：再提交',
    ].join('\n');
    assert.deepEqual(segmentStreamText(text), [
      { type: 'body', text: '● 要点一：先跑测试' },
      { type: 'tool', text: '  ⎿  $ git -C /home/user/project log --oneline -1' },
      { type: 'body', text: '● 要点二：再提交' },
    ]);
  });

  it('2-space hanging indent continues the current body segment (Claude wrap)', () => {
    const text = ['● 一段很长的正文', '  换行后带两空格悬挂缩进', '  还是正文'].join('\n');
    assert.deepEqual(segmentStreamText(text), [
      { type: 'body', text: '● 一段很长的正文\n  换行后带两空格悬挂缩进\n  还是正文' },
    ]);
  });

  it('deep indent (≥3 spaces) after body starts a tool sub-segment', () => {
    const text = ['● 跑了一个命令', '     total 12', '     drwxr-xr-x  4096 .'].join('\n');
    assert.deepEqual(segmentStreamText(text), [
      { type: 'body', text: '● 跑了一个命令' },
      { type: 'tool', text: '     total 12\n     drwxr-xr-x  4096 .' },
    ]);
  });

  it('consecutive tool rows (⎿ then indented output) merge into one tool segment', () => {
    const text = [
      '● Ran a command',
      '  ⎿  $ node --test',
      '     pass 262',
      '     fail 0',
    ].join('\n');
    assert.deepEqual(segmentStreamText(text), [
      { type: 'body', text: '● Ran a command' },
      { type: 'tool', text: '  ⎿  $ node --test\n     pass 262\n     fail 0' },
    ]);
  });

  it('◆/◈ and indented L rows start tool segments', () => {
    assert.deepEqual(segmentStreamText('◆ tool call\n● body'), [
      { type: 'tool', text: '◆ tool call' },
      { type: 'body', text: '● body' },
    ]);
    assert.deepEqual(segmentStreamText('● body\n  L ran ls -la'), [
      { type: 'body', text: '● body' },
      { type: 'tool', text: '  L ran ls -la' },
    ]);
  });

  it('plain text without markers is a single body segment', () => {
    assert.deepEqual(segmentStreamText('第一行\n第二行'), [
      { type: 'body', text: '第一行\n第二行' },
    ]);
  });

  it('unindented continuation stays in the current segment', () => {
    assert.deepEqual(segmentStreamText('● 要点\n继续正文没有缩进'), [
      { type: 'body', text: '● 要点\n继续正文没有缩进' },
    ]);
  });

  it('blank lines are kept inside a segment but trimmed at edges', () => {
    assert.deepEqual(segmentStreamText('\n● 段落一\n\n段落二\n'), [
      { type: 'body', text: '● 段落一\n\n段落二' },
    ]);
  });

  it('empty / whitespace-only input yields no segments', () => {
    assert.deepEqual(segmentStreamText(''), []);
    assert.deepEqual(segmentStreamText('  \n \n'), []);
    assert.deepEqual(segmentStreamText(null), []);
  });
});

describe('M2.8-P3 stream bubbles carry segments end-to-end', () => {
  it('sealed Tier B stream bubble includes segments; getMessages passes them through', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-m28-p3-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);
    const client = {
      rpc: async () => ({ read: { text: '' } }),
      subscribe: () => ({ dead: false, close() {} }),
    };
    const mgr = createStateManager({ client, stateDir, allowedRoot: tmp });
    try {
      const paneId = 'w9:p9';
      mgr._internal.appendTierBLines(
        paneId,
        [
          '● 修复完成，测试全绿。',
          '  ⎿  $ node --test test/all.test.mjs',
          '     pass 262',
        ],
        1000
      );
      mgr._internal.sealOpen(paneId);
      const rt = mgr._internal.ensureRuntime(paneId);
      const streamBubbles = rt.buffer.filter((b) => b.stream === true);
      assert.equal(streamBubbles.length, 1);
      assert.deepEqual(streamBubbles[0].segments, [
        { type: 'body', text: '● 修复完成，测试全绿。' },
        { type: 'tool', text: '  ⎿  $ node --test test/all.test.mjs\n     pass 262' },
      ]);

      const msgs = await mgr.getMessages(paneId);
      const streamMsgs = msgs.filter((m) => m.stream === true);
      assert.equal(streamMsgs.length, 1);
      assert.deepEqual(streamMsgs[0].segments, streamBubbles[0].segments);
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('draft (unsealed) Tier B bubble from getMessages also carries segments', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-m28-p3b-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);
    const client = {
      rpc: async () => ({ read: { text: '' } }),
      subscribe: () => ({ dead: false, close() {} }),
    };
    const mgr = createStateManager({ client, stateDir, allowedRoot: tmp });
    try {
      const paneId = 'w9:p10';
      mgr._internal.appendTierBLines(paneId, ['● 正在写代码', '  ⎿  Edit lib/x.js'], Date.now());
      const msgs = await mgr.getMessages(paneId);
      const draft = msgs.find((m) => m.sealed === false);
      assert.ok(draft, 'expected a draft bubble');
      assert.deepEqual(draft.segments, [
        { type: 'body', text: '● 正在写代码' },
        { type: 'tool', text: '  ⎿  Edit lib/x.js' },
      ]);
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('non-stream bubbles (Tier A / user) carry no segments', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-m28-p3c-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);
    const client = {
      rpc: async () => ({ read: { text: '' } }),
      subscribe: () => ({ dead: false, close() {} }),
    };
    const mgr = createStateManager({ client, stateDir, allowedRoot: tmp });
    try {
      const paneId = 'w9:p11';
      mgr._internal.pushBubble(paneId, { ts: 1, text: '● looks like a bullet', role: 'agent' });
      const rt = mgr._internal.ensureRuntime(paneId);
      assert.equal(rt.buffer[0].segments, undefined);
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('M2.8-P3 per-segment rendering (view model + DOM smoke)', () => {
  it('mapBubbleToView passes segments through for stream bubbles only', () => {
    const segs = [
      { type: 'body', text: '● 要点' },
      { type: 'tool', text: '  ⎿  cmd' },
    ];
    const vm = mapBubbleToView({
      id: 'x', ts: 1, role: 'agent', stream: true, text: '● 要点\n  ⎿  cmd', segments: segs,
    });
    assert.equal(vm.variant, 'stream');
    assert.deepEqual(vm.segments, segs);

    const vmNoSeg = mapBubbleToView({ id: 'y', ts: 1, role: 'agent', stream: true, text: 'x' });
    assert.equal(vmNoSeg.segments, null);

    const vmAgent = mapBubbleToView({ id: 'z', ts: 1, role: 'agent', text: 'hi', segments: segs });
    assert.equal(vmAgent.variant, 'agent');
    assert.equal(vmAgent.segments, null);
  });

  it('mapBubbleToView drops malformed segment entries', () => {
    const vm = mapBubbleToView({
      id: 'x', ts: 1, role: 'agent', stream: true, text: 't',
      segments: [{ type: 'body', text: 'ok' }, { type: 'weird', text: 'no' }, 'junk', { type: 'tool' }],
    });
    assert.deepEqual(vm.segments, [{ type: 'body', text: 'ok' }]);
  });

  it('app.js renders stream cards per segment; style.css has theme-aware seg styles', async () => {
    const appJs = await fs.readFile(path.join(pub, 'app.js'), 'utf8');
    const css = await fs.readFile(path.join(pub, 'style.css'), 'utf8');
    // per-segment DOM
    assert.match(appJs, /stream-seg/);
    assert.match(appJs, /seg-body/);
    assert.match(appJs, /seg-tool/);
    assert.match(appJs, /vm\.segments|\.segments/);
    // tool sub-segment: smaller, dimmed, left rule; body keeps pre-wrap
    assert.match(css, /\.stream-seg\s*\{[^}]*white-space:\s*pre-wrap/s);
    assert.match(css, /\.seg-tool\s*\{[^}]*border-left/s);
    assert.match(css, /\.seg-tool\s*\{[^}]*var\(--/s);
    assert.match(css, /\.seg-tool\s*\{[^}]*font-size/s);
  });
});

describe('M2.8-P4 latestSpinnerLine (pure)', () => {
  it('finds the newest spinner line even when chrome rows follow it', async () => {
    const { latestSpinnerLine } = await import('../lib/bubbles.js');
    const screen = [
      '● 正在修改 lib/bubbles.js',
      '* Levitating… (1m 34s · ↓ 3.2k tokens)',
      '❯',
      '  Opus 4.8 · pocket-term-2 · ⎇ master* · +961/-87',
    ].join('\n');
    assert.equal(
      latestSpinnerLine(screen),
      '* Levitating… (1m 34s · ↓ 3.2k tokens)'
    );
  });

  it('collapses runs of whitespace and drops [stop] / esc-to-interrupt chrome', async () => {
    const { latestSpinnerLine } = await import('../lib/bubbles.js');
    assert.equal(
      latestSpinnerLine('⠹ Thinking… 12s                6m7s ⇣80.2k [stop]'),
      '⠹ Thinking… 12s 6m7s ⇣80.2k'
    );
    assert.equal(
      latestSpinnerLine('✹ Working… (esc to interrupt)'),
      '✹ Working…'
    );
  });

  it('returns null when no spinner line exists', async () => {
    const { latestSpinnerLine } = await import('../lib/bubbles.js');
    assert.equal(latestSpinnerLine('● 全部完成\n  ⎿  done'), null);
    assert.equal(latestSpinnerLine(''), null);
    assert.equal(latestSpinnerLine(null), null);
  });
});

describe('M2.8-P4 typing indicator over SSE (bridge)', () => {
  /** Build a manager with a controllable screen + captured SSE writes. */
  async function makeTypingHarness() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-m28-p4-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);
    const screen = { text: '' };
    const client = {
      rpc: async (method) => {
        if (method === 'pane.read') return { read: { text: screen.text } };
        throw new Error(`unexpected ${method}`);
      },
      subscribe: () => ({ dead: false, close() {} }),
    };
    const mgr = createStateManager({ client, stateDir, allowedRoot: tmp });
    /** @type {string[]} */
    const written = [];
    mgr.addSseClient({ write: (s) => written.push(String(s)) });
    const typingEvents = () =>
      written
        .filter((w) => w.startsWith('event: typing\n'))
        .map((w) => JSON.parse(w.split('\ndata: ')[1]));
    return {
      mgr,
      screen,
      typingEvents,
      cleanup: async () => {
        await mgr.stop();
        await fs.rm(tmp, { recursive: true, force: true });
      },
    };
  }

  it('spinner text goes to a typing event, not into buffer/history', async () => {
    const h = await makeTypingHarness();
    try {
      const paneId = 'w9:p8';
      const rt = h.mgr._internal.ensureRuntime(paneId);
      h.mgr._internal.onStatus(paneId, 'working');
      h.screen.text = '● 正在修改文件\n* Levitating… (5s · ↓ 861 tokens)\n';
      rt.prevText = '';
      await h.mgr._internal.ingestPaneOutput(paneId);

      const evs = h.typingEvents();
      assert.equal(evs.length, 1);
      assert.equal(evs[0].pane_id, paneId);
      assert.equal(evs[0].text, '* Levitating… (5s · ↓ 861 tokens)');

      // spinner never lands in sealed bubbles / history
      h.mgr._internal.sealOpen(paneId);
      const msgs = await h.mgr.getMessages(paneId);
      for (const m of msgs) {
        assert.ok(!/Levitating/.test(m.text || ''), 'spinner leaked into history');
      }
    } finally {
      await h.cleanup();
    }
  });

  it('updates in place on change, stays silent when unchanged', async () => {
    const h = await makeTypingHarness();
    try {
      const paneId = 'w9:p8';
      const rt = h.mgr._internal.ensureRuntime(paneId);
      h.mgr._internal.onStatus(paneId, 'working');
      h.screen.text = '* Levitating… (5s · ↓ 861 tokens)\n';
      rt.prevText = '';
      await h.mgr._internal.ingestPaneOutput(paneId);
      await h.mgr._internal.ingestPaneOutput(paneId); // unchanged frame
      assert.equal(h.typingEvents().length, 1, 'no duplicate for unchanged spinner');

      h.screen.text = '* Levitating… (7s · ↓ 900 tokens)\n';
      await h.mgr._internal.ingestPaneOutput(paneId);
      const evs = h.typingEvents();
      assert.equal(evs.length, 2);
      assert.equal(evs[1].text, '* Levitating… (7s · ↓ 900 tokens)');
    } finally {
      await h.cleanup();
    }
  });

  it('clears on working → idle/done', async () => {
    const h = await makeTypingHarness();
    try {
      const paneId = 'w9:p8';
      const rt = h.mgr._internal.ensureRuntime(paneId);
      h.mgr._internal.onStatus(paneId, 'working');
      h.screen.text = '✻ Cogitating… (31s · ↓ 1.2k tokens)\n';
      rt.prevText = '';
      await h.mgr._internal.ingestPaneOutput(paneId);
      assert.equal(h.typingEvents().length, 1);

      h.mgr._internal.onStatus(paneId, 'idle');
      const evs = h.typingEvents();
      assert.equal(evs.length, 2);
      assert.equal(evs[1].text, null);
    } finally {
      await h.cleanup();
    }
  });

  it('does not emit typing while status is not working (stale completion notes)', async () => {
    const h = await makeTypingHarness();
    try {
      const paneId = 'w9:p8';
      const rt = h.mgr._internal.ensureRuntime(paneId);
      h.mgr._internal.onStatus(paneId, 'idle');
      h.screen.text = '✻ Crunched for 2m 41s\n';
      rt.prevText = '';
      await h.mgr._internal.ingestPaneOutput(paneId);
      assert.equal(h.typingEvents().length, 0);
    } finally {
      await h.cleanup();
    }
  });
});

describe('M2.8-P4 typing indicator (front-end smoke)', () => {
  it('SPA listens for typing events and renders the in-place status line', async () => {
    const appJs = await fs.readFile(path.join(pub, 'app.js'), 'utf8');
    const html = await fs.readFile(path.join(pub, 'index.html'), 'utf8');
    const css = await fs.readFile(path.join(pub, 'style.css'), 'utf8');
    assert.match(appJs, /addEventListener\('typing'/);
    assert.match(appJs, /typing-line|typingByPane/);
    assert.match(html, /id="typing-line"/);
    assert.match(css, /\.typing-line\s*\{[^}]*var\(--/s);
  });
});

describe('M2.8-fix1 review counter-examples: ASCII bullets are body, not spinner', () => {
  const bodies = [
    '* Tests pass…',
    '· Build took 12s',
    '* Completed in 12s',
    '* Worked for 2m 41s',
    '· waited for 3s then retried',
    '*',
    '·',
  ];
  for (const line of bodies) {
    it(`keeps: ${JSON.stringify(line)}`, () => {
      assert.equal(isSpinnerLine(line), false);
    });
  }

  it('ASCII bullets still filtered with the full timing/token annotation', () => {
    assert.equal(isSpinnerLine('* Levitating… (1m 34s · ↓ 3.2k tokens)'), true);
    assert.equal(isSpinnerLine('· Levitating… (5s · ↓ 861 tokens)'), true);
    assert.equal(isSpinnerLine('* Flibbertigibbeting… (12s)'), true);
  });

  it('non-ASCII rotation glyphs keep the wider heuristic', () => {
    assert.equal(isSpinnerLine('✻ Crunched for 2m 41s'), true);
    assert.equal(isSpinnerLine('✻ Cogitated for 31s · 1 shell still running'), true);
    assert.equal(isSpinnerLine('✻ Thinking…'), true);
    assert.equal(isSpinnerLine('✻'), true);
    assert.equal(isSpinnerLine('⠹ Thinking… 12s                6m7s ⇣80.2k [stop]'), true);
  });

  it('ASCII-punctuation body variant of the ● line is kept end-to-end', () => {
    const line = '● grok 还在 working(4分29秒,改了 3 个文件但还没到 commit)。';
    assert.equal(isSpinnerLine(line), false);
    assert.equal(isChromeLine(line), false);
    assert.deepEqual(cleanStreamLines([line]), [line]);
  });
});

describe('M2.8-fix1 review counter-examples: chrome must not eat code/prose', () => {
  const bodies = [
    'build output · ⎇ branch metadata',
    'console.log("Shift+Tab:mode │ Ctrl+c:cancel")',
    'echo hello [stop]',
    'git commit -m "done [stop]"',
    '❯ run 12s [stop]',
    'Shift+Tab:mode is the toggle we ship',
  ];
  for (const line of bodies) {
    it(`keeps: ${JSON.stringify(line)}`, () => {
      assert.equal(isChromeLine(line), false);
    });
  }

  it('real chrome rows still all filtered', () => {
    assert.equal(isChromeLine('  Opus 4.8 · pocket-term-2 · ⎇ master* · +961/-87'), true);
    assert.equal(isChromeLine('Sonnet 4.5 · /home/user/project · ⎇ m2.8-stream-hierarchy · +12/-3'), true);
    assert.equal(isChromeLine('pocket-term-2 · ⎇ master* · +961/-87'), true);
    assert.equal(isChromeLine('  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts'), true);
    assert.equal(isChromeLine('Shift+Tab:mode │ Ctrl+c:cancel'), true);
    assert.equal(isChromeLine('6m7s ⇣80.2k [stop]'), true);
    assert.equal(isChromeLine('12s [stop]'), true);
  });
});

describe('M2.8-fix1 SSE reconnect: no typing replay for new clients', () => {
  it('a fresh SSE client receives state + heartbeat only — never a typing event', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-fix1-sse-'));
    const stateDir = path.join(tmp, 'state');
    await fs.mkdir(stateDir);
    const screen = { text: '' };
    const client = {
      rpc: async (method) => {
        if (method === 'pane.read') return { read: { text: screen.text } };
        throw new Error(`unexpected ${method}`);
      },
      subscribe: () => ({ dead: false, close() {} }),
    };
    const mgr = createStateManager({ client, stateDir, allowedRoot: tmp });
    try {
      const paneId = 'w9:p8';
      const rt = mgr._internal.ensureRuntime(paneId);
      mgr._internal.onStatus(paneId, 'working');
      screen.text = '✻ Cogitating… (31s · ↓ 1.2k tokens)\n';
      rt.prevText = '';
      // Typing indicator is live before the second client connects.
      await mgr._internal.ingestPaneOutput(paneId);
      assert.equal(rt.lastTypingText, '✻ Cogitating… (31s · ↓ 1.2k tokens)');

      /** @type {string[]} */
      const written = [];
      mgr.addSseClient({ write: (s) => written.push(String(s)) });
      assert.ok(
        written.some((w) => w.startsWith('event: state\n')),
        'initial state event expected'
      );
      assert.ok(
        written.some((w) => w.startsWith(':')),
        'heartbeat comment expected'
      );
      assert.ok(
        !written.some((w) => w.startsWith('event: typing')),
        'typing must not be replayed to fresh connections'
      );
    } finally {
      await mgr.stop();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('M2.8-fix2 model footer: whole-row structural match', () => {
  const bodies = [
    'Release 2.0 notes · ⎇ feature/login metadata',
    'build output · ⎇ branch metadata · +12/-3',
    'Release 2.0 notes · repo · ⎇ feature/login metadata · +1/-2',
    'the branch ⎇ master is ahead · rebase first · then push',
  ];
  for (const line of bodies) {
    it(`keeps: ${JSON.stringify(line)}`, () => {
      assert.equal(isChromeLine(line), false);
    });
  }

  it('real footers still filtered (structural: model/repo/⎇ single-token/diffstat)', () => {
    assert.equal(isChromeLine('  Opus 4.8 · pocket-term-2 · ⎇ master* · +961/-87'), true);
    assert.equal(isChromeLine('Sonnet 4.5 · /home/user/project · ⎇ m2.8-stream-hierarchy · +12/-3'), true);
    assert.equal(isChromeLine('pocket-term-2 · ⎇ master* · +961/-87'), true);
    assert.equal(isChromeLine('Opus 4.8 · pocket-term-2 · ⎇ master*'), true);
  });
});
