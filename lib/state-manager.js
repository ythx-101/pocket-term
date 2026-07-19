/**
 * Bridge state manager: herdr snapshot + event fan-out + Tier A/B bubbles.
 * All herdr I/O goes through lib/herdr-client.js (read whitelist + optional write).
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
/** Per-pane send rate limit window (ms). */
export const SEND_RATE_LIMIT_MS = 2000;
/** Tier A user bubble dedupe window vs optimistic send (±ms). */
export const USER_BUBBLE_DEDUPE_MS = 10000;
/**
 * Tier B stream-bubble redraw dedupe: same trimmed text within this window
 * (and among the last N stream bubbles) is not re-broadcast. Suppresses
 * Claude Code spinner/frame full-redraw spam without blocking legitimate
 * re-runs of the same command after the window.
 */
export const TIER_B_STREAM_DEDUPE_MS = 30000;
/** Max recent stream bubbles scanned for Tier B redraw dedupe. */
export const TIER_B_STREAM_DEDUPE_N = 20;
/**
 * Gap between pane.send_text and bare Enter for mode 'run'.
 * Claude Code paste detection swallows CJK when text+Enter arrive in one write;
 * splitting with a short pause keeps CJK intact.
 */
export const RUN_ENTER_DELAY_MS = 400;

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

/** Default user settings (wallpaper + dim). dim is 0..0.9 fraction. */
export const DEFAULT_SETTINGS = Object.freeze({
  wallpaper: /** @type {string|null} */ (null),
  dim: 0.35,
});

/**
 * Safe wallpaper basename: no path separators/traversal; jpg/png/webp/gif only.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSafeWallpaperName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name !== path.basename(name)) return false;
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..' || name.includes('..')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif)$/i.test(name);
}

/**
 * Normalize/validate a settings payload for POST /herd/api/settings.
 * Only `wallpaper` and `dim` are allowed; unknown keys → error.
 * Partial updates allowed: only present fields are returned in `patch`.
 *
 * @param {unknown} body
 * @returns {
 *   | { ok: true, patch: { wallpaper?: string|null, dim?: number } }
 *   | { ok: false, error: string }
 * }
 */
export function validateSettingsPayload(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_body' };
  }
  const keys = Object.keys(body);
  for (const k of keys) {
    if (k !== 'wallpaper' && k !== 'dim') {
      return { ok: false, error: 'unknown_field' };
    }
  }
  /** @type {{ wallpaper?: string|null, dim?: number }} */
  const patch = {};

  if ('wallpaper' in body) {
    const w = body.wallpaper;
    if (w === null) {
      patch.wallpaper = null;
    } else if (typeof w === 'string' && isSafeWallpaperName(w)) {
      patch.wallpaper = w;
    } else {
      return { ok: false, error: 'invalid_wallpaper' };
    }
  }

  if ('dim' in body) {
    const d = body.dim;
    if (typeof d !== 'number' || !Number.isFinite(d)) {
      return { ok: false, error: 'invalid_dim' };
    }
    if (d < 0 || d > 0.9) {
      return { ok: false, error: 'invalid_dim' };
    }
    patch.dim = Math.round(d * 1000) / 1000;
  }

  return { ok: true, patch };
}

/**
 * Coerce stored JSON into a safe settings object.
 * @param {unknown} raw
 * @returns {{ wallpaper: string|null, dim: number }}
 */
export function normalizeStoredSettings(raw) {
  const base = { wallpaper: null, dim: DEFAULT_SETTINGS.dim };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  if (raw.wallpaper === null) {
    base.wallpaper = null;
  } else if (typeof raw.wallpaper === 'string' && isSafeWallpaperName(raw.wallpaper)) {
    base.wallpaper = raw.wallpaper;
  }
  if (typeof raw.dim === 'number' && Number.isFinite(raw.dim)) {
    const d = Math.min(0.9, Math.max(0, raw.dim));
    base.dim = Math.round(d * 1000) / 1000;
  }
  return base;
}

/**
 * @param {string} dir
 */
async function loadSettingsFile(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'settings.json'), 'utf8');
    return normalizeStoredSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function firstLine(text) {
  if (!text) return '';
  const line = stripAnsi(String(text)).split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim() : '';
}

/** Last non-empty line (for Tier B list summary seed). */
function lastNonEmptyLine(text) {
  if (!text) return '';
  const lines = stripAnsi(String(text)).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t;
  }
  return '';
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
 * Safe session id / filename stem: no path separators or traversal.
 * @param {string} value
 */
function isSafeSessionToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) && value.length > 0;
}

