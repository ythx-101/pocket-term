/**
 * Clear Lavender UI clarity contracts: contrast, focus, motion, status semantics,
 * touch targets, safe-area/wallpaper/composer stack preservation.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');

function themeBlock(css, selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `${selector} block exists`);
  const open = css.indexOf('{', start);
  assert.notEqual(open, -1, `${selector} block opens`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  assert.fail(`${selector} block closes`);
}

function varsFrom(block) {
  return Object.fromEntries(
    [...block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|[0-9]+,\s*[0-9]+,\s*[0-9]+|[^;]+);/g)].map(
      ([, key, value]) => [key, value.trim()]
    )
  );
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  assert.equal(clean.length, 6, `expected 6-digit hex, got ${hex}`);
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
}

function linear(channel) {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function assertContrast(token, surface, vars, min = 4.5) {
  const ratio = contrast(vars[token], vars[surface]);
  assert.ok(
    ratio >= min,
    `${token} ${vars[token]} on ${surface} ${vars[surface]} ratio ${ratio.toFixed(2)} < ${min}`
  );
}

describe('Clear Lavender theme contrast and token hierarchy', () => {
  /** @type {string} */
  let css;
  /** @type {Record<string, string>} */
  let dark;
  /** @type {Record<string, string>} */
  let light;

  before(async () => {
    css = await fs.readFile(path.join(pub, 'style.css'), 'utf8');
    dark = varsFrom(themeBlock(css, "[data-theme='dark']"));
    light = varsFrom(themeBlock(css, "[data-theme='light']"));
  });

  it('keeps explicit semantic surface/text/status tokens in both themes', () => {
    for (const vars of [dark, light]) {
      for (const token of [
        '--bg',
        '--bg-elev',
        '--bg-chrome',
        '--bg-chat',
        '--fg',
        '--fg-muted',
        '--border',
        '--divider',
        '--accent',
        '--accent-fg',
        '--danger',
        '--warn',
        '--ok',
        '--blue',
        '--idle',
        '--unknown',
      ]) {
        assert.ok(vars[token], `${token} is defined`);
      }
    }
    assert.match(css, /--blocked-bg:\s*color-mix\(in srgb, var\(--danger\)/);
  });

  it('meets WCAG AA contrast for primary, secondary, and textual status colors', () => {
    for (const vars of [dark, light]) {
      for (const surface of ['--bg', '--bg-elev', '--bg-chrome', '--bg-chat']) {
        for (const token of [
          '--fg',
          '--fg-muted',
          '--danger',
          '--warn',
          '--ok',
          '--blue',
          '--idle',
          '--unknown',
        ]) {
          assertContrast(token, surface, vars, 4.5);
        }
      }
      assertContrast('--accent', '--bg', vars, 4.5);
      assertContrast('--accent', '--bg-elev', vars, 4.5);
      assert.ok(contrast(vars['--accent-fg'], vars['--accent']) >= 4.5);
      assert.ok(contrast(vars['--accent'], vars['--bg']) >= 4.5);
    }
  });
});

