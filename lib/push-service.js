/** Web Push subscription persistence and delivery boundary. */
import fs from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';

export const PUSH_STATE_FILE = 'push-subscriptions.json';
export const PUSH_BODY_MAX_BYTES = 16 * 1024;
export const PUSH_PAYLOAD_MAX_BYTES = 3000;

function isBase64Url(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Normalize Me-page Web Push toggles. Absent / non-false → enabled.
 * @param {unknown} raw
 * @returns {{ blocked: boolean, done: boolean }}
 */
export function normalizePushPrefs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { blocked: true, done: true };
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  return {
    blocked: o.blocked !== false,
    done: o.done !== false,
  };
}

export function validatePushSubscription(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid_subscription' };
  const endpoint = raw.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return { ok: false, error: 'invalid_endpoint' };
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password) return { ok: false, error: 'invalid_endpoint' };
  } catch {
    return { ok: false, error: 'invalid_endpoint' };
  }
  const keys = raw.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return { ok: false, error: 'invalid_keys' };
  if (!isBase64Url(keys.p256dh) || !isBase64Url(keys.auth, 128)) return { ok: false, error: 'invalid_keys' };
  const expirationTime = raw.expirationTime == null ? null : Number(raw.expirationTime);
  if (expirationTime != null && (!Number.isFinite(expirationTime) || expirationTime < 0)) {
    return { ok: false, error: 'invalid_expiration' };
  }
  return {
    ok: true,
    subscription: { endpoint, expirationTime, keys: { p256dh: keys.p256dh, auth: keys.auth } },
  };
}

