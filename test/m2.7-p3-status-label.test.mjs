/**
 * M2.7-P3: persistent Chinese status text on list left + chat header.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusLabel, statusMeta } from '../public/spa-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');

describe('M2.7-P3 statusLabel pure mapping', () => {
  it('covers idle/working/blocked/done/unknown + fallback', () => {
    assert.deepEqual(
      ['idle', 'working', 'blocked', 'done', 'unknown'].map(statusLabel),
      ['空闲', '工作中', '等你回复', '完成', '未知']
    );
    assert.equal(statusLabel('nope'), '未知');
    assert.equal(statusLabel(null), '未知');
    // statusMeta.label stays in sync with statusLabel
    for (const s of ['idle', 'working', 'blocked', 'done', null]) {
      assert.equal(statusLabel(s), statusMeta(s).label);
    }
  });
});

describe('M2.7-P3 wiring: list left + chat header', () => {
  /** @type {string} */
  let html;
  /** @type {string} */
  let appJs;
  /** @type {string} */
  let css;
  /** @type {string} */
  let spaUtils;

  before(async () => {
    html = await fs.readFile(path.join(pub, 'index.html'), 'utf8');
    appJs = await fs.readFile(path.join(pub, 'app.js'), 'utf8');
    css = await fs.readFile(path.join(pub, 'style.css'), 'utf8');
    spaUtils = await fs.readFile(path.join(pub, 'spa-utils.js'), 'utf8');
  });

  it('keeps the chat-header status label and restores inline Chinese list badges', () => {
    assert.match(spaUtils, /export function statusLabel/);
    assert.match(appJs, /statusLabel/);
    assert.match(appJs, /row-badge/);
    assert.match(appJs, /\[工作中\]/);
    assert.doesNotMatch(appJs, /进行中/);
    assert.match(appJs, /\[等你回复\]/);
    assert.doesNotMatch(appJs, /row-status-label/);
    // List badges are explicit Chinese text; the header still uses statusLabel.
    assert.match(
      appJs,
      /function updateChatHeader[\s\S]*?chat-status-label[\s\S]*?statusLabel\(/
    );
  });

  it('chat header has status label element beside the dot', () => {
    assert.match(html, /id="chat-status-dot"/);
    assert.match(html, /id="chat-status-label"/);
    assert.match(html, /class="chat-status-label/);
    assert.match(appJs, /#chat-status-label/);
    assert.match(
      appJs,
      /function updateChatHeader[\s\S]*?chat-status-label[\s\S]*?statusLabel/
    );
  });

  it('CSS: inline badges and chat-header status remain theme-aware', () => {
    assert.match(css, /\.row-badge\s*\{/);
    assert.match(css, /\.row-badge\.working[\s\S]*?var\(--ok\)/);
    assert.match(css, /\.row-badge\.blocked[\s\S]*?var\(--danger\)/);
    assert.match(css, /\.chat-status-label\s*\{[^}]*font-size:\s*12px/s);
    assert.match(css, /\.chat-status-label\.st-working[\s\S]*?var\(--ok\)/);
    assert.match(css, /\.chat-status-label\.st-blocked[\s\S]*?var\(--danger\)/);
    assert.match(css, /@keyframes status-text-breathe/);
    // blocked left pin still present (M2.6)
    assert.match(css, /\.row\.row-blocked/);
  });
});