describe('Clear Lavender accessibility and mobile behavior contracts', () => {
  /** @type {string} */
  let css;
  /** @type {string} */
  let html;
  /** @type {string} */
  let appJs;

  before(async () => {
    css = await fs.readFile(path.join(pub, 'style.css'), 'utf8');
    html = await fs.readFile(path.join(pub, 'index.html'), 'utf8');
    appJs = await fs.readFile(path.join(pub, 'app.js'), 'utf8');
  });

  it('provides visible keyboard focus and a reduced-motion alternative', () => {
    assert.match(css, /:focus-visible\s*\{/);
    assert.match(css, /outline:\s*2px solid var\(--focus-ring, var\(--accent\)\)/);
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    assert.match(css, /animation:\s*none\s*!important/);
    assert.match(css, /transition:\s*none\s*!important/);
  });

  it('sets browser chrome theme colors to Clear Lavender surfaces', () => {
    assert.match(
      html,
      /<meta name="theme-color" content="#29253a" media="\(prefers-color-scheme: dark\)" \/>/
    );
    assert.match(
      html,
      /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)" \/>/
    );
    assert.match(html, /<meta name="theme-color" content="#29253a" \/>/);
    assert.match(appJs, /chrome\.setAttribute\('content', theme === 'light' \? '#ffffff' : '#29253a'\);/);
    assert.doesNotMatch(html, /#232136|#fffaf3/);
    assert.doesNotMatch(appJs, /#232136|#fffaf3/);
  });

  it('keeps warning banner backgrounds separate from danger blocked bars', () => {
    const dark = varsFrom(themeBlock(css, "[data-theme='dark']"));
    const light = varsFrom(themeBlock(css, "[data-theme='light']"));
    assert.equal(dark['--warning-bg'], 'color-mix(in srgb, var(--warn) 18%, transparent)');
    assert.equal(light['--warning-bg'], 'color-mix(in srgb, var(--warn) 12%, transparent)');
    assert.equal(dark['--blocked-bg'], 'color-mix(in srgb, var(--danger) 18%, transparent)');
    assert.equal(light['--blocked-bg'], 'color-mix(in srgb, var(--danger) 12%, transparent)');
    assert.match(css, /\.banner\s*\{[^}]*background:\s*var\(--warning-bg\);[^}]*color:\s*var\(--warn\);/s);
    assert.match(css, /\.blocked-bar\s*\{[^}]*background:\s*var\(--blocked-bg\);[^}]*color:\s*var\(--danger\);/s);
  });

  it('unifies working/blocked wording and exposes row status names accessibly', () => {
    assert.doesNotMatch(appJs, /进行中/);
    assert.match(appJs, /\[工作中\]/);
    assert.match(appJs, /aria-label[^\n]+状态：/);
    assert.match(appJs, /statusMeta\(p\.agent_status\)/);
    assert.match(css, /\.row-badge\.blocked[\s\S]*?var\(--danger\)/);
    assert.match(css, /\.blocked-bar\s*\{[^}]*color:\s*var\(--danger\)/s);
  });

  it('labels the composer and hides decorative tab emoji from assistive tech', () => {
    assert.match(html, /id="composer"[^>]*aria-label="消息输入区"/);
    assert.match(html, /id="composer-input"[\s\S]*?aria-label="发给 agent"/);
    const tabIcons = [...html.matchAll(/<span class="tab-icon"([^>]*)>/g)];
    assert.equal(tabIcons.length, 3);
    for (const [, attrs] of tabIcons) assert.match(attrs, /aria-hidden="true"/);
  });

  it('keeps primary controls 44px while quick keys are at least 36px and secondary', () => {
    for (const sel of ['.blocked-confirm-btn', '.add-wallpaper-btn', '.attach-btn', '.push-enable-btn']) {
      assert.match(css, new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*min-height:\\s*44px`, 's'));
    }
    assert.match(css, /\.send-btn\s*\{[^}]*min-height:\s*44px/s);
    assert.match(css, /\.tab\s*\{[^}]*min-height:\s*52px/s);
    assert.match(css, /\.hotkey-btn\s*\{[^}]*min-height:\s*36px/s);
    assert.match(css, /\.hotkey-btn\s*\{[^}]*font-size:\s*calc\(var\(--fs-sm\) \* 0\.9\)/s);
  });

  it('preserves safe-area, wallpaper, viewport, and composer-stack contracts', () => {
    assert.match(html, /viewport-fit=cover/);
    assert.match(css, /#app\s*\{[^}]*height:\s*100vh/s);
    assert.match(css, /#app\s*\{[^}]*height:\s*100dvh/s);
    assert.match(css, /safe-area-inset-top/);
    assert.match(css, /safe-area-inset-bottom/);
    assert.match(css, /#dim\s*\{[^}]*rgba\(var\(--dim-rgb/s);
    assert.match(css, /html\.has-wallpaper \.row\s*\{[^}]*var\(--bg-elev\) 90%/s);
    assert.match(css, /\.jump-bottom[\s\S]*?--composer-stack-h/s);
    assert.match(appJs, /function updateComposerStackOffset/);
  });
});
