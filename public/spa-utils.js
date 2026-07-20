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
 * Status display: color class + Chinese label (primary signal) + key.
 * Color mapping: idle=灰 working=绿(脉动) blocked=红 done=蓝 unknown=暗.
 * Labels match the old floating-banner wording, now permanent on the left.
 * @param {string|null|undefined} status
 * @returns {{ cls: string, label: string, key: string }}
 */
export function statusMeta(status) {
  switch (status) {
    case 'working':
      return { cls: 'st-working', label: '工作中', key: 'working' };
    case 'blocked':
      return { cls: 'st-blocked', label: '等你回复', key: 'blocked' };
    case 'done':
      return { cls: 'st-done', label: '完成', key: 'done' };
    case 'idle':
      return { cls: 'st-idle', label: '空闲', key: 'idle' };
    default:
      return { cls: 'st-unknown', label: '未知', key: 'unknown' };
  }
}

/**
 * Pure status → Chinese status text for list/header (primary signal).
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function statusLabel(status) {
  return statusMeta(status).label;
}

/**
 * CSS class list for a chat-list row (blocked left-edge pin marker).
 * @param {Pane|null|undefined} pane
 * @returns {string}
 */
export function paneRowClass(pane) {
  const parts = ['row'];
  if (pane?.agent_status === 'blocked') parts.push('row-blocked');
  if (pane?.unread) parts.push('row-unread');
  return parts.join(' ');
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
 * Sanitize bridge-provided stream hierarchy segments (M2.8-P3).
 * Keeps only well-formed `{ type: 'body'|'tool', text: string }` entries.
 * @param {unknown} segments
 * @returns {Array<{ type: 'body'|'tool', text: string }>|null}
 */
export function sanitizeStreamSegments(segments) {
  if (!Array.isArray(segments)) return null;
  const out = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const type = seg.type;
    if (type !== 'body' && type !== 'tool') continue;
    if (typeof seg.text !== 'string' || seg.text === '') continue;
    out.push({ type, text: seg.text });
  }
  return out.length ? out : null;
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
 *   segments: Array<{ type: 'body'|'tool', text: string }>|null,
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
    return { id, side: 'right', variant: 'user', text, mono: false, ts, segments: null };
  }
  if (m.role === 'system' || m.kind === 'tool') {
    return {
      id,
      side: 'center',
      variant: 'tool',
      text: String(m.summary ?? m.text ?? ''),
      mono: false,
      ts,
      segments: null,
    };
  }
  // Tier B stream cards: mono wide bubble with body/tool hierarchy segments
  const stream =
    m.stream === true ||
    m.variant === 'stream' ||
    m.mono === true ||
    (m.tier === 'B' && m.role === 'agent');
  if (stream) {
    return {
      id,
      side: 'left',
      variant: 'stream',
      text,
      mono: true,
      ts,
      segments: sanitizeStreamSegments(m.segments),
    };
  }
  return { id, side: 'left', variant: 'agent', text, mono: false, ts, segments: null };
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

/**
 * Whether the chat composer should be shown (vs M0-style readonly bar).
 * Hidden when bridge is readonly (PT2_READONLY) or the local me-page toggle is on.
 *
 * @param {{ readonly?: boolean }|null|undefined} state
 * @param {{ localReadonly?: boolean }} [prefs]
 */
export function shouldShowComposer(state, prefs = {}) {
  if (prefs.localReadonly === true) return false;
  if (state?.readonly === true) return false;
  return true;
}

/**
 * Format herdr version line for 我 / 关于.
 * @param {{ herdr_version?: string|null, protocol?: number|string|null }|null|undefined} state
 * @returns {string}
 */
export function formatHerdrAbout(state) {
  const ver =
    state?.herdr_version != null && String(state.herdr_version).trim()
      ? String(state.herdr_version).trim()
      : '?';
  const proto =
    state?.protocol != null && state.protocol !== ''
      ? String(state.protocol)
      : '?';
  return `herdr ${ver} · protocol ${proto}`;
}

/**
 * Preset hotkey → send payload (control chars via pane.send_text, not send_keys).
 * @param {'enter'|'esc'|'ctrl-c'|'up'|'down'} key
 * @returns {{ text: string, mode: 'run'|'text', label: string }}
 */
