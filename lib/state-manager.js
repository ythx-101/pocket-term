/**
 * Bridge state manager: herdr snapshot + event fan-out + Tier A/B bubbles.
 * All herdr I/O goes through lib/herdr-client.js (read-only whitelist).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from './herdr-client.js';
import { diffNewText, foldBubbles, stripAnsi } from './bubbles.js';
import {
  readMessages,
  resolveSafePath,
  DEFAULT_ALLOWED_ROOT,
} from './transcript-reader.js';

const BUBBLE_LIMIT = 200;
const STATE_THROTTLE_MS = 300;
const HEARTBEAT_NOTE = 'heartbeat';
const RECONNECT_MS = 5000;
const SNAPSHOT_POLL_MS = 30000;
const OUTPUT_WAIT_MS = 8000;
const OUTPUT_POLL_FALLBACK_MS = 2000;
const SSE_HEARTBEAT_MS = 15000;

const GLOBAL_SUBSCRIPTIONS = [
  { type: 'workspace.created' },
  { type: 'workspace.closed' },
  { type: 'workspace.renamed' },
  { type: 'workspace.moved' },
  { type: 'workspace.focused' },
  { type: 'tab.created' },
  { type: 'tab.closed' },
  { type: 'tab.renamed' },
  { type: 'tab.moved' },
  { type: 'tab.focused' },
  { type: 'pane.created' },
  { type: 'pane.closed' },
  { type: 'pane.moved' },
  { type: 'pane.focused' },
  { type: 'pane.agent_detected' },
  { type: 'layout.updated' },
];

/**
 * @param {string} dir
 * @param {unknown} data
 */
async function atomicWriteJson(dir, fileName, data) {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, fileName);
  const tmp = path.join(dir, `.${fileName}.${process.pid}.tmp`);
  const body = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, target);
}

/**
 * @param {string} dir
 */
