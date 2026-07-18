/**
 * Pure SPA helpers (browser + node --test).
 * No DOM APIs — safe to import from tests.
 */

/** @typedef {{ pane_id: string, agent?: string|null, agent_status?: string, label?: string|null, unread?: boolean, last_activity?: number|null, summary?: string, workspace_id?: string|null, workspace_label?: string|null, tab_id?: string|null, tab_label?: string|null, tier?: string }} Pane */

/**
 * Relative time in Chinese.
 * @param {number|string|null|undefined} ts ms or ISO
 * @param {number} [now]
 * @returns {string}
 */
export function formatRelativeTime(ts, now = Date.now()) {
  if (ts == null || ts === '') return '';
  let t = typeof ts === 'number' ? ts : Date.parse(String(ts));
  if (!Number.isFinite(t) || t <= 0) return '';
  // Guard absurd future/past ms-as-seconds mistakes
  if (t < 1e11) t *= 1000;
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const ny = new Date(now).getFullYear();
  return y === ny ? `${m}-${dd}` : `${y}-${m}-${dd}`;
}

/**
 * Chat list sort: working/blocked → unread done → last_activity desc.
 * @param {Pane} a
 * @param {Pane} b
 * @returns {number}
 */
export function comparePanes(a, b) {
  const rank = (s) => {
    if (s === 'working' || s === 'blocked') return 0;
    if (s === 'done') return 1;
    return 2;
  };
  const ra = rank(a?.agent_status);
  const rb = rank(b?.agent_status);
  if (ra !== rb) return ra - rb;
  // Within done: unread first
  if (ra === 1) {
    const ua = a?.unread ? 1 : 0;
    const ub = b?.unread ? 1 : 0;
    if (ua !== ub) return ub - ua;
  }
  // Active group: still prefer unread if any
  if (a?.unread !== b?.unread) return a?.unread ? -1 : 1;
  return (b?.last_activity || 0) - (a?.last_activity || 0);
}

/**
 * @param {Pane[]} panes
 * @returns {Pane[]}
 */
export function sortPanes(panes) {
  return (panes || []).slice().sort(comparePanes);
}

/**
 * Avatar presentation for an agent type.
 * @param {string|null|undefined} agent
 * @returns {{ letter: string, color: string, icon: string, key: string }}
 */
export function agentAvatar(agent) {
  const key = String(agent || 'shell').toLowerCase();
  const table = {
    claude: { letter: 'C', color: '#d4a574', icon: '◆', key: 'claude' },
    grok: { letter: 'G', color: '#7eb8da', icon: '✦', key: 'grok' },
    codex: { letter: 'X', color: '#9b8c7a', icon: '▣', key: 'codex' },
    shell: { letter: '$', color: '#5c7387', icon: '>_', key: 'shell' },
    pi: { letter: 'π', color: '#c4a7e7', icon: 'π', key: 'pi' },
    opencode: { letter: 'O', color: '#56b6c2', icon: '○', key: 'opencode' },
  };
  if (table[key]) return table[key];
  const letter = (key[0] || '?').toUpperCase();
  return { letter, color: '#5c7387', icon: letter, key: 'other' };
}

/**
 * Status display: color class + Chinese aria label.
 * @param {string|null|undefined} status
 * @returns {{ cls: string, label: string }}
 */
export function statusMeta(status) {
  switch (status) {
    case 'working':
      return { cls: 'st-working', label: '工作中' };
    case 'blocked':
      return { cls: 'st-blocked', label: '等待回复' };
    case 'done':
      return { cls: 'st-done', label: '已完成' };
    case 'idle':
      return { cls: 'st-idle', label: '空闲' };
    default:
      return { cls: 'st-unknown', label: '未知' };
  }
}

/**
 * Display title for a pane row / chat header.
 * @param {Pane} pane
 */
export function paneTitle(pane) {
  if (!pane) return '会话';
  if (pane.label) return pane.label;
  const agent = pane.agent || 'agent';
  return `${agent} · ${pane.pane_id || ''}`;
}

/**
 * Map a message/bubble record to view-model fields for DOM rendering.
 * @param {object} msg
 * @returns {{
 *   id: string,
 *   side: 'left'|'right'|'center',
 *   variant: 'agent'|'user'|'tool'|'stream',
 *   text: string,
 *   mono: boolean,
 *   ts: number|null,
 * }}
 */