async function atomicWritePrivate(stateDir, subscriptions) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, PUSH_STATE_FILE);
  const tmp = path.join(stateDir, `.${PUSH_STATE_FILE}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ subscriptions }, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, target);
  await fs.chmod(target, 0o600);
}

/**
 * @param {string} stateDir
 * @returns {Promise<Array<{ endpoint: string, expirationTime: number|null, keys: object, prefs: { blocked: boolean, done: boolean } }>>}
 */
async function loadSubscriptions(stateDir) {
  try {
    const body = JSON.parse(await fs.readFile(path.join(stateDir, PUSH_STATE_FILE), 'utf8'));
    if (!Array.isArray(body?.subscriptions)) return [];
    /** @type {Array<{ endpoint: string, expirationTime: number|null, keys: object, prefs: { blocked: boolean, done: boolean } }>} */
    const out = [];
    for (const raw of body.subscriptions) {
      const checked = validatePushSubscription(raw);
      if (!checked.ok) continue;
      out.push({
        ...checked.subscription,
        prefs: normalizePushPrefs(raw?.prefs),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function pushConfigFromEnv(env = process.env) {
  const subject = String(env.PT2_VAPID_SUBJECT || '').trim();
  const publicKey = String(env.PT2_VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(env.PT2_VAPID_PRIVATE_KEY || '').trim();
  return { configured: Boolean(subject && publicKey && privateKey), subject, publicKey, privateKey };
}

export async function createPushService({ stateDir, config = pushConfigFromEnv(), sender } = {}) {
  if (!stateDir) throw new Error('stateDir required');
  let subscriptions = await loadSubscriptions(stateDir);
  let writeChain = Promise.resolve();
  const send = sender ?? ((subscription, payload) => webpush.sendNotification(subscription, payload));
  if (config.configured && !sender) webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  function persist() {
    // A failed write must reject its caller without poisoning all later writes.
    writeChain = writeChain.catch(() => {}).then(() => atomicWritePrivate(stateDir, subscriptions));
    return writeChain;
  }

  /**
   * Strip prefs before handing the record to web-push (vendor only wants endpoint+keys).
   * @param {{ endpoint: string, expirationTime?: number|null, keys: object, prefs?: object }} entry
   */
  function vendorSubscription(entry) {
    return {
      endpoint: entry.endpoint,
      expirationTime: entry.expirationTime ?? null,
      keys: entry.keys,
    };
  }

  async function subscribe(raw) {
    if (!config.configured) return { ok: false, status: 503, error: 'push_not_configured' };
    const checked = validatePushSubscription(raw);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    // Prefer explicit prefs; fall back to top-level blocked/done if present.
    const prefsSource =
      raw && typeof raw === 'object' && raw.prefs != null
        ? raw.prefs
        : raw && typeof raw === 'object'
          ? { blocked: raw.blocked, done: raw.done }
          : null;
    const prefs = normalizePushPrefs(prefsSource);
    subscriptions = subscriptions.filter((s) => s.endpoint !== checked.subscription.endpoint);
    subscriptions.push({ ...checked.subscription, prefs });
    await persist();
    return { ok: true, created: true };
  }

  async function unsubscribe(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) return { ok: false, status: 400, error: 'invalid_endpoint' };
    const before = subscriptions.length;
    subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
    if (subscriptions.length !== before) await persist();
    return { ok: true, deleted: subscriptions.length !== before };
  }

  /**
   * Update blocked/done prefs for an existing subscription (Me-page toggles).
   * @param {string} endpoint
   * @param {unknown} prefsRaw
   */
  async function updatePrefs(endpoint, prefsRaw) {
    if (!config.configured) return { ok: false, status: 503, error: 'push_not_configured' };
    if (typeof endpoint !== 'string' || endpoint.length > 2048) {
      return { ok: false, status: 400, error: 'invalid_endpoint' };
    }
    const prefs = normalizePushPrefs(prefsRaw);
    const idx = subscriptions.findIndex((s) => s.endpoint === endpoint);
    if (idx < 0) return { ok: false, status: 404, error: 'not_found' };
    subscriptions[idx] = { ...subscriptions[idx], prefs };
    await persist();
    return { ok: true };
  }

  async function dispatch(event) {
    if (!config.configured || !subscriptions.length) return { sent: 0, failed: 0, pruned: 0 };
    const status = event?.status === 'blocked' ? 'blocked' : 'done';
    const paneId = String(event?.paneId || '').slice(0, 256);
    const title = status === 'blocked' ? 'Pocket Term · 等你回复' : 'Pocket Term · 已完成';
    const fixed = {
      title,
      tag: `pt2-${paneId}-${status}`.slice(0, 180),
      url: `/herd/#/chat/${encodeURIComponent(paneId)}`,
      status,
    };
    const bodyChars = Array.from(String(event?.title || paneId || 'Agent 会话'));
    let low = 0;
    let high = bodyChars.length;
    let payload = JSON.stringify({ ...fixed, body: '' });
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const body = bodyChars.slice(0, mid).join('') + (mid < bodyChars.length ? '…' : '');
      const candidate = JSON.stringify({ ...fixed, body });
      if (Buffer.byteLength(candidate) <= PUSH_PAYLOAD_MAX_BYTES) {
        payload = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const expired = new Set();
    let sent = 0;
    let failed = 0;
    await Promise.all(
      subscriptions.map(async (subscription) => {
        const prefs = normalizePushPrefs(subscription.prefs);
        // H2: Me-page toggles gate Web Push per status.
        if (status === 'blocked' && prefs.blocked === false) return;
        if (status === 'done' && prefs.done === false) return;
        try {
          await send(vendorSubscription(subscription), payload);
          sent += 1;
        } catch (err) {
          failed += 1;
          if (err?.statusCode === 404 || err?.statusCode === 410) expired.add(subscription.endpoint);
        }
      })
    );
    if (expired.size) {
      subscriptions = subscriptions.filter((s) => !expired.has(s.endpoint));
      await persist();
    }
    return { sent, failed, pruned: expired.size };
  }

  return {
    configured: config.configured,
    publicKey: config.configured ? config.publicKey : null,
    subscribe,
    unsubscribe,
    updatePrefs,
    dispatch,
    _count: () => subscriptions.length,
  };
}