/**
 * Parse pane.agent_session (object or legacy string) into a typed ref.
 * Observed live shape after claude integration:
 *   { agent, kind: 'id'|'path', source: 'herdr:claude', value: '<uuid-or-path>' }
 *
 * @param {object} pane
 * @returns {{ kind: 'path'|'id', value: string } | null}
 */
export function parseAgentSession(pane) {
  if (!pane || typeof pane !== 'object') return null;

  const session = pane.agent_session;
  if (session && typeof session === 'object' && !Array.isArray(session)) {
    const kind = session.kind;
    const value = session.value;
    if (kind === 'path' && typeof value === 'string' && value.length > 0) {
      return { kind: 'path', value };
    }
    if (kind === 'id' && typeof value === 'string' && value.length > 0) {
      return { kind: 'id', value };
    }
    return null;
  }

  // Legacy / alternate string fields
  const stringCandidates = [
    typeof session === 'string' ? session : null,
    pane.agent_session_path,
    pane.session_path,
    typeof pane.agent_session_id === 'string' && pane.agent_session_id.includes('/')
      ? pane.agent_session_id
      : null,
  ];
  for (const c of stringCandidates) {
    if (typeof c === 'string' && c.length > 0) {
      return { kind: 'path', value: c };
    }
  }
  return null;
}

/**
 * Locate `<sessionId>.jsonl` one subdirectory deep under allowedRoot.
 * @param {string} allowedRoot
 * @param {string} sessionId
 * @returns {Promise<string|null>} real path or null
 */