export function mapBubbleToView(msg) {
  const m = msg || {};
  const id = String(m.id ?? `${m.ts ?? ''}:${m.role ?? ''}:${(m.text || m.summary || '').slice(0, 24)}`);
  const text = String(m.text ?? m.summary ?? '');
  const ts =
    typeof m.ts === 'number'
      ? m.ts
      : m.ts
        ? Date.parse(String(m.ts)) || null
        : null;

  if (m.role === 'user') {
    return { id, side: 'right', variant: 'user', text, mono: false, ts };
  }
  if (m.role === 'system' || m.kind === 'tool') {
    return {
      id,
      side: 'center',
      variant: 'tool',
      text: String(m.summary ?? m.text ?? ''),
      mono: false,
      ts,
    };
  }
  // Tier B stream cards: mono wide bubble
  const stream =
    m.stream === true ||
    m.variant === 'stream' ||
    m.mono === true ||
    (m.tier === 'B' && m.role === 'agent');
  if (stream) {
    return { id, side: 'left', variant: 'stream', text, mono: true, ts };
  }
  return { id, side: 'left', variant: 'agent', text, mono: false, ts };
}

/**
 * Group panes into workspace → tab → panes for contacts view.
 * @param {Pane[]} panes
 * @returns {Array<{ workspace_id: string, workspace_label: string, tabs: Array<{ tab_id: string, tab_label: string, panes: Pane[], pane_count: number }>, pane_count: number }>}
 */
export function groupContacts(panes) {
  /** @type {Map<string, any>} */
  const wsMap = new Map();
  for (const p of panes || []) {
    const wid = p.workspace_id || 'unknown';
    const tid = p.tab_id || 'unknown';
    if (!wsMap.has(wid)) {
      wsMap.set(wid, {
        workspace_id: wid,
        workspace_label: p.workspace_label || wid,
        tabs: new Map(),
        pane_count: 0,
      });
    }
    const ws = wsMap.get(wid);
    if (!ws.tabs.has(tid)) {
      ws.tabs.set(tid, {
        tab_id: tid,
        tab_label: p.tab_label || tid,
        panes: [],
        pane_count: 0,
      });
    }
    const tab = ws.tabs.get(tid);
    tab.panes.push(p);
    tab.pane_count = tab.panes.length;
    ws.pane_count += 1;
  }
  return [...wsMap.values()].map((ws) => ({
    workspace_id: ws.workspace_id,
    workspace_label: ws.workspace_label,
    pane_count: ws.pane_count,
    tabs: [...ws.tabs.values()],
  }));
}

/**
 * Parse hash route.
 * @param {string} hash location.hash
 * @returns {{ name: 'chats'|'chat'|'contacts'|'me', paneId?: string }}
 */
export function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  if (path === '/' || path === '' || path === '/chats') {
    return { name: 'chats' };
  }
  const chat = path.match(/^\/chat\/([^/]+)\/?$/);
  if (chat) {
    return { name: 'chat', paneId: decodeURIComponent(chat[1]) };
  }
  if (path.startsWith('/contacts')) return { name: 'contacts' };
  if (path.startsWith('/me')) return { name: 'me' };
  return { name: 'chats' };
}

/**
 * SSE reconnect delay: 1s / 2s / 5s cap.
 * @param {number} attempt 0-based
 */
export function sseBackoffMs(attempt) {
  const n = Math.max(0, attempt | 0);
  if (n <= 0) return 1000;
  if (n === 1) return 2000;
  return 5000;
}

/**
 * After EventSource reconnects, refetch state + current chat messages (P3 spec).
 * Pure orchestration hook — injectable deps for node --test.
 *
 * @param {{
 *   fetchState: () => Promise<object>,
 *   applyState: (state: object) => void|Promise<void>,
 *   activePaneId?: string|null,
 *   reloadMessages?: (paneId: string) => Promise<void>,
 * }} deps
 * @returns {Promise<{ stateRefetched: boolean, messagesPaneId: string|null }>}
 */
export async function refetchAfterSseReconnect(deps) {
  if (!deps || typeof deps.fetchState !== 'function') {
    throw new Error('fetchState required');
  }
  const state = await deps.fetchState();
  if (typeof deps.applyState === 'function') {
    await deps.applyState(state);
  }
  const paneId = deps.activePaneId || null;
  if (paneId && typeof deps.reloadMessages === 'function') {
    await deps.reloadMessages(paneId);
  }
  return {
    stateRefetched: true,
    messagesPaneId: paneId,
  };
}
