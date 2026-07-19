/**
 * SPA static + pure-function tests (no headless browser).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';
import {
  formatRelativeTime,
  comparePanes,
  sortPanes,
  mapBubbleToView,
  agentAvatar,
  statusMeta,
  paneTitle,
  groupContacts,
  parseRoute,
  sseBackoffMs,
  refetchAfterSseReconnect,
  shouldShowComposer,
  formatHerdrAbout,
  hotkeyPayload,
  shouldConfirmBeforeSend,
  sendErrorToast,
} from '../public/spa-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('spa pure: formatRelativeTime', () => {
  const now = Date.parse('2026-07-19T12:00:00.000Z');

  it('formats just now / minutes / hours / yesterday', () => {
    assert.equal(formatRelativeTime(now - 10_000, now), '刚刚');
    assert.equal(formatRelativeTime(now - 3 * 60_000, now), '3 分钟前');
    assert.equal(formatRelativeTime(now - 2 * 3600_000, now), '2 小时前');
    assert.equal(formatRelativeTime(now - 26 * 3600_000, now), '昨天');
  });

  it('handles empty', () => {
    assert.equal(formatRelativeTime(null, now), '');
    assert.equal(formatRelativeTime(0, now), '');
  });
});

describe('spa pure: sort / comparePanes', () => {
  it('orders working/blocked → unread done → activity', () => {
    const panes = [
      { pane_id: 'a', agent_status: 'idle', last_activity: 100, unread: false },
      { pane_id: 'b', agent_status: 'done', last_activity: 200, unread: true },
      { pane_id: 'c', agent_status: 'working', last_activity: 50, unread: false },
      { pane_id: 'd', agent_status: 'blocked', last_activity: 10, unread: false },
      { pane_id: 'e', agent_status: 'done', last_activity: 300, unread: false },
    ];
    const sorted = sortPanes(panes).map((p) => p.pane_id);
    // working & blocked first (activity desc among them: c=50, d=10)
    assert.equal(sorted[0], 'c');
    assert.equal(sorted[1], 'd');
    // unread done before read done
    assert.equal(sorted[2], 'b');
    assert.ok(sorted.indexOf('b') < sorted.indexOf('e'));
    assert.equal(comparePanes(panes[2], panes[0]) < 0, true);
  });
});

describe('spa pure: mapBubbleToView', () => {
  it('maps user / agent / tool / stream', () => {
    const user = mapBubbleToView({
      id: '1',
      role: 'user',
      text: '你好',
      ts: 1,
    });
    assert.equal(user.side, 'right');
    assert.equal(user.variant, 'user');

    const agent = mapBubbleToView({
      id: '2',
      role: 'agent',
      text: '收到',
      ts: 2,
    });
    assert.equal(agent.side, 'left');
    assert.equal(agent.variant, 'agent');
    assert.equal(agent.mono, false);

    const tool = mapBubbleToView({
      id: '3',
      role: 'system',
      kind: 'tool',
      summary: 'Read: /tmp/x',
    });
    assert.equal(tool.side, 'center');
    assert.equal(tool.variant, 'tool');
    assert.match(tool.text, /Read/);

    const stream = mapBubbleToView({
      id: '4',
      role: 'agent',
      text: 'line1\nline2',
      stream: true,
    });
    assert.equal(stream.variant, 'stream');
    assert.equal(stream.mono, true);
  });
});

describe('spa pure: avatar / status / route / contacts', () => {
  it('agentAvatar distinguishes claude/grok', () => {
    assert.equal(agentAvatar('claude').letter, 'C');
    assert.equal(agentAvatar('grok').letter, 'G');
    assert.ok(agentAvatar('claude').color);
  });

  it('statusMeta labels in Chinese', () => {
    assert.equal(statusMeta('working').label, '工作中');
    assert.equal(statusMeta('blocked').cls, 'st-blocked');
  });

  it('paneTitle falls back to agent+id', () => {
    assert.equal(paneTitle({ label: 'x' }), 'x');
    assert.match(paneTitle({ agent: 'grok', pane_id: 'w9:p9' }), /grok/);
  });

  it('parseRoute hash paths', () => {
    assert.deepEqual(parseRoute('#/chats'), { name: 'chats' });
    assert.deepEqual(parseRoute('#/chat/w9%3Ap8'), {
      name: 'chat',
      paneId: 'w9:p8',
    });
    assert.equal(parseRoute('#/contacts').name, 'contacts');
    assert.equal(parseRoute('#/me').name, 'me');
  });

  it('groupContacts nests workspace → tab', () => {
    const g = groupContacts([
      {
        pane_id: 'w9:p1',
        workspace_id: 'w9',
        workspace_label: '~',
        tab_id: 'w9:t1',
        tab_label: '1',
        agent: 'claude',
      },
      {
        pane_id: 'w9:p2',
        workspace_id: 'w9',
        workspace_label: '~',
        tab_id: 'w9:t2',
        tab_label: '2',
        agent: 'grok',
      },
    ]);
    assert.equal(g.length, 1);
    assert.equal(g[0].workspace_label, '~');
    assert.equal(g[0].pane_count, 2);
    assert.equal(g[0].tabs.length, 2);
  });

  it('sseBackoffMs caps at 5s', () => {
    assert.equal(sseBackoffMs(0), 1000);
    assert.equal(sseBackoffMs(1), 2000);
    assert.equal(sseBackoffMs(2), 5000);
    assert.equal(sseBackoffMs(9), 5000);
  });

  it('refetchAfterSseReconnect reloads state and open chat messages', async () => {
    const calls = [];
    const result = await refetchAfterSseReconnect({
      fetchState: async () => {
        calls.push('state');
        return { panes: [{ pane_id: 'w9:p8' }], herdr: 'connected' };
      },
      applyState: async (s) => {
        calls.push(`apply:${s.herdr}`);
      },
      activePaneId: 'w9:p8',
      reloadMessages: async (id) => {
        calls.push(`messages:${id}`);
      },
    });
    assert.deepEqual(result, {
      stateRefetched: true,
      messagesPaneId: 'w9:p8',
    });
    assert.deepEqual(calls, ['state', 'apply:connected', 'messages:w9:p8']);

    const noChat = await refetchAfterSseReconnect({
      fetchState: async () => ({ panes: [] }),
      applyState: () => {},
      activePaneId: null,
      reloadMessages: async () => {
        throw new Error('should not reload messages');
      },
    });
    assert.equal(noChat.messagesPaneId, null);
  });
});

describe('spa pure: send UI helpers', () => {
  it('shouldShowComposer hides on bridge readonly or local readonly', () => {
    assert.equal(shouldShowComposer({ readonly: false }, { localReadonly: false }), true);
    assert.equal(shouldShowComposer({ readonly: true }, { localReadonly: false }), false);
    assert.equal(shouldShowComposer({ readonly: false }, { localReadonly: true }), false);
    assert.equal(shouldShowComposer(null, { localReadonly: false }), true);
  });

  it('formatHerdrAbout matches herdr X · protocol Y', () => {
    assert.equal(
      formatHerdrAbout({ herdr_version: '0.7.3', protocol: 16 }),
      'herdr 0.7.3 · protocol 16'
    );
    assert.equal(formatHerdrAbout({}), 'herdr ? · protocol ?');
  });

  it('hotkeyPayload: Esc/Ctrl+C are control chars; enter is empty run', () => {
    assert.deepEqual(hotkeyPayload('enter'), {
      text: '',
      mode: 'run',
      label: '回车',
    });
    const esc = hotkeyPayload('esc');
    assert.equal(esc.mode, 'text');
    assert.equal(esc.text, '\x1b');
    const cc = hotkeyPayload('ctrl-c');
    assert.equal(cc.mode, 'text');
    assert.equal(cc.text, '\x03');
  });

  it('shouldConfirmBeforeSend respects toggle and skipEmpty', () => {
    assert.equal(shouldConfirmBeforeSend({ confirmBeforeSend: false }, 'hi'), false);
    assert.equal(shouldConfirmBeforeSend({ confirmBeforeSend: true }, 'hi'), true);
    assert.equal(
      shouldConfirmBeforeSend({ confirmBeforeSend: true }, '', { skipEmpty: true }),
      false
    );
    assert.equal(
      shouldConfirmBeforeSend({ confirmBeforeSend: true }, '', { skipEmpty: false }),
      true
    );
  });

  it('sendErrorToast covers 429/403/404', () => {
    assert.match(sendErrorToast(429, { error: 'rate_limited' }), /过快|稍后再试/);
    assert.match(sendErrorToast(403, { error: 'readonly' }), /只读/);
    assert.match(sendErrorToast(403, { error: 'cross_origin' }), /拒绝|跨域/);
    assert.match(sendErrorToast(404, { error: 'pane_not_found' }), /不存在|关闭/);
  });
});

describe('spa static via bridge', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let srv;
  let base;
  let stateDir;

  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-spa-'));
    srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir,
    });
    base = `http://127.0.0.1:${srv.port}`;
  });

  after(async () => {
    if (srv) await srv.close();
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('GET /herd/ HTML has three-view mount points + tab bar + composer hooks', async () => {
    const res = await fetch(`${base}/herd/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /id="view-chats"/);
    assert.match(html, /id="view-chat"/);
    assert.match(html, /id="view-contacts"/);
    assert.match(html, /id="view-me"/);
    assert.match(html, /id="tab-bar"/);
    assert.match(html, /id="composer"/);
    assert.match(html, /id="composer-input"/);
    assert.match(html, /id="btn-send"/);
    assert.match(html, /id="btn-confirm-enter"/);
    assert.match(html, /id="btn-wallpaper"/);
    assert.match(html, /id="toggle-confirm-send"/);
    assert.match(html, /id="toggle-local-readonly"/);
    assert.match(html, /id="herdr-about"/);
    assert.match(html, /app\.js/);
    assert.match(html, /style\.css/);
  });

  it('static assets have correct Content-Type', async () => {
    const css = await fetch(`${base}/herd/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') || '', /text\/css/);

    const js = await fetch(`${base}/herd/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') || '', /javascript/);

    const util = await fetch(`${base}/herd/spa-utils.js`);
    assert.equal(util.status, 200);
    assert.match(util.headers.get('content-type') || '', /javascript/);
  });

  it('GET /herd/api/state includes herdr_version and readonly', async () => {
    let body;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/herd/api/state`);
      assert.equal(res.status, 200);
      body = await res.json();
      if (body.herdr === 'connected' || body.herdr_version) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok('herdr_version' in body, 'herdr_version field present');
    assert.ok('readonly' in body, 'readonly field present');
    assert.equal(body.readonly, false);
    // Live herdr ping should populate version (e.g. 0.7.3)
    if (body.herdr === 'connected') {
      assert.equal(typeof body.herdr_version, 'string');
      assert.ok(body.herdr_version.length > 0);
      assert.equal(body.protocol, 16);
    }
  });
});

describe('spa state readonly flag (PT2_READONLY)', () => {
  it('state.readonly true when server started readonly', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt2-spa-ro-'));
    const mockClient = {
      allowWrite: false,
      rpc: async (method, _params, callOpts = {}) => {
        if (method === 'ping') {
          return { type: 'pong', protocol: 16, version: '0.7.3' };
        }
        if (method === 'session.snapshot') {
          return {
            snapshot: {
              workspaces: [],
              tabs: [],
              panes: [],
              agents: [],
            },
          };
        }
        if (method === 'pane.read') return { read: { text: '' } };
        if (method === 'events.wait') {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 200);
            const sig = callOpts.signal;
            if (sig) {
              const onAbort = () => {
                clearTimeout(t);
                const err = new Error('aborted');
                err.code = 'aborted';
                reject(err);
              };
              if (sig.aborted) {
                onAbort();
                return;
              }
              sig.addEventListener('abort', onAbort, { once: true });
            }
          });
          const err = new Error('timeout');
          err.code = 'timeout';
          throw err;
        }
        return {};
      },
      subscribe: () => ({ dead: false, close() {} }),
    };
    const srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      stateDir,
      client: mockClient,
      readonly: true,
    });
    try {
      const body = await (await fetch(`http://127.0.0.1:${srv.port}/herd/api/state`)).json();
      assert.equal(body.readonly, true);
      assert.equal(body.herdr_version, '0.7.3');
      assert.equal(body.protocol, 16);
      assert.equal(
        formatHerdrAbout(body),
        'herdr 0.7.3 · protocol 16'
      );
      assert.equal(shouldShowComposer(body, { localReadonly: false }), false);
    } finally {
      await srv.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
