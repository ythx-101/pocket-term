/**
 * M2.7-P4 visual consistency + P5 dead-code cleanup assertions.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');

describe('M2.7-P4 visual consistency', () => {
  /** @type {string} */
  let css;
  /** @type {string} */
  let appJs;
  /** @type {string} */
  let spaUtils;

  before(async () => {
    css = await fs.readFile(path.join(pub, 'style.css'), 'utf8');
    appJs = await fs.readFile(path.join(pub, 'app.js'), 'utf8');
    spaUtils = await fs.readFile(path.join(pub, 'spa-utils.js'), 'utf8');
  });

  it('empty chat shows 暂无消息 placeholder', () => {
    assert.match(appJs, /bubble-empty/);
    assert.match(appJs, /暂无消息/);
    assert.match(css, /\.bubble-empty\s*\{/);
  });

  it('primary touch targets are at least 44px; quick keys stay compact', () => {
    for (const sel of [
      '.blocked-confirm-btn',
      '.add-wallpaper-btn',
      '.attach-btn',
      '.push-enable-btn',
    ]) {
      const re = new RegExp(
        `${sel.replace('.', '\\.')}\\s*\\{[^}]*min-height:\\s*44px`,
        's'
      );
      assert.match(css, re, `${sel} must be ≥44px`);
    }
    assert.match(css, /\.hotkey-btn\s*\{[^}]*min-height:\s*28px/s);
    assert.match(css, /\.hotkey-btn[\s\S]*padding:\s*0 0\.4rem/);
  });

  it('wallpaper dim scrim is theme-aware (not always black)', () => {
    assert.match(css, /--dim-rgb/);
    assert.match(css, /#dim\s*\{[^}]*rgba\(var\(--dim-rgb/s);
    assert.match(css, /\[data-theme='light'\][\s\S]*?--dim-rgb:\s*250/);
  });

  it('wallpaper 404 probe clears has-wallpaper and toasts', () => {
    assert.match(appJs, /wallpaperProbeGen|new Image\(\)/);
    assert.match(appJs, /probe\.onerror|img\.onerror|onerror\s*=/);
    assert.match(appJs, /has-wallpaper/);
    assert.match(appJs, /壁纸无法加载|壁纸不可用/);
    assert.match(appJs, /showToast\(/);
  });

  it('send button disabled when empty (no attach)', () => {
    assert.match(appJs, /function updateSendButtonState/);
    assert.match(appJs, /btn\.disabled\s*=\s*empty/);
    assert.match(css, /\.send-btn:disabled/);
  });

  it('colors: no hard-coded #c44; danger/warn vars; done≠idle separation', () => {
    assert.doesNotMatch(css, /#c44\b/i);
    assert.match(css, /attach-preview-remove[\s\S]*?var\(--danger\)/s);
    assert.match(css, /\.conn-led\.warn::after[\s\S]*?var\(--warn\)/s);
    assert.match(css, /\.conn-led\.err::after[\s\S]*?var\(--danger\)/s);
    assert.match(css, /\.unread-dot[\s\S]*?var\(--danger\)/s);
    // Distinct token values for blue vs idle in dark theme block
    assert.match(css, /--blue:\s*#[0-9a-fA-F]{3,8}/);
    assert.match(css, /--idle:\s*#[0-9a-fA-F]{3,8}/);
    // Avatar letter contrast assist
    assert.match(css, /\.avatar\s*\{[^}]*text-shadow/s);
  });

  it('layout: image-viewer above toast; jump-bottom tracks composer; 100vh fallback', () => {
    assert.match(css, /\.image-viewer\s*\{[^}]*z-index:\s*200/s);
    assert.match(css, /\.toast-host\s*\{[^}]*z-index:\s*40/s);
    assert.match(css, /body\.image-viewer-open\s+\.toast-host/);
    assert.match(css, /\.jump-bottom[\s\S]*?--composer-stack-h/s);
    assert.match(appJs, /function updateComposerStackOffset/);
    assert.match(css, /#app\s*\{[^}]*height:\s*100vh/s);
    assert.match(css, /#app\s*\{[^}]*height:\s*100dvh/s);
    // Contacts group-head no double border with rows
    assert.match(css, /\.group-head\s*\{[^}]*border-bottom:\s*none/s);
  });
});

describe('M2.7-P5 dead code cleanup', () => {
  /** @type {string} */
  let appJs;
  /** @type {string} */
  let spaUtils;

  before(async () => {
    appJs = await fs.readFile(path.join(pub, 'app.js'), 'utf8');
    spaUtils = await fs.readFile(path.join(pub, 'spa-utils.js'), 'utf8');
  });

  it('removes M2.6 banner helpers and unused dead exports', () => {
    assert.doesNotMatch(spaUtils, /export function notifyBannerView/);
    assert.doesNotMatch(spaUtils, /export function latestPendingNotification/);
    assert.doesNotMatch(spaUtils, /export function statusDotClass/);
    assert.doesNotMatch(spaUtils, /export function messageHasChatImage/);
    assert.doesNotMatch(appJs, /notifyBannerView/);
    assert.doesNotMatch(appJs, /latestPendingNotification/);
  });

  it('removes empty Enter keydown shell on composer', () => {
    // No keydown handler that only comments about Enter=newline
    assert.doesNotMatch(
      appJs,
      /composerInput\?\.addEventListener\('keydown'/
    );
    assert.doesNotMatch(
      appJs,
      /addEventListener\('keydown',\s*\(ev\)\s*=>\s*\{\s*if\s*\(ev\.key\s*===\s*['"]Enter['"]/
    );
  });
});
