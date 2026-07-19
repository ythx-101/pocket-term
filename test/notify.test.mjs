/**
 * M2.5 in-app notification helpers — pure, deterministic (injected clock).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTIFY_STATUSES,
  NOTIFY_DEBOUNCE_MS,
  initialNotifyState,
  reduceNotifications,
  consumePaneNotifications,
  pendingNotifyCount,
  latestPendingNotification,
  formatNotifyBadge,
  notifyBannerView,
  parseNotifyToggle,
} from '../public/spa-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const T0 = Date.parse('2026-07-19T12:00:00.000Z');

function pane(paneId, status, extra = {}) {
  return { pane_id: paneId, agent_status: status, ...extra };
}

describe('notify: baseline suppression', () => {
  it('first snapshot records statuses without emitting', () => {
    const r = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'done'), pane('w9:p3', 'idle')],
      {},
      T0
    );
    assert.deepEqual(r.emitted, []);
    assert.equal(r.state.baselined, true);
    assert.deepEqual(r.state.pending, []);
    assert.deepEqual(r.state.statuses, {
      'w9:p1': 'blocked',
      'w9:p2': 'done',
      'w9:p3': 'idle',
    });
  });

  it('unchanged blocked/done after baseline never re-emits (reconnect refetch)', () => {
    const base = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'blocked')],
      {},
      T0
    ).state;
    // Same snapshot again (e.g. SSE reconnect full refetch)
    const r = reduceNotifications(base, [pane('w9:p1', 'blocked')], {}, T0 + 5000);
    assert.deepEqual(r.emitted, []);
    assert.deepEqual(r.state.pending, []);
  });

  it('null/garbage prev state falls back to a fresh baseline', () => {
    const r = reduceNotifications(null, [pane('w9:p1', 'blocked')], {}, T0);
    assert.deepEqual(r.emitted, []);
    assert.equal(r.state.baselined, true);
  });
});

describe('notify: edge detection', () => {
  const base = reduceNotifications(
    initialNotifyState(),
    [pane('w9:p1', 'working'), pane('w9:p2', 'working')],
    {},
    T0
  ).state;

  it('working→blocked and working→done emit', () => {
    const r = reduceNotifications(
      base,
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'done')],
      {},
      T0 + 1000
    );
    assert.deepEqual(r.emitted, [
      { paneId: 'w9:p1', status: 'blocked', at: T0 + 1000 },
      { paneId: 'w9:p2', status: 'done', at: T0 + 1000 },
    ]);
    assert.equal(r.state.pending.length, 2);
  });

  it('working→idle and idle→working do not emit', () => {
    const r = reduceNotifications(
      base,
      [pane('w9:p1', 'idle'), pane('w9:p2', 'working')],
      {},
      T0 + 1000
    );
    assert.deepEqual(r.emitted, []);
    assert.deepEqual(r.state.pending, []);
  });

  it('new pane appearing after baseline already blocked emits', () => {
    const r = reduceNotifications(
      base,
      [pane('w9:p1', 'working'), pane('w9:p9', 'blocked')],
      {},
      T0 + 1000
    );
    assert.deepEqual(r.emitted, [
      { paneId: 'w9:p9', status: 'blocked', at: T0 + 1000 },
    ]);
  });

  it('pane blocked at baseline emits only after leaving and re-entering', () => {
    const s0 = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'blocked')],
      {},
      T0
    ).state;
    const s1 = reduceNotifications(s0, [pane('w9:p1', 'blocked')], {}, T0 + 1000);
    assert.deepEqual(s1.emitted, []);
    const s2 = reduceNotifications(s1.state, [pane('w9:p1', 'working')], {}, T0 + 2000);
    assert.deepEqual(s2.emitted, []);
    const s3 = reduceNotifications(s2.state, [pane('w9:p1', 'blocked')], {}, T0 + 3000);
    assert.deepEqual(s3.emitted, [
      { paneId: 'w9:p1', status: 'blocked', at: T0 + 3000 },
    ]);
  });

  it('does not mutate the previous state (immutability)', () => {
    const frozen = JSON.parse(JSON.stringify(base));
    reduceNotifications(base, [pane('w9:p1', 'blocked')], {}, T0 + 1000);
    assert.deepEqual(base, frozen);
  });
});

describe('notify: 60s per-(pane,status) debounce', () => {
  function blockAt(state, at) {
    return reduceNotifications(state, [pane('w9:p1', 'blocked')], {}, at);
  }
  function unblockAt(state, at) {
    return reduceNotifications(state, [pane('w9:p1', 'working')], {}, at).state;
  }

  it('suppresses a re-edge inside the window; allows at the boundary', () => {
    const base = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'working')],
      {},
      T0
    ).state;
    const first = blockAt(base, T0 + 1000);
    assert.equal(first.emitted.length, 1);

    // Re-edge one ms before the window closes → suppressed
    let s = unblockAt(first.state, T0 + 2000);
    const inside = blockAt(s, T0 + 1000 + NOTIFY_DEBOUNCE_MS - 1);
    assert.deepEqual(inside.emitted, []);

    // Re-edge exactly at the boundary → emits
    s = unblockAt(first.state, T0 + 2000);
    const boundary = blockAt(s, T0 + 1000 + NOTIFY_DEBOUNCE_MS);
    assert.equal(boundary.emitted.length, 1);
    assert.equal(boundary.emitted[0].at, T0 + 1000 + NOTIFY_DEBOUNCE_MS);
  });

  it('suppressed re-edge adds no pending entry', () => {
    const base = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'working')],
      {},
      T0
    ).state;
    const first = blockAt(base, T0 + 1000);
    const opened = consumePaneNotifications(first.state, 'w9:p1').state;
    const s = unblockAt(opened, T0 + 2000);
    const again = blockAt(s, T0 + 3000);
    assert.deepEqual(again.emitted, []);
    assert.deepEqual(again.state.pending, []);
  });

  it('debounce is isolated per pane and per status', () => {
    const base = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'working'), pane('w9:p2', 'working')],
      {},
      T0
    ).state;
    // p1 blocked at t1
    const a = reduceNotifications(
      base,
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'working')],
      {},
      T0 + 1000
    );
    assert.equal(a.emitted.length, 1);
    // p2 blocked 1s later: other pane, not debounced
    const b = reduceNotifications(
      a.state,
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'blocked')],
      {},
      T0 + 2000
    );
    assert.deepEqual(b.emitted, [
      { paneId: 'w9:p2', status: 'blocked', at: T0 + 2000 },
    ]);
    // p1 blocked→done 1s later: same pane, other status, not debounced
    const c = reduceNotifications(
      b.state,
      [pane('w9:p1', 'done'), pane('w9:p2', 'blocked')],
      {},
      T0 + 3000
    );
    assert.deepEqual(c.emitted, [
      { paneId: 'w9:p1', status: 'done', at: T0 + 3000 },
    ]);
  });
});

describe('notify: independent enabled toggles', () => {
  const base = reduceNotifications(
    initialNotifyState(),
    [pane('w9:p1', 'working'), pane('w9:p2', 'working')],
    {},
    T0
  ).state;
  const next = [pane('w9:p1', 'blocked'), pane('w9:p2', 'done')];

  it('blocked disabled: no blocked emit/pending, done still emits', () => {
    const r = reduceNotifications(base, next, { blocked: false }, T0 + 1000);
    assert.deepEqual(r.emitted, [
      { paneId: 'w9:p2', status: 'done', at: T0 + 1000 },
    ]);
    assert.deepEqual(r.state.pending, r.emitted);
  });

  it('done disabled: no done emit/pending, blocked still emits', () => {
    const r = reduceNotifications(base, next, { done: false }, T0 + 1000);
    assert.deepEqual(r.emitted, [
      { paneId: 'w9:p1', status: 'blocked', at: T0 + 1000 },
    ]);
    assert.deepEqual(r.state.pending, r.emitted);
  });

  it('both disabled: nothing emits; statuses still tracked for later edges', () => {
    const r = reduceNotifications(
      base,
      next,
      { blocked: false, done: false },
      T0 + 1000
    );
    assert.deepEqual(r.emitted, []);
    assert.equal(r.state.statuses['w9:p1'], 'blocked');
  });

  it('disabled edges are not debounce-stamped; re-enable notices next edge', () => {
    const off = reduceNotifications(base, next, { blocked: false }, T0 + 1000);
    const back = reduceNotifications(
      off.state,
      [pane('w9:p1', 'working'), pane('w9:p2', 'done')],
      {},
      T0 + 2000
    ).state;
    const on = reduceNotifications(
      back,
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'done')],
      {},
      T0 + 3000
    );
    assert.deepEqual(on.emitted, [
      { paneId: 'w9:p1', status: 'blocked', at: T0 + 3000 },
    ]);
  });
});

describe('notify: pending list + consume', () => {
  const base = reduceNotifications(
    initialNotifyState(),
    [pane('w9:p1', 'working'), pane('w9:p2', 'working')],
    {},
    T0
  ).state;
  const both = reduceNotifications(
    base,
    [pane('w9:p1', 'blocked'), pane('w9:p2', 'done')],
    {},
    T0 + 1000
  ).state;

  it('consume clears only the opened pane and returns consumed events', () => {
    const r = consumePaneNotifications(both, 'w9:p1');
    assert.deepEqual(r.consumed, [
      { paneId: 'w9:p1', status: 'blocked', at: T0 + 1000 },
    ]);
    assert.deepEqual(r.state.pending, [
      { paneId: 'w9:p2', status: 'done', at: T0 + 1000 },
    ]);
    // original untouched
    assert.equal(both.pending.length, 2);
  });

  it('consume of a pane with no pending is an identity no-op', () => {
    const r = consumePaneNotifications(both, 'w9:p99');
    assert.deepEqual(r.consumed, []);
    assert.equal(r.state, both);
    const empty = consumePaneNotifications(null, 'w9:p1');
    assert.deepEqual(empty.consumed, []);
  });

  it('newer event for the same pane replaces its older pending entry', () => {
    const s = reduceNotifications(
      both,
      [pane('w9:p1', 'done'), pane('w9:p2', 'done')],
      {},
      T0 + 2000
    ).state;
    const mine = s.pending.filter((e) => e.paneId === 'w9:p1');
    assert.deepEqual(mine, [{ paneId: 'w9:p1', status: 'done', at: T0 + 2000 }]);
    assert.equal(s.pending.length, 2);
  });

  it('pending for a vanished pane is pruned', () => {
    const s = reduceNotifications(both, [pane('w9:p2', 'done')], {}, T0 + 2000).state;
    assert.deepEqual(s.pending, [
      { paneId: 'w9:p2', status: 'done', at: T0 + 1000 },
    ]);
  });

  it('pendingNotifyCount / latestPendingNotification', () => {
    assert.equal(pendingNotifyCount(both), 2);
    assert.equal(pendingNotifyCount(initialNotifyState()), 0);
    assert.equal(pendingNotifyCount(null), 0);
    const later = reduceNotifications(
      both,
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'idle'), pane('w9:p3', 'done')],
      {},
      T0 + 5000
    ).state;
    assert.deepEqual(latestPendingNotification(later), {
      paneId: 'w9:p3',
      status: 'done',
      at: T0 + 5000,
    });
    assert.equal(latestPendingNotification(initialNotifyState()), null);
    assert.equal(latestPendingNotification(null), null);
  });
});

describe('notify: presentation helpers', () => {
  it('formatNotifyBadge hides zero, caps at 99+', () => {
    assert.equal(formatNotifyBadge(0), '');
    assert.equal(formatNotifyBadge(null), '');
    assert.equal(formatNotifyBadge(-3), '');
    assert.equal(formatNotifyBadge(1), '1');
    assert.equal(formatNotifyBadge(99), '99');
    assert.equal(formatNotifyBadge(120), '99+');
  });

  it('notifyBannerView builds text + chat href', () => {
    const ev = { paneId: 'w9:p8', status: 'blocked', at: T0 };
    const v = notifyBannerView(ev, {
      pane_id: 'w9:p8',
      agent: 'claude',
      label: 'writer',
    });
    assert.equal(v.text, 'writer · 等你回复');
    assert.equal(v.href, '#/chat/w9%3Ap8');
    assert.equal(v.status, 'blocked');

    const done = notifyBannerView({ paneId: 'w9:p9', status: 'done', at: T0 }, null);
    assert.match(done.text, /已完成$/);
    assert.equal(done.status, 'done');
    assert.equal(notifyBannerView(null, null), null);
  });

  it('parseNotifyToggle defaults to enabled', () => {
    assert.equal(parseNotifyToggle(null), true);
    assert.equal(parseNotifyToggle(undefined), true);
    assert.equal(parseNotifyToggle('1'), true);
    assert.equal(parseNotifyToggle(''), true);
    assert.equal(parseNotifyToggle('0'), false);
  });

  it('constants: statuses and window', () => {
    assert.deepEqual(NOTIFY_STATUSES, ['blocked', 'done']);
    assert.equal(NOTIFY_DEBOUNCE_MS, 60_000);
  });
});

describe('notify: SPA wiring (static source)', () => {
  let html;
  let appJs;
  let css;

  before(async () => {
    const pub = path.join(__dirname, '..', 'public');
    html = await fs.readFile(path.join(pub, 'index.html'), 'utf8');
    appJs = await fs.readFile(path.join(pub, 'app.js'), 'utf8');
    css = await fs.readFile(path.join(pub, 'style.css'), 'utf8');
  });

  it('index.html has clickable banner, tab badge, and both toggles', () => {
    assert.match(html, /id="banner-notify"/);
    assert.match(html, /id="banner-notify-link"[^>]*href=/);
    assert.match(html, /id="banner-notify-text"/);
    assert.match(html, /id="tab-badge-chats"/);
    assert.match(html, /id="toggle-notify-blocked"[^>]*role="switch"/s);
    assert.match(html, /id="toggle-notify-done"[^>]*role="switch"/s);
    assert.match(html, /等你回复通知/);
    assert.match(html, /完成通知/);
    assert.match(html, /页内通知/);
  });

  it('app.js wires reducer into state apply and consume into pane open', () => {
    assert.match(appJs, /reduceNotifications/);
    assert.match(appJs, /function applyState[\s\S]*?reduceNotifications\(/);
    assert.match(
      appJs,
      /async function enterChat[\s\S]{0,300}consumePaneNotifications\(/
    );
    assert.match(appJs, /'pt2-notify-blocked'/);
    assert.match(appJs, /'pt2-notify-done'/);
    assert.match(appJs, /#toggle-notify-blocked/);
    assert.match(appJs, /#toggle-notify-done/);
    assert.match(appJs, /formatNotifyBadge/);
    assert.match(appJs, /notifyBannerView/);
  });

  it('style.css styles banner variants, badge, and safe-area ownership', () => {
    assert.match(css, /\.banner\.notify\s*\{/);
    assert.match(css, /\.banner\.notify\.done\s*\{/);
    assert.match(css, /\.tab-badge\s*\{/);
    assert.match(css, /#banner-notify:not\(\.hidden\) ~ \.view \.topbar/);
    assert.match(css, /\.banner-notify-link[\s\S]*?safe-area-inset-top/);
  });

  it('no service-worker / Web Push / VAPID / system-notification artifacts', async () => {
    const root = path.join(__dirname, '..');
    const sources = {
      'public/index.html': html,
      'public/app.js': appJs,
      'public/style.css': css,
      'public/spa-utils.js': await fs.readFile(
        path.join(root, 'public', 'spa-utils.js'),
        'utf8'
      ),
      'server.js': await fs.readFile(path.join(root, 'server.js'), 'utf8'),
    };
    const forbidden = [
      /service[-_]?worker/i,
      /PushManager/,
      /PushSubscription/,
      /applicationServerKey/,
      /vapid/i,
      /push-subs/,
      /new\s+Notification\s*\(/,
      /requestPermission/,
    ];
    for (const [file, src] of Object.entries(sources)) {
      for (const re of forbidden) {
        assert.doesNotMatch(src, re, `${file} must not contain ${re}`);
      }
    }
    const pubFiles = await fs.readdir(path.join(root, 'public'));
    const forbiddenNames = /^(sw|service-worker|push.*)\.js$|\.webmanifest$/i;
    assert.deepEqual(
      pubFiles.filter((f) => forbiddenNames.test(f)),
      [],
      'no service worker / push / manifest files in public/'
    );
  });
});