export function hotkeyPayload(key) {
  switch (key) {
    case 'enter':
      // Empty run = pure Enter (shell/agent confirm).
      return { text: '', mode: 'run', label: '回车' };
    case 'esc':
      return { text: '\x1b', mode: 'text', label: 'Esc' };
    case 'ctrl-c':
      return { text: '\x03', mode: 'text', label: 'Ctrl+C' };
    case 'up':
      return { text: '\x1b[A', mode: 'text', label: '↑' };
    case 'down':
      return { text: '\x1b[B', mode: 'text', label: '↓' };
    default:
      throw new Error(`unknown hotkey: ${key}`);
  }
}

/**
 * Decide whether to prompt before send (local 发送前确认).
 * Empty-text hotkeys (Enter confirm) can skip confirm when skipEmpty is true.
 *
 * @param {{ confirmBeforeSend?: boolean }} prefs
 * @param {string} text
 * @param {{ skipEmpty?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldConfirmBeforeSend(prefs, text, opts = {}) {
  if (!prefs?.confirmBeforeSend) return false;
  if (opts.skipEmpty && !String(text ?? '')) return false;
  return true;
}

/**
 * Map send API failure to a short toast string.
 * @param {number} status
 * @param {{ error?: string }|null|undefined} body
 */
export function sendErrorToast(status, body) {
  const err = body?.error || '';
  if (status === 429 || err === 'rate_limited') {
    return '发送过快，请稍后再试';
  }
  if (status === 403 && err === 'readonly') {
    return '只读模式：服务端已关闭发送';
  }
  if (status === 403) {
    return '发送被拒绝（跨域或权限）';
  }
  if (status === 404 || err === 'pane_not_found') {
    return '会话不存在或已关闭';
  }
  if (status === 413) {
    return '内容过长';
  }
  return err ? `发送失败：${err}` : `发送失败（${status || '?'}）`;
}

/** Dim slider range: 0–90% → CSS var 0–0.9 */
export const DIM_SLIDER_MAX = 90;
export const DIM_DEFAULT_PERCENT = 35;

/**
 * Map dim slider percent (0..90) to CSS `--wallpaper-dim` fraction string.
 * @param {number|string|null|undefined} percent
 * @returns {string} e.g. "0.35"
 */
export function dimPercentToCssVar(percent) {
  let n = Number(percent);
  if (!Number.isFinite(n)) n = DIM_DEFAULT_PERCENT;
  n = Math.min(DIM_SLIDER_MAX, Math.max(0, n));
  // Keep one or two decimals max; 35 → "0.35", 0 → "0", 90 → "0.9"
  const frac = Math.round(n) / 100;
  return String(frac);
}

/**
 * Map API dim fraction (0..0.9) to slider percent (0..90).
 * @param {number|string|null|undefined} dim
 * @returns {number}
 */
export function dimToPercent(dim) {
  let n = Number(dim);
  if (!Number.isFinite(n)) return DIM_DEFAULT_PERCENT;
  n = Math.min(0.9, Math.max(0, n));
  return Math.round(n * 100);
}

/**
 * Map slider percent to API dim fraction (0..0.9).
 * @param {number|string|null|undefined} percent
 * @returns {number}
 */
export function dimPercentToApi(percent) {
  return Number(dimPercentToCssVar(percent));
}

/**
 * URL for a wallpaper asset under the API base.
 * @param {string} base e.g. "/herd"
 * @param {string} name basename
 * @returns {string}
 */
export function wallpaperAssetUrl(base, name) {
  const b = String(base || '').replace(/\/$/, '');
  return `${b}/api/wallpaper/${encodeURIComponent(name)}`;
}

/**
 * URL for a chat-upload image via GET /herd/api/file?path=.
 * @param {string} base e.g. "/herd"
 * @param {string} absPath absolute path under /srv/term-uploads/
 * @returns {string}
 */
export function fileAssetUrl(base, absPath) {
  const b = String(base || '').replace(/\/$/, '');
  return `${b}/api/file?path=${encodeURIComponent(String(absPath || ''))}`;
}

/** Image extensions recognized in message text / file endpoint. */
export const MSG_IMAGE_EXTS = 'jpg|jpeg|png|webp|gif';

