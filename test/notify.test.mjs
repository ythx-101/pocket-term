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
  rebaselineNotifyState,
  consumePaneNotifications,
  refetchAfterSseReconnect,
  pendingNotifyCount,
  formatNotifyBadge,
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

  it('pendingNotifyCount tracks pending length', () => {
    assert.equal(pendingNotifyCount(both), 2);
    assert.equal(pendingNotifyCount(initialNotifyState()), 0);
    assert.equal(pendingNotifyCount(null), 0);
    const later = reduceNotifications(
      both,
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'idle'), pane('w9:p3', 'done')],
      {},
      T0 + 5000
    ).state;
    // p2 left done→idle so its pending is dropped (M5); p3 new done + p1 still blocked
    assert.equal(pendingNotifyCount(later), 2);
    assert.ok(later.pending.some((e) => e.paneId === 'w9:p3' && e.status === 'done'));
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

describe('notify: reconnect re-baseline (review fix)', () => {
  // Live session: p1 working, p2 blocked (already notified + consumed).
  function liveState() {
    const base = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'working'), pane('w9:p2', 'working')],
      {},
      T0
    ).state;
    const s = reduceNotifications(
      base,
      [pane('w9:p1', 'working'), pane('w9:p2', 'blocked')],
      {},
      T0 + 1000
    );
    assert.equal(s.emitted.length, 1);
    return s.state;
  }

  it('rebaseline preserves statuses, pending, and debounce history', () => {
    const live = liveState();
    const re = rebaselineNotifyState(live);
    assert.equal(re.baselined, false);
    assert.deepEqual(re.statuses, live.statuses);
    assert.deepEqual(re.pending, live.pending);
    assert.deepEqual(re.lastEmitted, live.lastEmitted);
    // Already-unbaselined or garbage input is an identity/fresh fallback.
    assert.equal(rebaselineNotifyState(re), re);
    assert.equal(rebaselineNotifyState(null).baselined, false);
  });

  it('status changed while disconnected does not emit in reconnect snapshot', () => {
    const re = rebaselineNotifyState(liveState());
    // p1 went working→blocked, p2 blocked→done while SSE was down.
    const r = reduceNotifications(
      re,
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'done')],
      {},
      T0 + 300_000
    );
    assert.deepEqual(r.emitted, []);
    assert.equal(r.state.baselined, true);
    assert.deepEqual(r.state.statuses, {
      'w9:p1': 'blocked',
      'w9:p2': 'done',
    });
    // Pending from before the disconnect survives the reconnect snapshot.
    assert.deepEqual(r.state.pending, [
      { paneId: 'w9:p2', status: 'blocked', at: T0 + 1000 },
    ]);
  });

  it('live edges after the reconnect snapshot still emit', () => {
    const re = rebaselineNotifyState(liveState());
    const snap = reduceNotifications(
      re,
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'working')],
      {},
      T0 + 300_000
    ).state;
    const back = reduceNotifications(
      snap,
      [pane('w9:p1', 'working'), pane('w9:p2', 'working')],
      {},
      T0 + 301_000
    ).state;
    const edge = reduceNotifications(
      back,
      [pane('w9:p1', 'blocked'), pane('w9:p2', 'done')],
      {},
      T0 + 400_000
    );
    assert.deepEqual(edge.emitted, [
      { paneId: 'w9:p1', status: 'blocked', at: T0 + 400_000 },
      { paneId: 'w9:p2', status: 'done', at: T0 + 400_000 },
    ]);
  });

  it('debounce history survives rebaseline: quick re-edge stays suppressed', () => {
    const live = liveState(); // p2 blocked emitted at T0+1000
    const unblocked = reduceNotifications(
      live,
      [pane('w9:p1', 'working'), pane('w9:p2', 'working')],
      {},
      T0 + 2000
    ).state;
    const re = rebaselineNotifyState(unblocked);
    const snap = reduceNotifications(
      re,
      [pane('w9:p1', 'working'), pane('w9:p2', 'working')],
      {},
      T0 + 3000
    ).state;
    // p2 blocked again inside the 60s window of its T0+1000 emission.
    const quick = reduceNotifications(
      snap,
      [pane('w9:p1', 'working'), pane('w9:p2', 'blocked')],
      {},
      T0 + 1000 + NOTIFY_DEBOUNCE_MS - 1
    );
    assert.deepEqual(quick.emitted, []);
  });

  it('integration: refetch-after-reconnect flow applies snapshot baseline-only', async () => {
    // Mirror app wiring: applyState runs the reducer; scheduleSseReconnect /
    // reconnectHard rebaseline before the refetch lands.
    let notifyState = reduceNotifications(
      initialNotifyState(),
      [pane('w9:p1', 'working')],
      {},
      T0
    ).state;
    const emittedLog = [];
    const applyState = (next) => {
      const r = reduceNotifications(
        notifyState,
        next.panes || [],
        {},
        next.__now
      );
      notifyState = r.state;
      emittedLog.push(...r.emitted);
    };

    // SSE drops; pane becomes blocked while disconnected.
    notifyState = rebaselineNotifyState(notifyState);
    await refetchAfterSseReconnect({
      fetchState: async () => ({
        panes: [pane('w9:p1', 'blocked')],
        __now: T0 + 120_000,
      }),
      applyState,
      activePaneId: null,
    });
    assert.deepEqual(emittedLog, [], 'reconnect snapshot must not notify');

    // Next live state event with a real edge still notifies.
    applyState({ panes: [pane('w9:p1', 'working')], __now: T0 + 121_000 });
    applyState({ panes: [pane('w9:p1', 'blocked')], __now: T0 + 200_000 });
    assert.deepEqual(emittedLog, [
      { paneId: 'w9:p1', status: 'blocked', at: T0 + 200_000 },
    ]);
  });
});

