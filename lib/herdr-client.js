/**
 * herdr Unix-socket client (M1: read-only + optional directed send).
 * Wire: newline-delimited JSON RPC over AF_UNIX.
 * Methods outside the active whitelist never reach the socket.
 */
import net from 'node:net';
import { randomUUID } from 'node:crypto';

/** @type {readonly string[]} */
export const READ_ONLY_METHODS = Object.freeze([
  'ping',
  'session.snapshot',
  'pane.read',
  'events.subscribe',
  'events.wait',
]);

/**
 * Directed write methods (pane-targeted send only).
 * Allowed only when createClient({ allowWrite: true }).
 * Note: socket has no `pane.run`; the client maps it to pane.send_text + Enter.
 * @type {readonly string[]}
 */
export const WRITE_METHODS = Object.freeze(['pane.send_text', 'pane.run']);

export const DEFAULT_SOCKET_PATH = '/root/.config/herdr/herdr.sock';

const DEFAULT_TIMEOUT_MS = 5000;

export class HerdrError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'HerdrError';
    this.code = code;
  }
}

/**
 * @param {string} method
 * @param {boolean} allowWrite
 */
function assertWhitelisted(method, allowWrite) {
  if (READ_ONLY_METHODS.includes(method)) return;
  if (allowWrite && WRITE_METHODS.includes(method)) return;
  throw new HerdrError(
    'method_not_allowed',
    `Method not on ${allowWrite ? 'read+write' : 'read-only'} whitelist: ${method}`
  );
}

/**
 * Map client-level pane.run → wire pane.send_text with trailing Enter.
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {{ method: string, params: Record<string, unknown> }}
 */
export function mapWriteMethod(method, params = {}) {
  if (method !== 'pane.run') {
    return { method, params };
  }
  const raw =
    typeof params.text === 'string'
      ? params.text
      : typeof params.command === 'string'
        ? params.command
        : '';
  const text = raw.endsWith('\n') ? raw : `${raw}\n`;
  const next = { ...params, text };
  delete next.command;
  return { method: 'pane.send_text', params: next };
}

/**
 * @param {{
 *   socketPath?: string,
 *   timeoutMs?: number,
 *   allowWrite?: boolean,
 * }} [options]
 */
export function createClient(options = {}) {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowWrite = options.allowWrite === true;

  /**
   * One connection, one request. Returns `result`; throws HerdrError on error/timeout.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [callOpts]
   * @returns {Promise<unknown>}
   */
  function rpc(method, params = {}, callOpts = {}) {
    // Always return a Promise so callers can use assert.rejects / .catch uniformly.
    try {
      assertWhitelisted(method, allowWrite);
    } catch (err) {
      return Promise.reject(err);
    }

    const mapped = mapWriteMethod(method, params);
    const wireMethod = mapped.method;
    const wireParams = mapped.params;

    const signal = callOpts.signal;
    if (signal?.aborted) {
      return Promise.reject(new HerdrError('aborted', `RPC ${method} aborted`));
    }

    const callTimeout =
      typeof callOpts.timeoutMs === 'number' ? callOpts.timeoutMs : timeoutMs;

    const id = randomUUID();
    const line = JSON.stringify({ id, method: wireMethod, params: wireParams }) + '\n';

    return new Promise((resolve, reject) => {
      /** @type {import('node:net').Socket} */
      const socket = net.createConnection(socketPath);
      let buffer = '';
      let settled = false;

      const timer = setTimeout(() => {
        fail(
          new HerdrError(
            'timeout',
            `RPC ${method} timed out after ${callTimeout}ms`
          )
        );
      }, callTimeout);

      const onAbort = () => {
        fail(new HerdrError('aborted', `RPC ${method} aborted`));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      /**
       * @param {(v: unknown) => void} fn
       * @param {unknown} value
       */
      function settle(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        socket.removeAllListeners();
        socket.destroy();
        fn(value);
      }

      /** @param {Error} err */
      function fail(err) {
        settle(reject, err);
      }

      socket.setEncoding('utf8');

      socket.on('connect', () => {
        socket.write(line);
      });

      socket.on('data', (chunk) => {
        buffer += chunk;
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const raw = buffer.slice(0, nl);
        try {
          const msg = JSON.parse(raw);
          if (msg.error) {
            const code = msg.error.code ?? 'rpc_error';
            const message = msg.error.message ?? String(msg.error);
            fail(new HerdrError(code, message));
            return;
          }
          settle(resolve, msg.result);
        } catch (err) {
          fail(err instanceof Error ? err : new HerdrError('parse_error', String(err)));
        }
      });

      socket.on('error', (err) => {
        fail(err instanceof Error ? err : new HerdrError('socket_error', String(err)));
      });

      socket.on('end', () => {
        if (!settled) {
          fail(new HerdrError('connection_closed', `RPC ${method}: connection closed before response`));
        }
      });
    });
  }

  /**
   * Long-lived events.subscribe connection.
   * After `subscription_started`, each subsequent JSON line is passed to onEvent.
   * No auto-reconnect; on disconnect the handle is marked dead.
   *
   * @param {Array<Record<string, unknown>>} subscriptions
   * @param {(event: unknown) => void} onEvent
   * @returns {{ dead: boolean, close: () => void }}
   */
  function subscribe(subscriptions, onEvent) {
    assertWhitelisted('events.subscribe', allowWrite);

    const id = randomUUID();
    const line =
      JSON.stringify({
        id,
        method: 'events.subscribe',
        params: { subscriptions },
      }) + '\n';

    /** @type {import('node:net').Socket} */
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let started = false;
    let closedByUser = false;

    const handle = {
      dead: false,
      close() {
        if (handle.dead && closedByUser) return;
        closedByUser = true;
        handle.dead = true;
        socket.removeAllListeners();
        socket.destroy();
      },
    };

    /** Mark dead on transport failure (no auto-reconnect). */
    function markDead() {
      if (handle.dead) return;
      handle.dead = true;
      socket.removeAllListeners();
      // Leave socket cleanup to close/destroy paths.
      if (!closedByUser) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    }

    socket.setEncoding('utf8');

    socket.on('connect', () => {
      socket.write(line);
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) break;
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!raw) continue;

        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }

        if (!started) {
          const isStarted =
            msg?.result?.type === 'subscription_started' ||
            msg?.type === 'subscription_started';
          if (isStarted) {
            started = true;
            // Surface started so callers/tests can close without waiting for backlog.
            try {
              onEvent(msg.result ?? msg);
            } catch {
              /* ignore listener errors */
            }
          }
          continue;
        }

        try {
          onEvent(msg);
        } catch {
          /* ignore listener errors */
        }
      }
    });

    socket.on('error', () => {
      markDead();
    });

    socket.on('close', () => {
      handle.dead = true;
    });

    socket.on('end', () => {
      handle.dead = true;
    });

    return handle;
  }

  return {
    socketPath,
    timeoutMs,
    allowWrite,
    rpc,
    subscribe,
  };
}

export default createClient;