/**
 * Whether a path is a serveable chat-upload image path.
 * @param {string} p
 * @returns {boolean}
 */
export function isChatUploadImagePath(p) {
  const s = String(p || '');
  if (!s.startsWith('/srv/term-uploads/')) return false;
  // basename only after the prefix (no further traversal)
  const rest = s.slice('/srv/term-uploads/'.length);
  if (!rest || rest.includes('/') || rest.includes('\\') || rest.includes('..')) {
    return false;
  }
  return new RegExp(`\\.(?:${MSG_IMAGE_EXTS})$`, 'i').test(rest);
}

/**
 * Parse bubble text into text / image segments for Telegram-style rendering.
 * Matches `[图片: /srv/term-uploads/<name>]` or bare
 * `/srv/term-uploads/<name>.(jpg|jpeg|png|webp|gif)`.
 *
 * @param {string|null|undefined} text
 * @returns {Array<{ type: 'text', text: string } | { type: 'image', path: string }>}
 */
export function parseMessageImageSegments(text) {
  const s = String(text ?? '');
  if (!s) return [{ type: 'text', text: '' }];

  const bracket =
    /\[图片:\s*(\/srv\/term-uploads\/[^\]\n]+?)\]/g;
  const bare = new RegExp(
    `(\\/srv\\/term-uploads\\/[^\\s\\[\\]<>"']+\\.(?:${MSG_IMAGE_EXTS}))`,
    'gi'
  );

  /** @type {Array<{ start: number, end: number, path: string }>} */
  const hits = [];

  let m;
  while ((m = bracket.exec(s)) !== null) {
    const p = m[1].trim();
    if (isChatUploadImagePath(p)) {
      hits.push({ start: m.index, end: m.index + m[0].length, path: p });
    }
  }
  while ((m = bare.exec(s)) !== null) {
    const p = m[1];
    if (!isChatUploadImagePath(p)) continue;
    // Skip if already covered by a bracket match
    const covered = hits.some((h) => m.index >= h.start && m.index < h.end);
    if (covered) continue;
    hits.push({ start: m.index, end: m.index + m[0].length, path: p });
  }

  hits.sort((a, b) => a.start - b.start || a.end - b.end);

  // Drop overlaps (keep earlier / longer)
  /** @type {typeof hits} */
  const clean = [];
  for (const h of hits) {
    const last = clean[clean.length - 1];
    if (last && h.start < last.end) continue;
    clean.push(h);
  }

  if (!clean.length) return [{ type: 'text', text: s }];

  /** @type {Array<{ type: 'text', text: string } | { type: 'image', path: string }>} */
  const segments = [];
  let cursor = 0;
  for (const h of clean) {
    if (h.start > cursor) {
      segments.push({ type: 'text', text: s.slice(cursor, h.start) });
    }
    segments.push({ type: 'image', path: h.path });
    cursor = h.end;
  }
  if (cursor < s.length) {
    segments.push({ type: 'text', text: s.slice(cursor) });
  }
  return segments;
}

/**
 * Build send payload text from optional attach path + caption.
 * Agent-compatible form: `[图片: <path>] <caption>`.
 *
 * @param {string|null|undefined} caption
 * @param {string|null|undefined} imagePath
 * @returns {string}
 */
export function composeImageSendText(caption, imagePath) {
  const pathAbs = imagePath != null && String(imagePath) ? String(imagePath) : '';
  const cap = caption != null ? String(caption) : '';
  if (!pathAbs) return cap;
  const token = `[图片: ${pathAbs}]`;
  const trimmed = cap.trim();
  if (!trimmed) return token;
  return `${token} ${trimmed}`;
}

/**
 * Attach preview strip state machine (select / remove / send-clear).
 * @typedef {{ path: string|null }} AttachPreviewState
 * @typedef {
 *   | { type: 'set', path: string }
 *   | { type: 'remove' }
 *   | { type: 'clear' }
 *   | { type: 'send' }
 * } AttachPreviewAction
 *
 * @param {AttachPreviewState|null|undefined} state
 * @param {AttachPreviewAction} action
 * @returns {AttachPreviewState}
 */