describe('notify: SPA wiring (static source) — M2.6 no top banner', () => {
  let html;
  let appJs;
  let css;
  let spaUtils;

  before(async () => {
    const pub = path.join(__dirname, '..', 'public');
    html = await fs.readFile(path.join(pub, 'index.html'), 'utf8');
    appJs = await fs.readFile(path.join(pub, 'app.js'), 'utf8');
    css = await fs.readFile(path.join(pub, 'style.css'), 'utf8');
    spaUtils = await fs.readFile(path.join(pub, 'spa-utils.js'), 'utf8');
  });

  it('index.html has no top banner; keeps tab badge, blocked-bar, and push toggles', () => {
    assert.doesNotMatch(html, /id="banner-notify"/);
    assert.doesNotMatch(html, /banner-notify-link/);
    assert.doesNotMatch(html, /banner-notify-text/);
    assert.match(html, /id="tab-badge-chats"/);
    assert.match(html, /id="blocked-bar"/);
    assert.match(html, /id="toggle-notify-blocked"[^>]*role="switch"/s);
    assert.match(html, /id="toggle-notify-done"[^>]*role="switch"/s);
    assert.match(html, /系统 Web Push|系统推送/);
    assert.match(html, /页内不再弹横幅/);
    assert.match(html, /状态见会话列表/);
  });

  it('app.js wires reducer + tab badge only (no banner DOM)', () => {
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
    assert.match(appJs, /paneRowClass/);
    assert.doesNotMatch(appJs, /banner-notify/);
    assert.doesNotMatch(appJs, /notifyBannerView/);
    assert.doesNotMatch(appJs, /latestPendingNotification/);
  });

  it('app.js rebaselines notifications on both reconnect paths', () => {
    assert.match(
      appJs,
      /function scheduleSseReconnect[\s\S]{0,200}rebaselineNotifyState\(/
    );
    assert.match(
      appJs,
      /async function reconnectHard[\s\S]{0,200}rebaselineNotifyState\(/
    );
  });

  it('style.css: list status (no banner-notify); blocked red bar; status dots', () => {
    assert.doesNotMatch(css, /#banner-notify/);
    assert.doesNotMatch(css, /\.banner-notify-link/);
    assert.doesNotMatch(css, /\.banner\.notify/);
    assert.match(css, /\.tab-badge\s*\{/);
    assert.match(css, /\.row\.row-blocked/);
    assert.match(css, /\.st-working/);
    assert.match(css, /\.st-blocked/);
    assert.match(css, /\.st-done/);
    assert.match(css, /\.st-idle/);
    assert.match(css, /@keyframes breathe/);
    assert.match(css, /\.unread-dot/);
    assert.match(css, /\.row-badge/);
  });

  it('chat list uses status dots + blocked pin class; keeps blocked-bar in chat', () => {
    assert.match(appJs, /paneRowClass\(p\)/);
    assert.match(appJs, /status-dot \$\{st\.cls\}/);
    assert.match(appJs, /row-badge/);
    assert.match(appJs, /#blocked-bar/);
    assert.match(spaUtils, /export function paneRowClass/);
    assert.match(spaUtils, /export function statusLabel/);
    assert.doesNotMatch(spaUtils, /export function statusDotClass/);
    assert.doesNotMatch(spaUtils, /export function notifyBannerView/);
    assert.doesNotMatch(spaUtils, /export function latestPendingNotification/);
    assert.doesNotMatch(spaUtils, /export function messageHasChatImage/);
  });

  it('Web Push remains additive; sw.js untouched as orthogonal', async () => {
    const root = path.join(__dirname, '..');
    const sources = {
      'public/index.html': html,
      'public/app.js': appJs,
      'public/style.css': css,
      'public/spa-utils.js': spaUtils,
      'server.js': await fs.readFile(path.join(root, 'server.js'), 'utf8'),
    };
    assert.match(sources['public/app.js'], /reduceNotifications/);
    assert.match(sources['public/app.js'], /requestPermission/);
    assert.match(sources['public/app.js'], /serviceWorker\.register/);
    assert.match(sources['public/index.html'], /id="btn-enable-push"/);
    assert.match(sources['public/index.html'], /状态始终显示在会话列表|状态见会话列表/);
    assert.match(sources['server.js'], /push\/vapid-public/);
    assert.equal((await fs.readdir(path.join(root, 'public'))).includes('sw.js'), true);
  });
});