async function loadLastSeen(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'last-seen.json'), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function firstLine(text) {
  if (!text) return '';
  const line = stripAnsi(String(text)).split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim() : '';
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * @param {object} pane
 * @returns {string|null}
 */
function extractTranscriptPath(pane) {
  if (!pane || typeof pane !== 'object') return null;
  const candidates = [
    pane.agent_session_path,
    pane.agent_session,
    pane.session_path,
    pane.agent_session_id && typeof pane.agent_session_id === 'string' && pane.agent_session_id.includes('/')
      ? pane.agent_session_id
      : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

/**
 * @param {{
 *   client?: ReturnType<typeof createClient>,
 *   stateDir: string,
 *   allowedRoot?: string,
 *   socketPath?: string,
 * }} options
 */
export function createStateManager(options) {
  const client =
    options.client ??
    createClient({
      socketPath: options.socketPath,
      timeoutMs: 5000,
    });
  const stateDir = options.stateDir;
  const allowedRoot = options.allowedRoot ?? DEFAULT_ALLOWED_ROOT;

  /** @type {Map<string, import('node:http').ServerResponse>} */
  const sseClients = new Map();
  let sseSeq = 0;

  /** @type {Map<string, object>} */
  const paneRuntime = new Map();

  /** @type {Record<string, number>} */
  let lastSeen = {};

  let protocol = null;
  let protocolMismatch = false;
  let herdrStatus = 'disconnected';
  /** @type {object|null} */
  let snapshot = null;
  /** @type {object|null} */
  let publicState = null;
  let lastStateJson = '';

  /** @type {ReturnType<ReturnType<typeof createClient>['subscribe']>|null} */
  let subHandle = null;
  /** @type {string} */
  let subPaneKey = '';
  let throttleTimer = null;
  let pollTimer = null;
  let reconnectTimer = null;
  let stopped = true;
  /** @type {AbortController|null} */
  let abort = null;
  /** @type {Map<string, Promise<void>>} */
  const outputLoops = new Map();

  function ensureRuntime(paneId) {
    let rt = paneRuntime.get(paneId);
    if (!rt) {
      rt = {
        prevText: '',
        openLines: /** @type {string[]} */ ([]),
        openTs: /** @type {number|null} */ (null),
        lastLineTs: 0,
        lastStatus: /** @type {string|null} */ (null),
        buffer: /** @type {object[]} */ ([]),
        transcriptOffset: 0,
        transcriptPath: /** @type {string|null} */ (null),
        tier: 'B',
        summary: '',
        lastActivity: 0,
      };
      paneRuntime.set(paneId, rt);
    }
    return rt;
  }

  function pushBubble(paneId, bubble) {
    const rt = ensureRuntime(paneId);
    const entry = {
      id: `${paneId}:${bubble.ts}:${rt.buffer.length}`,
      ts: bubble.ts,
      text: bubble.text,
      role: bubble.role ?? 'agent',
      kind: bubble.kind,
      summary: bubble.summary,
      sealed: true,
    };
    rt.buffer.push(entry);
    while (rt.buffer.length > BUBBLE_LIMIT) rt.buffer.shift();
    if (entry.role === 'agent' && entry.text) {
      rt.summary = firstLine(entry.text);
    } else if (entry.role === 'system' && entry.summary && !rt.summary) {
      rt.summary = firstLine(entry.summary);
    }
    rt.lastActivity = Math.max(rt.lastActivity, Number(entry.ts) || Date.now());
    broadcast('bubble', { pane_id: paneId, bubble: entry });
  }

  function sealOpen(paneId) {
    const rt = ensureRuntime(paneId);
    if (!rt.openLines.length) {
      rt.openTs = null;
      return;
    }
    const folded = foldBubbles([
      { ts: rt.openTs ?? Date.now(), lines: rt.openLines.slice() },
    ]);
    rt.openLines = [];
    rt.openTs = null;
    for (const b of folded) {
      pushBubble(paneId, { ...b, role: 'agent' });
    }
  }

  function appendTierBLines(paneId, lines, ts = Date.now()) {
    if (!lines?.length) return;
    const rt = ensureRuntime(paneId);
    // Silence seal before appending if gap is large.
    if (rt.openLines.length && rt.lastLineTs && ts - rt.lastLineTs >= 2000) {
      sealOpen(paneId);
    }
    if (!rt.openLines.length) rt.openTs = ts;
    rt.openLines.push(...lines.map(String));
    rt.lastLineTs = ts;
    rt.lastActivity = Math.max(rt.lastActivity, ts);
  }

  function onStatus(paneId, status, ts = Date.now()) {
    const rt = ensureRuntime(paneId);
    if (
      rt.lastStatus === 'working' &&
      (status === 'idle' || status === 'done')
    ) {
      sealOpen(paneId);
    }
    rt.lastStatus = status;
    rt.lastActivity = Math.max(rt.lastActivity, ts);
  }

  /**
   * @param {string} event
   * @param {unknown} data
   */
  function broadcast(event, data) {
    const payload =
      event === 'state' || event === 'bubble'
        ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        : `:${HEARTBEAT_NOTE}\n\n`;
    for (const [, res] of sseClients) {
      try {
        res.write(payload);
      } catch {
        /* drop on write error; close handler removes */
      }
    }
  }

  function sendHeartbeat() {
    const payload = `:${HEARTBEAT_NOTE}\n\n`;
    for (const [, res] of sseClients) {
      try {
        res.write(payload);
      } catch {
        /* ignore */
      }
    }
  }

  function buildPublicState() {
    const panesRaw = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
    const workspaces = Array.isArray(snapshot?.workspaces)
      ? snapshot.workspaces
      : [];
    const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
    const wsLabel = new Map(
      workspaces.map((w) => [w.workspace_id, w.label ?? w.workspace_id])
    );
    const tabLabel = new Map(
      tabs.map((t) => [t.tab_id, t.label ?? t.tab_id])
    );

    const panes = panesRaw.map((p) => {
      const id = p.pane_id;
      const rt = ensureRuntime(id);
      const status = p.agent_status ?? 'unknown';
      const lastActivity = rt.lastActivity || 0;
      const seenAt = Number(lastSeen[id]) || 0;
      const unread =
        status === 'done' && lastActivity > 0 && lastActivity > seenAt;
      // summary: Tier A last agent line preferred (already in rt.summary),
      // else Tier B last bubble last line
      let summary = rt.summary;
      if (!summary && rt.buffer.length) {
        const last = rt.buffer[rt.buffer.length - 1];
        summary = firstLine(last.text || last.summary || '');
      }
      return {
        pane_id: id,
        agent: p.agent ?? null,
        agent_status: status,
        label: p.label ?? null,
        workspace_id: p.workspace_id ?? null,
        workspace_label: wsLabel.get(p.workspace_id) ?? p.workspace_id ?? null,
        tab_id: p.tab_id ?? null,
        tab_label: tabLabel.get(p.tab_id) ?? p.tab_id ?? null,
        summary: summary || '',
        last_activity: lastActivity || null,
        unread,
        tier: rt.tier,
      };
    });

    // Sort: working/blocked first, then unread done, then last_activity desc
    const rank = (s) =>
      s === 'working' || s === 'blocked' ? 0 : s === 'done' ? 1 : 2;
    panes.sort((a, b) => {
      const ra = rank(a.agent_status);
      const rb = rank(b.agent_status);
      if (ra !== rb) return ra - rb;
      if (a.unread !== b.unread) return a.unread ? -1 : 1;
      return (b.last_activity || 0) - (a.last_activity || 0);
    });

    return {
      herdr: herdrStatus,
      protocol,
      protocol_mismatch: protocolMismatch,
      focused_pane_id: snapshot?.focused_pane_id ?? null,
      focused_tab_id: snapshot?.focused_tab_id ?? null,
      focused_workspace_id: snapshot?.focused_workspace_id ?? null,
      panes,
      updated_at: Date.now(),
    };
  }

  function publishState(force = false) {
    publicState = buildPublicState();
    // Compare without updated_at so pure clock ticks do not flood SSE.
    const { updated_at: _ts, ...rest } = publicState;
    void _ts;
    const json = JSON.stringify(rest);
    if (!force && json === lastStateJson) return;
    lastStateJson = json;
    broadcast('state', publicState);
  }

  function scheduleStateRefresh() {
    if (stopped) return;
    if (throttleTimer) return;
    throttleTimer = setTimeout(async () => {
      throttleTimer = null;
      try {
        await refreshSnapshot();
      } catch {
        /* next tick / reconnect */
      }
    }, STATE_THROTTLE_MS);
  }

  async function refreshSnapshot() {
    if (stopped) return;
    const result = await client.rpc('session.snapshot');
    const snap = result?.snapshot ?? result;
    const prevIds = new Set(
      (Array.isArray(snapshot?.panes) ? snapshot.panes : []).map((p) => p.pane_id)
    );
    snapshot = snap;
    herdrStatus = 'connected';

    const panes = Array.isArray(snap?.panes) ? snap.panes : [];
    const nextIds = new Set(panes.map((p) => p.pane_id));

    for (const p of panes) {
      const rt = ensureRuntime(p.pane_id);
      const prevStatus = rt.lastStatus;
      if (p.agent_status && p.agent_status !== prevStatus) {
        onStatus(p.pane_id, p.agent_status, Date.now());
      } else {
        rt.lastStatus = p.agent_status ?? rt.lastStatus;
      }
      // Tier A path detection
      const tPath = extractTranscriptPath(p);
      if (tPath) {
        try {
          await resolveSafePath(tPath, allowedRoot);
          rt.transcriptPath = tPath;
          rt.tier = 'A';
        } catch {
          rt.transcriptPath = null;
          rt.tier = 'B';
        }
      } else {
        rt.transcriptPath = null;
        rt.tier = 'B';
      }
    }

    // Drop closed panes' output loops (buffers kept until GC of map optionally)
    for (const id of prevIds) {
      if (!nextIds.has(id)) {
        // stop loop by aborting shared controller restart handled below
      }
    }

    publishState();

    const key = [...nextIds].sort().join(',');
    if (key !== subPaneKey) {
      subPaneKey = key;
      rebuildSubscription([...nextIds]);
      syncOutputLoops([...nextIds]);
    }
  }

  function rebuildSubscription(paneIds) {
    if (subHandle) {
      if (subHandle._check) {
        clearInterval(subHandle._check);
        subHandle._check = null;
      }
      try {
        subHandle.close();
      } catch {
        /* ignore */
      }
      subHandle = null;
    }
    if (stopped) return;

    const subscriptions = [
      ...GLOBAL_SUBSCRIPTIONS,
      ...paneIds.map((pane_id) => ({
        type: 'pane.agent_status_changed',
        pane_id,
      })),
    ];

    subHandle = client.subscribe(subscriptions, (ev) => {
      if (stopped) return;
      if (ev?.type === 'subscription_started') return;
      // Any layout/pane event → throttled snapshot refresh
      scheduleStateRefresh();
      // Status events can seal bubbles faster
      const data = ev?.data ?? ev;
      const type = data?.type ?? ev?.type;
      if (type === 'pane_agent_status_changed' || type === 'pane.agent_status_changed') {
        const paneId = data?.pane_id;
        const status = data?.agent_status;
        if (paneId && status) onStatus(paneId, status, Date.now());
      }
    });

    // Detect dead subscription and reconnect
    const check = setInterval(() => {
      if (stopped) {
        clearInterval(check);
        return;
      }
      if (subHandle?.dead) {
        clearInterval(check);
        herdrStatus = 'disconnected';
        publishState(true);
        scheduleReconnect();
      }
    }, 1000);
    // Store on handle for cleanup
    if (subHandle) subHandle._check = check;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (stopped) return;
      try {
        await bootstrapProtocol();
        await refreshSnapshot();
      } catch {
        scheduleReconnect();
      }
    }, RECONNECT_MS);
  }

  function syncOutputLoops(paneIds) {
    const want = new Set(paneIds);
    for (const id of outputLoops.keys()) {
      if (!want.has(id)) {
        outputLoops.delete(id);
      }
    }
    for (const id of want) {
      if (!outputLoops.has(id)) {
        const p = runOutputLoop(id);
        outputLoops.set(id, p);
        p.finally(() => {
          if (outputLoops.get(id) === p) outputLoops.delete(id);
        });
      }
    }
  }

  async function waitOutputOrPoll(paneId) {
    try {
      await client.rpc(
        'events.wait',
        {
          match_event: {
            event: 'pane_output_changed',
            pane_id: paneId,
          },
          timeout_ms: OUTPUT_WAIT_MS,
        },
        { timeoutMs: OUTPUT_WAIT_MS + 2000 }
      );
      return 'changed';
    } catch (err) {
      const code = err?.code;
      if (code === 'unsupported_event_wait_match') {
        // Live herdr 0.7.3: wait only supports agent status matches.
        await sleep(OUTPUT_POLL_FALLBACK_MS, abort?.signal);
        return 'poll';
      }
      if (code === 'timeout') {
        return 'timeout';
      }
      await sleep(1000, abort?.signal);
      return 'error';
    }
  }

  async function readPaneText(paneId) {
    const result = await client.rpc('pane.read', {
      pane_id: paneId,
      source: 'recent',
      lines: 80,
    });
    return result?.read?.text ?? result?.text ?? '';
  }

  async function ingestPaneOutput(paneId) {
    const rt = ensureRuntime(paneId);
    const text = await readPaneText(paneId);
    const newLines = diffNewText(rt.prevText, text);
    rt.prevText = text;
    if (newLines.length) {
      appendTierBLines(paneId, newLines, Date.now());
      // Soft seal if we already have a long open silence after fold rules via timer
    }
    // Tier A incremental
    if (rt.transcriptPath) {
      try {
        const { messages, offset } = await readMessages(rt.transcriptPath, {
          afterOffset: rt.transcriptOffset,
          allowedRoot,
        });
        rt.transcriptOffset = offset;
        rt.tier = 'A';
        for (const m of messages) {
          const ts = m.ts ? Date.parse(m.ts) || Date.now() : Date.now();
          if (m.role === 'agent') {
            pushBubble(paneId, { ts, text: m.text, role: 'agent' });
          } else if (m.role === 'user') {
            pushBubble(paneId, { ts, text: m.text, role: 'user' });
          } else if (m.role === 'system' && m.kind === 'tool') {
            pushBubble(paneId, {
              ts,
              text: m.summary,
              role: 'system',
              kind: 'tool',
              summary: m.summary,
            });
          }
        }
      } catch {
        // Path became invalid — fall back
        rt.tier = 'B';
        rt.transcriptPath = null;
      }
    }
    // Seal open Tier B on long silence
    if (rt.openLines.length && Date.now() - rt.lastLineTs >= 2000) {
      sealOpen(paneId);
    }
    publishState();
  }

  async function runOutputLoop(paneId) {
    // Seed prevText once so first diff is empty (avoid dumping full scrollback as new)
    try {
      const rt = ensureRuntime(paneId);
      if (!rt.prevText) {
        rt.prevText = await readPaneText(paneId);
      }
    } catch {
      /* ignore seed errors */
    }

    while (!stopped && abort && !abort.signal.aborted) {
      // Confirm pane still exists
      const ids = new Set(
        (Array.isArray(snapshot?.panes) ? snapshot.panes : []).map((p) => p.pane_id)
      );
      if (snapshot && !ids.has(paneId)) break;

      await waitOutputOrPoll(paneId);
      if (stopped || abort?.signal.aborted) break;
      try {
        await ingestPaneOutput(paneId);
      } catch {
        await sleep(1000, abort?.signal);
      }
    }
  }

  async function bootstrapProtocol() {
    const pong = await client.rpc('ping');
    protocol = pong?.protocol ?? null;
    protocolMismatch = protocol !== 16;
  }

  async function start() {
    if (!stopped) return;
    stopped = false;
    abort = new AbortController();
    lastSeen = await loadLastSeen(stateDir);

    try {
      await bootstrapProtocol();
      await refreshSnapshot();
    } catch (err) {
      herdrStatus = 'disconnected';
      publicState = buildPublicState();
      scheduleReconnect();
    }

    pollTimer = setInterval(() => {
      if (stopped) return;
      refreshSnapshot().catch(() => {
        herdrStatus = 'disconnected';
        publishState(true);
        scheduleReconnect();
      });
    }, SNAPSHOT_POLL_MS);
    // Allow process exit if only poll remains in tests after stop — unref? No, stop clears it.

    // Silence sealer: periodically seal open Tier B bubbles
    const silenceTimer = setInterval(() => {
      if (stopped) return;
      const now = Date.now();
      for (const [paneId, rt] of paneRuntime) {
        if (rt.openLines.length && now - rt.lastLineTs >= 2000) {
          sealOpen(paneId);
          publishState();
        }
      }
    }, 500);
    silenceTimer.unref?.();
    // stash for stop
    start._silenceTimer = silenceTimer;

    // SSE heartbeat shared
    start._hbTimer = setInterval(() => {
      if (stopped) return;
      sendHeartbeat();
    }, SSE_HEARTBEAT_MS);
  }

  async function stop() {
    stopped = true;
    try {
      abort?.abort();
    } catch {
      /* ignore */
    }
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (start._silenceTimer) {
      clearInterval(start._silenceTimer);
      start._silenceTimer = null;
    }
    if (start._hbTimer) {
      clearInterval(start._hbTimer);
      start._hbTimer = null;
    }
    if (subHandle) {
      if (subHandle._check) clearInterval(subHandle._check);
      try {
        subHandle.close();
      } catch {
        /* ignore */
      }
      subHandle = null;
    }
    for (const [, res] of sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    outputLoops.clear();
    // Give pending rpc timeouts a chance to settle: destroy not available per-call.
  }

  function getState() {
    if (!publicState) publicState = buildPublicState();
    return publicState;
  }

  /**
   * @param {string} paneId
   * @param {{ before?: string|number|null, limit?: number }} [opts]
   */
  async function getMessages(paneId, opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const before =
      opts.before == null || opts.before === ''
        ? null
        : Number(opts.before) || Date.parse(String(opts.before)) || null;

    const rt = ensureRuntime(paneId);
    // Prefer Tier A full read when path known
    if (rt.transcriptPath) {
      try {
        const { messages } = await readMessages(rt.transcriptPath, {
          afterOffset: 0,
          allowedRoot,
        });
        let list = messages.map((m, i) => ({
          id: `a:${paneId}:${i}`,
          ts: m.ts ? Date.parse(m.ts) || 0 : 0,
          role: m.role,
          text: m.text ?? m.summary ?? '',
          kind: m.kind,
          summary: m.summary,
        }));
        if (before != null) list = list.filter((m) => m.ts < before);
        // return latest `limit` messages ascending
        if (list.length > limit) list = list.slice(-limit);
        return list;
      } catch {
        /* fall through to Tier B */
      }
    }

    let list = rt.buffer.slice();
    // Also include unsealed open lines as a draft bubble for visibility
    if (rt.openLines.length) {
      const folded = foldBubbles([
        { ts: rt.openTs ?? Date.now(), lines: rt.openLines },
      ]);
      for (const b of folded) {
        list.push({
          id: `open:${paneId}`,
          ts: b.ts,
          role: 'agent',
          text: b.text,
          sealed: false,
        });
      }
    }
    if (before != null) list = list.filter((m) => (m.ts || 0) < before);
    if (list.length > limit) list = list.slice(-limit);
    return list;
  }

  async function markSeen(paneId) {
    const now = Date.now();
    lastSeen[paneId] = now;
    await atomicWriteJson(stateDir, 'last-seen.json', lastSeen);
    // Flip unread in public state
    publishState(true);
    return { pane_id: paneId, last_seen: now };
  }

  /**
   * @param {import('node:http').ServerResponse} res
   */
  function addSseClient(res) {
    const id = String(++sseSeq);
    sseClients.set(id, res);
    // Initial state event + immediate heartbeat comment (also every 15s).
    const st = getState();
    res.write(`event: state\ndata: ${JSON.stringify(st)}\n\n`);
    res.write(`:${HEARTBEAT_NOTE}\n\n`);
    return id;
  }

  function removeSseClient(id) {
    sseClients.delete(id);
  }

  /**
   * Test helper: force a pane's snapshot status + activity for unread checks.
   * @param {string} paneId
   * @param {string} status
   */
  function forcePaneStatus(paneId, status) {
    if (Array.isArray(snapshot?.panes)) {
      const p = snapshot.panes.find((x) => x.pane_id === paneId);
      if (p) p.agent_status = status;
    }
    const rt = ensureRuntime(paneId);
    rt.lastActivity = Date.now();
    rt.lastStatus = status;
    delete lastSeen[paneId];
    publishState(true);
  }

  return {
    start,
    stop,
    getState,
    getMessages,
    markSeen,
    addSseClient,
    removeSseClient,
    publishState,
    /** test helper */
    _internal: {
      paneRuntime,
      ensureRuntime,
      pushBubble,
      onStatus,
      appendTierBLines,
      sealOpen,
      forcePaneStatus,
    },
  };
}