export function reduceAttachPreview(state, action) {
  const cur = state && typeof state === 'object' ? state : { path: null };
  const t = action && action.type;
  if (t === 'set') {
    const p = action.path != null ? String(action.path) : '';
    if (!p) return { path: null };
    return { path: p };
  }
  if (t === 'remove' || t === 'clear' || t === 'send') {
    return { path: null };
  }
  return { path: cur.path != null ? cur.path : null };
}

/**
 * Initial attach preview state.
 * @returns {AttachPreviewState}
 */
export function initialAttachPreview() {
  return { path: null };
}

// —— in-app notifications (M2.5) ——

/** Statuses that produce an in-app notification when entered. */
export const NOTIFY_STATUSES = ['blocked', 'done'];
/** Suppress duplicate (pane,status) notifications inside this window. */
export const NOTIFY_DEBOUNCE_MS = 60_000;

/**
 * @typedef {{ paneId: string, status: 'blocked'|'done', at: number }} NotifyEvent
 * @typedef {{
 *   baselined: boolean,
 *   statuses: Record<string, string>,
 *   lastEmitted: Record<string, number>,
 *   pending: NotifyEvent[],
 * }} NotifyState
 */

/**
 * Fresh notification state; the first reduce establishes a baseline
 * (records statuses without emitting) so initial/reconnect snapshots
 * never replay pre-existing blocked/done panes.
 * @returns {NotifyState}
 */
export function initialNotifyState() {
  return { baselined: false, statuses: {}, lastEmitted: {}, pending: [] };
}

/** Debounce key per (pane,status); NUL never appears in pane ids. */
function notifyKey(paneId, status) {
  return `${paneId}\u0000${status}`;
}

/**
 * Reduce one full pane snapshot into notification state.
 * Detects only edges *into* blocked/done, honors independent enabled
 * flags, applies the per-(pane,status) debounce with an injected clock,
 * and never mutates `prev`.
 *
 * @param {NotifyState|null|undefined} prev
 * @param {Pane[]|null|undefined} panes current snapshot
 * @param {{ blocked?: boolean, done?: boolean }} [enabled] default both on
 * @param {number} [now]
 * @returns {{ state: NotifyState, emitted: NotifyEvent[] }}
 */
export function reduceNotifications(prev, panes, enabled = {}, now = Date.now()) {
  const cur =
    prev && typeof prev === 'object' && Array.isArray(prev.pending)
      ? prev
      : initialNotifyState();
  const list = Array.isArray(panes) ? panes : [];

  /** @type {Record<string, string>} */
  const statuses = {};
  for (const p of list) {
    if (!p || p.pane_id == null || p.pane_id === '') continue;
    statuses[String(p.pane_id)] = p.agent_status != null ? String(p.agent_status) : '';
  }

  if (!cur.baselined) {
    return {
      state: {
        baselined: true,
        statuses,
        lastEmitted: { ...cur.lastEmitted },
        pending: cur.pending.slice(),
      },
      emitted: [],
    };
  }

  const isEnabled = (status) =>
    status === 'blocked' ? enabled.blocked !== false : enabled.done !== false;
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const lastEmitted = { ...cur.lastEmitted };
  /** @type {NotifyEvent[]} */
  const emitted = [];
  let pending = cur.pending;

  for (const [paneId, status] of Object.entries(statuses)) {
    if (!NOTIFY_STATUSES.includes(status)) continue;
    if (cur.statuses[paneId] === status) continue; // no edge
    if (!isEnabled(status)) continue;
    const key = notifyKey(paneId, status);
    const lastAt = lastEmitted[key];
    if (Number.isFinite(lastAt) && t - lastAt < NOTIFY_DEBOUNCE_MS) continue;
    lastEmitted[key] = t;
    const ev = { paneId, status: /** @type {'blocked'|'done'} */ (status), at: t };
    emitted.push(ev);
    // Latest event per pane wins; older pending for the pane is stale.
    pending = pending.filter((e) => e.paneId !== paneId).concat(ev);
  }

  // M5: drop pending when pane leaves blocked/done (e.g. done→working).
  // Unread done that is *still* done is kept; only non-notify statuses clear.
  // Also drop pending for panes that no longer exist (cannot be opened).
  pending = pending.filter((e) => {
    if (!(e.paneId in statuses)) return false;
    const st = statuses[e.paneId];
    return st === 'blocked' || st === 'done';
  });

  return {
    state: { baselined: true, statuses, lastEmitted, pending },
    emitted,
  };
}