export async function findTranscriptBySessionId(allowedRoot, sessionId) {
  if (!isSafeSessionToken(sessionId)) return null;
  let realRoot;
  try {
    realRoot = path.resolve(await fs.realpath(allowedRoot));
  } catch {
    return null;
  }
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

  let entries;
  try {
    entries = await fs.readdir(realRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    // Skip obvious traversal / hidden noise? still one level only via readdir
    if (ent.name === '.' || ent.name === '..') continue;
    const candidate = path.join(realRoot, ent.name, `${sessionId}.jsonl`);
    try {
      const real = path.resolve(await fs.realpath(candidate));
      if (real === realRoot || real.startsWith(rootPrefix)) {
        const st = await fs.stat(real);
        if (st.isFile()) return real;
      }
    } catch {
      /* not found in this subdir */
    }
  }
  return null;
}

/**
 * Resolve a parseAgentSession ref to a real path under allowedRoot.
 * @param {{ kind: 'path'|'id', value: string }} ref
 * @param {string} [allowedRoot]
 * @returns {Promise<string|null>}
 */
export async function resolveAgentSessionPath(ref, allowedRoot = DEFAULT_ALLOWED_ROOT) {
  if (!ref || !ref.value) return null;
  try {
    if (ref.kind === 'path') {
      return await resolveSafePath(ref.value, allowedRoot);
    }
    if (ref.kind === 'id') {
      const found = await findTranscriptBySessionId(allowedRoot, ref.value);
      if (!found) return null;
      // Re-validate via the same path guard as Tier A reads.
      return await resolveSafePath(found, allowedRoot);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Cache key for a session ref (or empty if none).
 * @param {{ kind: string, value: string } | null} ref
 */
export function agentSessionCacheKey(ref) {
  if (!ref) return '';
  return `${ref.kind}:${ref.value}`;
}

/**
 * Whether Tier B screen-stream bubbles should be generated for this pane runtime.
 * Tier A (resolved transcript) suppresses Tier B to avoid duplicate bubbles.
 * @param {{ tier?: string, transcriptPath?: string|null }} rt
 */
export function shouldEmitTierB(rt) {
  if (!rt) return true;
  if (rt.transcriptPath) return false;
  if (rt.tier === 'A') return false;
  return true;
}

/**
 * Tier A / optimistic user-message dedupe: same pane + same text within ±windowMs.
 * @param {{
 *   buffer?: Array<{ role?: string, text?: string, ts?: number }>,
 *   recentUserSends?: Array<{ text: string, ts: number }>,
 * }} rt
 * @param {string} text
 * @param {number} ts
 * @param {number} [windowMs]
 */
export function isDuplicateUserMessage(rt, text, ts, windowMs = USER_BUBBLE_DEDUPE_MS) {
  if (!rt || typeof text !== 'string') return false;
  const t = Number(ts) || 0;
  const recent = Array.isArray(rt.recentUserSends) ? rt.recentUserSends : [];
  for (const s of recent) {
    if (s.text === text && Math.abs((Number(s.ts) || 0) - t) <= windowMs) {
      return true;
    }
  }
  const buf = Array.isArray(rt.buffer) ? rt.buffer : [];
  for (const b of buf) {
    if (
      b.role === 'user' &&
      b.text === text &&
      Math.abs((Number(b.ts) || 0) - t) <= windowMs
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Tier B stream-bubble redraw dedupe (per pane runtime).
 * Same trimmed text among the last `recentN` stream bubbles within
 * ±windowMs → duplicate (skip broadcast). Does not cross panes; does not
 * block the same content after the window (agent re-ran the command).
 *
 * @param {{
 *   buffer?: Array<{ stream?: boolean, text?: string, ts?: number }>,
 *   recentStreamBroadcasts?: Array<{ text: string, ts: number }>,
 * }} rt
 * @param {string} text
 * @param {number} ts
 * @param {number} [windowMs]
 * @param {number} [recentN]
 */
export function isDuplicateStreamBubble(
  rt,
  text,
  ts,
  windowMs = TIER_B_STREAM_DEDUPE_MS,
  recentN = TIER_B_STREAM_DEDUPE_N
) {
  if (!rt || typeof text !== 'string') return false;
  const norm = text.trim();
  if (!norm) return false;
  const t = Number(ts) || 0;
  const n = Math.max(1, Number(recentN) || TIER_B_STREAM_DEDUPE_N);

  const recent = Array.isArray(rt.recentStreamBroadcasts)
    ? rt.recentStreamBroadcasts
    : [];
  for (let i = recent.length - 1, seen = 0; i >= 0 && seen < n; i--, seen++) {
    const s = recent[i];
    if (
      s &&
      String(s.text ?? '').trim() === norm &&
      Math.abs((Number(s.ts) || 0) - t) <= windowMs
    ) {
      return true;
    }
  }

  const buf = Array.isArray(rt.buffer) ? rt.buffer : [];
  let scanned = 0;
  for (let i = buf.length - 1; i >= 0 && scanned < n; i--) {
    const b = buf[i];
    if (!b || b.stream !== true) continue;
    scanned++;
    if (
      String(b.text ?? '').trim() === norm &&
      Math.abs((Number(b.ts) || 0) - t) <= windowMs
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @param {{
 *   client?: ReturnType<typeof createClient>,
 *   stateDir: string,
 *   allowedRoot?: string,
 *   socketPath?: string,
 *   allowWrite?: boolean,
 *   readonly?: boolean,
 *   runEnterDelayMs?: number,
 *   onNotifyStatus?: (event: { paneId: string, status: 'blocked'|'done', title: string }) => Promise<unknown>|unknown,
 * }} options
 */
export function createStateManager(options) {
  const readonly = options.readonly === true;
  const allowWrite = options.allowWrite === true && !readonly;
  const client =
    options.client ??
    createClient({
      socketPath: options.socketPath,
      timeoutMs: 5000,
      allowWrite,
    });
  const stateDir = options.stateDir;
  const allowedRoot = options.allowedRoot ?? DEFAULT_ALLOWED_ROOT;
  const onNotifyStatus = typeof options.onNotifyStatus === 'function' ? options.onNotifyStatus : null;
  const pushLastEmitted = new Map();
  const runEnterDelayMs =
    typeof options.runEnterDelayMs === 'number' && options.runEnterDelayMs >= 0
      ? options.runEnterDelayMs
      : RUN_ENTER_DELAY_MS;
  /** Allow tests to shorten dead-handle reconnect delay (prod default RECONNECT_MS). */
  const reconnectMs =
    typeof options.reconnectMs === 'number' && options.reconnectMs >= 0
      ? options.reconnectMs
      : RECONNECT_MS;

  /** @type {Map<string, import('node:http').ServerResponse>} */
  const sseClients = new Map();
  let sseSeq = 0;

  /** @type {Map<string, object>} */
  const paneRuntime = new Map();

  /** pane_id → last successful send timestamp (ms) */
  /** @type {Map<string, number>} */
  const lastSendAt = new Map();

  /** @type {Record<string, number>} */
  let lastSeen = {};

  /** @type {{ wallpaper: string|null, dim: number }} */
  let settings = { ...DEFAULT_SETTINGS };

  let protocol = null;
  let protocolMismatch = false;
  /** @type {string|null} herdr version from ping (e.g. "0.7.3") */
  let herdrVersion = null;
  let herdrStatus = 'disconnected';
  /** @type {object|null} */
  let snapshot = null;
  /** @type {object|null} */
  let publicState = null;
  let lastStateJson = '';

  /** @type {ReturnType<ReturnType<typeof createClient>['subscribe']>|null} */
  let subHandle = null;
  /**
   * Sorted pane-id key for the active events.subscribe set.
   * `null` is a needs-rebuild sentinel (never equals a real key — including
   * the empty-pane key `''`). H1 residual: resetting to `''` on reconnect
   * skipped rebuild when the snapshot also had zero panes.
   * @type {string|null}
   */
  let subPaneKey = null;
  let throttleTimer = null;
  let pollTimer = null;
  let reconnectTimer = null;
  let stopped = true;
  /** @type {AbortController|null} */
  let abort = null;
  /** @type {Map<string, Promise<void>>} */
  const outputLoops = new Map();
  /** @type {Set<Promise<unknown>>} in-flight session.snapshot (and similar) RPCs */
  const inFlightSnapshots = new Set();

  /**
   * Drop sealed Tier B stream cards + open draft lines when entering Tier A.
   * M4: also SSE-broadcast `purge` so open clients drop their stream cards.
   * @param {ReturnType<typeof ensureRuntime>} rt
   * @param {string} [paneId]
   */
  function purgeTierBBuffer(rt, paneId) {
    if (!rt) return;
    rt.openLines = [];
    rt.openTs = null;
    if (Array.isArray(rt.buffer) && rt.buffer.length) {
      rt.buffer = rt.buffer.filter((b) => b.stream !== true);
    }
    if (paneId) {
      broadcast('purge', { pane_id: paneId });
    }
  }

  /**
   * Track a snapshot RPC so stop() can abort+await it.
   * Returns the original promise (callers await that for real errors).
   * The .finally() side-chain re-rejects on failure — attach .catch so abort
   * during stop() is not an unhandledRejection.
   * @param {Promise<unknown>} promise
   * @returns {Promise<unknown>}
   */
  function trackSnapshotRpc(promise) {
    inFlightSnapshots.add(promise);
    promise
      .finally(() => {
        inFlightSnapshots.delete(promise);
      })
      .catch((err) => {
        // Side-chain only: swallow abort-path so process does not exit nonzero.
        // Real errors still surface via `await promise` in refreshSnapshot.
        if (err?.code === 'aborted' || err?.name === 'AbortError') return;
        // Non-abort rejections on this chain are also handled here (reporting
        // is owned by the await path on `promise`); do not rethrow.
      });
    return promise;
  }

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
        /** @type {string} cache key of last resolved agent_session ref */
        sessionCacheKey: '',
        tier: 'B',
        summary: '',
        lastActivity: 0,
        /** @type {Array<{ text: string, ts: number }>} optimistic user sends for Tier A dedupe */
        recentUserSends: [],
        /** @type {Array<{ text: string, ts: number }>} recent Tier B stream broadcasts for redraw dedupe */
        recentStreamBroadcasts: [],
        /** Monotonic bubble id seq — never rewinds when buffer is trimmed (M3). */
        bubbleSeq: 0,
      };
      paneRuntime.set(paneId, rt);
    }
    if (typeof rt.bubbleSeq !== 'number') rt.bubbleSeq = 0;
    return rt;
  }

  /**
   * @param {string} paneId
   * @returns {boolean}
   */
  function paneExists(paneId) {
    const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
    return panes.some((p) => p.pane_id === paneId);
  }

  /**
   * Rate-limit check for send (read-only; does not reserve).
   * @param {string} paneId
   * @param {number} [now]
   * @returns {{ ok: true } | { ok: false, retryAfterSec: number, retryAfterMs: number }}
   */
  function checkSendRate(paneId, now = Date.now()) {
    const prev = lastSendAt.get(paneId);
    if (prev == null) return { ok: true };
    const elapsed = now - prev;
    if (elapsed >= SEND_RATE_LIMIT_MS) return { ok: true };
    const retryAfterMs = SEND_RATE_LIMIT_MS - elapsed;
    return {
      ok: false,
      retryAfterMs,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  /**
   * Atomically check + reserve the per-pane 2s send window (sync; no await gap).
   * Callers must release on failure so a failed send does not consume the window.
   *
   * @param {string} paneId
   * @param {number} [now]
   * @returns {
   *   | { ok: true, reservedAt: number, prev: number|undefined }
   *   | { ok: false, retryAfterSec: number, retryAfterMs: number }
   * }
   */
  function tryReserveSend(paneId, now = Date.now()) {
    const rate = checkSendRate(paneId, now);
    if (!rate.ok) return rate;
    const prev = lastSendAt.get(paneId);
    lastSendAt.set(paneId, now);
    return { ok: true, reservedAt: now, prev };
  }

  /**
   * Roll back a reservation if it is still the active slot (failed herdr send).
   * @param {string} paneId
   * @param {{ reservedAt: number, prev: number|undefined }} reservation
   */
  function releaseSendReservation(paneId, reservation) {
    if (!reservation || lastSendAt.get(paneId) !== reservation.reservedAt) {
      return;
    }
    if (reservation.prev == null) {
      lastSendAt.delete(paneId);
    } else {
      lastSendAt.set(paneId, reservation.prev);
    }
  }

  /**
   * Directed send to a pane (optimistic user bubble + herdr write).
   * Caller must enforce origin/body/readonly guards.
   *
   * @param {string} paneId
   * @param {string} text
   * @param {'run'|'text'} [mode]
   * @returns {Promise<
   *   | { ok: true, sent: true }
   *   | { ok: false, status: number, error: string, retryAfterSec?: number }
   * >}
   */
  async function sendToPane(paneId, text, mode = 'run') {
    if (readonly) {
      return { ok: false, status: 403, error: 'readonly' };
    }
    if (!paneExists(paneId)) {
      return { ok: false, status: 404, error: 'pane_not_found' };
    }
    // Reserve before any await so concurrent sends cannot both pass the window.
    // Reservation spans the whole two-step run path (send_text + delay + Enter).
    const reservation = tryReserveSend(paneId);
    if (!reservation.ok) {
      return {
        ok: false,
        status: 429,
        error: 'rate_limited',
        retryAfterSec: reservation.retryAfterSec,
      };
    }

    const displayText = typeof text === 'string' ? text : String(text ?? '');
    const sendMode = mode === 'text' ? 'text' : 'run';
    // L10: track whether run-mode text was typed into the pane before Enter.
    // If Enter fails, clear the line so a retry does not double-type.
    let typedIntoPane = false;

    try {
      if (sendMode === 'text') {
        await client.rpc('pane.send_text', {
          pane_id: paneId,
          text: displayText,
        });
      } else if (!displayText) {
        // Empty run = pure Enter (confirm hotkey / 回车 button).
        // Socket has no pane.run; only bare Enter via send_keys.
        await client.rpc('pane.send_keys', {
          pane_id: paneId,
          keys: ['enter'],
        });
      } else {
        // Two-step: type text, pause, bare Enter. Bundling text+Enter in one
        // write trips Claude Code paste detection and drops CJK.
        // pane.run is CLI sugar only — wire uses send_text then send_keys Enter.
        await client.rpc('pane.send_text', {
          pane_id: paneId,
          text: displayText,
        });
        typedIntoPane = true;
        await sleep(runEnterDelayMs);
        await client.rpc('pane.send_keys', {
          pane_id: paneId,
          keys: ['enter'],
        });
      }
    } catch (err) {
      releaseSendReservation(paneId, reservation);
      // L10 reason for (a) clear line vs (b) keep rate slot:
      // send_keys whitelist is enter-only, so we clear via send_text Ctrl+U
      // (\x15) — same control-char path as UI Ctrl+C. Clearing is better than
      // holding the rate slot: user can retry immediately without duplicated text.
      if (typedIntoPane) {
        try {
          await client.rpc('pane.send_text', {
            pane_id: paneId,
            text: '\x15',
          });
        } catch {
          /* best-effort clear; surface original send error */
        }
      }
      const code = err?.code || 'send_failed';
      if (code === 'pane_not_found') {
        return { ok: false, status: 404, error: 'pane_not_found' };
      }
      return {
        ok: false,
        status: 502,
        error: err?.message || code || 'send_failed',
      };
    }

    const ts = reservation.reservedAt;
    const rt = ensureRuntime(paneId);
    if (!Array.isArray(rt.recentUserSends)) rt.recentUserSends = [];
    rt.recentUserSends.push({ text: displayText, ts });
    rt.recentUserSends = rt.recentUserSends.filter(
      (s) => Date.now() - (Number(s.ts) || 0) <= USER_BUBBLE_DEDUPE_MS + 5000
    );
    pushBubble(paneId, { ts, text: displayText, role: 'user' });
    publishState();
    return { ok: true, sent: true };
  }

  /**
   * Resolve Tier A transcript path for a pane; cache per pane+session ref.
   * @param {object} pane
   */
  async function resolvePaneTranscript(pane) {
    const rt = ensureRuntime(pane.pane_id);
    const ref = parseAgentSession(pane);
    const cacheKey = agentSessionCacheKey(ref);
    if (!ref) {
      rt.sessionCacheKey = '';
      rt.transcriptPath = null;
      rt.tier = 'B';
      return null;
    }
    if (rt.sessionCacheKey === cacheKey && rt.transcriptPath) {
      // Re-validate cached path still under root and exists.
      try {
        await resolveSafePath(rt.transcriptPath, allowedRoot);
        const st = await fs.stat(rt.transcriptPath);
        if (st.isFile()) {
          rt.tier = 'A';
          // Never keep Tier B stream cards once A is confirmed.
          purgeTierBBuffer(rt, pane.pane_id);
          return rt.transcriptPath;
        }
      } catch {
        /* fall through to re-resolve */
      }
    }
    const resolved = await resolveAgentSessionPath(ref, allowedRoot);
    rt.sessionCacheKey = cacheKey;
    rt.transcriptPath = resolved;
    rt.tier = resolved ? 'A' : 'B';
    if (resolved) {
      // Drop pending open lines + already-sealed Tier B bubbles on A transition.
      purgeTierBBuffer(rt, pane.pane_id);
    }
    return resolved;
  }

  function pushBubble(paneId, bubble) {
    const rt = ensureRuntime(paneId);
    const seq = ++rt.bubbleSeq;
    const entry = {
      // M3: use monotonic seq (not buffer.length) so ids stay unique past BUBBLE_LIMIT.
      id: `${paneId}:${bubble.ts}:${seq}`,
      ts: bubble.ts,
      text: bubble.text,
      role: bubble.role ?? 'agent',
      kind: bubble.kind,
      summary: bubble.summary,
      stream: bubble.stream === true,
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
    if (!Array.isArray(rt.recentStreamBroadcasts)) {
      rt.recentStreamBroadcasts = [];
    }
    for (const b of folded) {
      const ts = Number(b.ts) || Date.now();
      const text = typeof b.text === 'string' ? b.text : String(b.text ?? '');
      // Tier B redraw dedupe: skip same body re-sealed within the window.
      if (isDuplicateStreamBubble(rt, text, ts)) {
        continue;
      }
      rt.recentStreamBroadcasts.push({ text: text.trim(), ts });
      while (rt.recentStreamBroadcasts.length > TIER_B_STREAM_DEDUPE_N) {
        rt.recentStreamBroadcasts.shift();
      }
      // Tier B screen-stream cards → mono wide bubbles in SPA
      pushBubble(paneId, { ...b, ts, text, role: 'agent', stream: true });
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
    const previous = rt.lastStatus;
    if (
      rt.lastStatus === 'working' &&
      (status === 'idle' || status === 'done')
    ) {
      sealOpen(paneId);
    }
    rt.lastStatus = status;
    rt.lastActivity = Math.max(rt.lastActivity, ts);
    if (onNotifyStatus && previous != null && previous !== status && (status === 'blocked' || status === 'done')) {
      const key = `${paneId}\u0000${status}`;
      const last = pushLastEmitted.get(key);
      if (last == null || ts - last >= 60_000) {
        pushLastEmitted.set(key, ts);
        Promise.resolve(onNotifyStatus({ paneId, status, title: rt.summary || paneId })).catch((err) => {
          console.error(`push dispatch failed: ${err?.name || 'Error'}`);
        });
      }
    }
  }

  /**
   * @param {string} event
   * @param {unknown} data
   */
  function broadcast(event, data) {
    const payload =
      event === 'state' || event === 'bubble' || event === 'purge'
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
      herdr_version: herdrVersion,
      protocol,
      protocol_mismatch: protocolMismatch,
      readonly,
      settings: {
        wallpaper: settings.wallpaper,
        dim: settings.dim,
      },
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
    if (stopped || abort?.signal.aborted) return;
    const rpcPromise = client.rpc(
      'session.snapshot',
      {},
      { signal: abort?.signal }
    );
    trackSnapshotRpc(rpcPromise);
    let result;
    try {
      result = await rpcPromise;
    } catch (err) {
      if (err?.code === 'aborted' || stopped) return;
      throw err;
    }
    if (stopped || abort?.signal.aborted) return;
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
      // Tier A path detection (object agent_session + legacy string)
      await resolvePaneTranscript(p);
    }

    // Drop closed panes' output loops (buffers kept until GC of map optionally)
    for (const id of prevIds) {
      if (!nextIds.has(id)) {
        // stop loop by aborting shared controller restart handled below
      }
    }

    publishState();

    const key = [...nextIds].sort().join(',');
    // null sentinel ⇒ always rebuild (reconnect / first start)
    if (subPaneKey === null || key !== subPaneKey) {
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
    // H1: dead-detect / poll-fail reconnect must force rebuildSubscription even
    // when the pane set is unchanged. Use null (never equals a real key,
    // including empty-pane `''`) so zero-pane reconnect still rebuilds.
    subPaneKey = null;
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
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (stopped) return;
      try {
        await bootstrapProtocol();
        await refreshSnapshot();
        await seedInitialPaneState();
      } catch {
        scheduleReconnect();
      }
    }, reconnectMs);
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
    if (stopped || abort?.signal.aborted) return 'aborted';
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
        { timeoutMs: OUTPUT_WAIT_MS + 2000, signal: abort?.signal }
      );
      return 'changed';
    } catch (err) {
      const code = err?.code;
      if (code === 'aborted') return 'aborted';
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
    const result = await client.rpc(
      'pane.read',
      {
        pane_id: paneId,
        source: 'recent',
        lines: 80,
      },
      { signal: abort?.signal }
    );
    return result?.read?.text ?? result?.text ?? '';
  }

  async function ingestPaneOutput(paneId) {
    const rt = ensureRuntime(paneId);
    const text = await readPaneText(paneId);
    const newLines = diffNewText(rt.prevText, text);
    rt.prevText = text;

    const emitB = shouldEmitTierB(rt);
    // Tier B screen stream only while Tier A is unresolved / inactive.
    if (emitB && newLines.length) {
      appendTierBLines(paneId, newLines, Date.now());
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
        // Clear any accidental Tier B open buffer once A is confirmed.
        rt.openLines = [];
        rt.openTs = null;
        for (const m of messages) {
          const ts = m.ts ? Date.parse(m.ts) || Date.now() : Date.now();
          if (m.role === 'agent') {
            pushBubble(paneId, { ts, text: m.text, role: 'agent' });
          } else if (m.role === 'user') {
            // Tier A dedupe: skip transcript user msg that matches optimistic send ±10s
            if (isDuplicateUserMessage(rt, m.text ?? '', ts)) {
              continue;
            }
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
    // Seal open Tier B on long silence (Tier A panes skip)
    if (
      shouldEmitTierB(rt) &&
      rt.openLines.length &&
      Date.now() - rt.lastLineTs >= 2000
    ) {
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

      const waitResult = await waitOutputOrPoll(paneId);
      if (waitResult === 'aborted' || stopped || abort?.signal.aborted) break;
      try {
        await ingestPaneOutput(paneId);
      } catch (err) {
        if (err?.code === 'aborted' || stopped || abort?.signal.aborted) break;
        await sleep(1000, abort?.signal);
      }
    }
  }

  async function bootstrapProtocol() {
    const pong = await client.rpc('ping');
    protocol = pong?.protocol ?? null;
    protocolMismatch = protocol !== 16;
    // Capture once from the existing ping — do not issue an extra RPC.
    if (typeof pong?.version === 'string' && pong.version) {
      herdrVersion = pong.version;
    } else if (pong?.version != null) {
      herdrVersion = String(pong.version);
    }
  }

  /**
   * First pane.read per pane at startup/reconnect: seed prevText, list summary,
   * and last_activity so the session list is not empty before the first event.
   * Tier A: prefer last agent line from transcript; advance offset to EOF so
   * history is not re-broadcast as brand-new SSE bubbles.
   */
  async function seedInitialPaneState() {
    const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
    const now = Date.now();
    await Promise.all(
      panes.map(async (p) => {
        if (stopped || abort?.signal.aborted) return;
        const paneId = p.pane_id;
        if (!paneId) return;
        const rt = ensureRuntime(paneId);
        try {
          const text = await readPaneText(paneId);
          if (!rt.prevText) rt.prevText = text;

          if (rt.transcriptPath) {
            try {
              // L8: use the offset returned by readMessages (bytes actually read).
              // A second fs.stat after the read can observe a larger size if the
              // agent appended mid-seed — that would skip those lines forever.
              const { messages, offset } = await readMessages(rt.transcriptPath, {
                afterOffset: 0,
                allowedRoot,
              });
              const agents = messages.filter((m) => m.role === 'agent' && m.text);
              const last = agents[agents.length - 1];
              if (last?.text) {
                rt.summary = firstLine(last.text).slice(0, 200);
              }
              // Skip replaying full history as "new" bubbles on first poll.
              if (rt.transcriptOffset === 0) {
                rt.transcriptOffset = offset;
              }
            } catch {
              /* fall through to screen summary */
            }
          }

          if (!rt.summary) {
            const line = lastNonEmptyLine(text);
            if (line) rt.summary = line.slice(0, 200);
          }
          if (!rt.lastActivity) {
            rt.lastActivity = now;
          }
        } catch {
          /* seed best-effort */
        }
      })
    );
    publishState(true);
  }

  async function start() {
    if (!stopped) return;
    stopped = false;
    abort = new AbortController();
    lastSeen = await loadLastSeen(stateDir);
    settings = await loadSettingsFile(stateDir);

    try {
      await bootstrapProtocol();
      if (stopped) return;
      await refreshSnapshot();
      if (stopped) return;
      await seedInitialPaneState();
    } catch (err) {
      if (stopped) return;
      herdrStatus = 'disconnected';
      publicState = buildPublicState();
      scheduleReconnect();
    }

    // stop() may have raced during bootstrap — do not arm timers/loops.
    if (stopped) return;

    pollTimer = setInterval(() => {
      if (stopped) return;
      refreshSnapshot().catch(() => {
        if (stopped) return;
        herdrStatus = 'disconnected';
        publishState(true);
        scheduleReconnect();
      });
    }, SNAPSHOT_POLL_MS);
    // Allow process exit if only poll remains in tests after stop — unref? No, stop clears it.

    // Silence sealer: periodically seal open Tier B bubbles (skip Tier A)
    const silenceTimer = setInterval(() => {
      if (stopped) return;
      const now = Date.now();
      for (const [paneId, rt] of paneRuntime) {
        if (!shouldEmitTierB(rt)) continue;
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

    // Snapshot pending work *before* abort so handlers are attached first
    // (avoids unhandledRejection races on mid-flight session.snapshot).
    const pending = [
      ...outputLoops.values(),
      ...inFlightSnapshots,
    ];
    outputLoops.clear();
    inFlightSnapshots.clear();
    const pendingWait =
      pending.length > 0 ? Promise.allSettled(pending) : Promise.resolve([]);

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

    await pendingWait;
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
    // Draft Tier B open lines only when Tier A is not active
    if (shouldEmitTierB(rt) && rt.openLines.length) {
      const folded = foldBubbles([
        { ts: rt.openTs ?? Date.now(), lines: rt.openLines },
      ]);
      for (const b of folded) {
        list.push({
          id: `open:${paneId}`,
          ts: b.ts,
          role: 'agent',
          text: b.text,
          stream: true,
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
   * @returns {{ wallpaper: string|null, dim: number }}
   */
  function getSettings() {
    return { wallpaper: settings.wallpaper, dim: settings.dim };
  }

  /**
   * Merge + persist settings. Caller validates payload first (or pass raw body).
   * When wallpaper is a non-null name, optional `wallpaperExists` checks the file.
   *
   * @param {unknown} body
   * @param {{ wallpaperExists?: (name: string) => Promise<boolean> }} [opts]
   * @returns {Promise<
   *   | { ok: true, settings: { wallpaper: string|null, dim: number } }
   *   | { ok: false, status: number, error: string }
   * >}
   */
  async function updateSettings(body, opts = {}) {
    const validated = validateSettingsPayload(body);
    if (!validated.ok) {
      return { ok: false, status: 400, error: validated.error };
    }
    const patch = validated.patch;
    if (
      patch.wallpaper != null &&
      typeof opts.wallpaperExists === 'function'
    ) {
      const exists = await opts.wallpaperExists(patch.wallpaper);
      if (!exists) {
        return { ok: false, status: 400, error: 'wallpaper_not_found' };
      }
    }
    const next = {
      wallpaper:
        'wallpaper' in patch ? patch.wallpaper ?? null : settings.wallpaper,
      dim: 'dim' in patch && patch.dim != null ? patch.dim : settings.dim,
    };
    settings = next;
    await atomicWriteJson(stateDir, 'settings.json', settings);
    publishState(true);
    return { ok: true, settings: getSettings() };
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
    getSettings,
    updateSettings,
    sendToPane,
    paneExists,
    checkSendRate,
    addSseClient,
    removeSseClient,
    publishState,
    readonly,
    allowWrite,
    /** test helper */
    _internal: {
      paneRuntime,
      ensureRuntime,
      pushBubble,
      onStatus,
      appendTierBLines,
      sealOpen,
      forcePaneStatus,
      resolvePaneTranscript,
      parseAgentSession,
      ingestPaneOutput,
      shouldEmitTierB,
      isDuplicateUserMessage,
      isDuplicateStreamBubble,
      lastSendAt,
      pushLastEmitted,
      tryReserveSend,
      releaseSendReservation,
      outputLoops,
      inFlightSnapshots,
      seedInitialPaneState,
      purgeTierBBuffer,
      get settings() {
        return settings;
      },
      setSettings(next) {
        settings = normalizeStoredSettings(next);
      },
      /** @param {object|null} snap */
      setSnapshot(snap) {
        snapshot = snap;
      },
    },
  };
}