/**
 * M4: drop Tier B stream cards from a client bubble list after a B→A purge.
 * Keeps user / Tier A agent / system messages.
 * @param {Array<object>|null|undefined} items
 * @returns {Array<object>}
 */
export function purgeTierBStreamItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((b) => b && b.stream !== true);
}

/**
 * Drop the baseline before a reconnect/refetch snapshot: the next reduce
 * records statuses without emitting, so a status that changed while the
 * connection was down is not replayed as an edge. Pending notifications
 * and debounce history are preserved.
 * @param {NotifyState|null|undefined} state
 * @returns {NotifyState}
 */
export function rebaselineNotifyState(state) {
  const cur =
    state && typeof state === 'object' && Array.isArray(state.pending)
      ? state
      : initialNotifyState();
  if (!cur.baselined) return cur;
  return { ...cur, baselined: false };
}

/**
 * Consume (clear) all pending notifications for an opened pane.
 * @param {NotifyState|null|undefined} state
 * @param {string|null|undefined} paneId
 * @returns {{ state: NotifyState, consumed: NotifyEvent[] }}
 */
export function consumePaneNotifications(state, paneId) {
  const cur =
    state && typeof state === 'object' && Array.isArray(state.pending)
      ? state
      : initialNotifyState();
  const id = paneId == null ? '' : String(paneId);
  const consumed = cur.pending.filter((e) => e.paneId === id);
  if (!consumed.length) return { state: cur, consumed: [] };
  return {
    state: { ...cur, pending: cur.pending.filter((e) => e.paneId !== id) },
    consumed,
  };
}

/**
 * Total pending notifications (会话 tab badge count).
 * @param {NotifyState|null|undefined} state
 * @returns {number}
 */
export function pendingNotifyCount(state) {
  return Array.isArray(state?.pending) ? state.pending.length : 0;
}

/**
 * Badge text: '' hides, 1..99 numeric, 99+ capped.
 * @param {number|null|undefined} count
 * @returns {string}
 */
export function formatNotifyBadge(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n > 99 ? '99+' : String(Math.floor(n));
}

/**
 * Parse a localStorage notification toggle; absent/other = enabled.
 * @param {string|null|undefined} raw
 * @returns {boolean}
 */
export function parseNotifyToggle(raw) {
  return raw !== '0';
}

/** Decode a VAPID base64url public key for PushManager.subscribe(). */
export function vapidKeyToBytes(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('VAPID 公钥格式无效');
  return bytes;
}

/** Pure mobile lifecycle recovery decision. */
export function shouldRecoverLifecycle({ type, visibilityState, persisted, online, sseHealthy, recoveryPending }) {
  if (sseHealthy || recoveryPending) return false;
  if (type === 'visibilitychange') return visibilityState === 'visible';
  if (type === 'pageshow') return persisted === true;
  if (type === 'online') return online !== false;
  return false;
}

/** Collapse identical toast text within this window (ms). */
export const TOAST_COLLAPSE_MS = 3000;
/** Auto-dismiss toast after this many ms. */
export const TOAST_DISMISS_MS = 4000;

/**
 * Pure toast-collapse decision: identical text within windowMs shows only once.
 *
 * @param {string} message
 * @param {{ text: string, at: number }|null|undefined} last previous emit state
 * @param {number} [now]
 * @param {number} [windowMs]
 * @returns {{ show: boolean, last: { text: string, at: number } }}
 */
export function shouldEmitToast(
  message,
  last,
  now = Date.now(),
  windowMs = TOAST_COLLAPSE_MS
) {
  const text = String(message ?? '');
  const t = Number(now);
  const win = Number(windowMs);
  if (
    last &&
    last.text === text &&
    Number.isFinite(t) &&
    Number.isFinite(Number(last.at)) &&
    Number.isFinite(win) &&
    t - Number(last.at) < win
  ) {
    return { show: false, last };
  }
  return { show: true, last: { text, at: Number.isFinite(t) ? t : Date.now() } };
}
