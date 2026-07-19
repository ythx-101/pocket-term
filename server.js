/**
 * pocket-term-2 bridge HTTP server (M1: read + guarded pane send).
 * Listen: PT2_HOST / PT2_PORT (default 127.0.0.1:7690)
 * Write fuse: PT2_READONLY=1 → send endpoint 403, client without allowWrite.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStateManager } from './lib/state-manager.js';
import { createClient, DEFAULT_SOCKET_PATH } from './lib/herdr-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATE_DIR = path.join(ROOT, 'state');

/** Max JSON body for POST /send (8 KiB). */
export const SEND_BODY_MAX_BYTES = 8 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
};

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Origin from Origin header, else Referer origin (empty if neither).
 * @param {import('node:http').IncomingMessage} req
 */
export function requestOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin) return origin;
  const referer = String(req.headers.referer || '').trim();
  if (!referer) return '';
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

/**
 * Same-origin write guard (copied from pi-web-console).
 * Missing Origin/Referer → reject. Cross-origin → reject.
 * @param {import('node:http').IncomingMessage} req
 */
export function isSameOriginWrite(req) {
  const supplied = requestOrigin(req);
  if (!supplied) return false;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers.host || '').trim();
  if (!host) return false;
  try {
    return new URL(supplied).origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

/**
 * Read request body up to maxBytes. Rejects with status 413 when exceeded.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ ok: true, raw: string } | { ok: false, status: number, error: string }>}
 */
export function readBodyLimited(req, maxBytes) {
  return new Promise((resolve) => {
    const cl = req.headers['content-length'];
    if (cl != null && Number(cl) > maxBytes) {
      req.resume();
      resolve({ ok: false, status: 413, error: 'payload_too_large' });
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let settled = false;
    function done(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        req.resume();
        done({ ok: false, status: 413, error: 'payload_too_large' });
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      done({ ok: true, raw: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      done({ ok: false, status: 400, error: 'bad_body' });
    });
  });
}

/**
 * Resolve a static path under public/, rejecting traversal and symlink escape.
 * @param {string} urlPath pathname starting with /herd
 * @param {string} [publicDir]
 * @returns {Promise<{ ok: true, file: string } | { ok: false, status: number }>}
 */
export async function resolveStatic(urlPath, publicDir = PUBLIC_DIR) {
  // Reject raw traversal tokens before URL normalization tricks.
  if (urlPath.includes('..') || urlPath.includes('\\') || urlPath.includes('\0')) {
    return { ok: false, status: 403 };
  }
  if (!urlPath.startsWith('/herd')) {
    return { ok: false, status: 404 };
  }
  let rest = urlPath.slice('/herd'.length);
  if (rest === '' || rest === '/') rest = '/index.html';
  if (!rest.startsWith('/')) rest = '/' + rest;

  const rel = decodeURIComponent(rest).replace(/^\/+/, '');
  if (rel.split('/').some((seg) => seg === '..')) {
    return { ok: false, status: 403 };
  }

  let publicRoot;
  try {
    publicRoot = path.resolve(await fs.realpath(publicDir));
  } catch {
    return { ok: false, status: 404 };
  }
  const candidate = path.resolve(publicRoot, rel);
  const prefix = publicRoot.endsWith(path.sep)
    ? publicRoot
    : publicRoot + path.sep;
  // Lexical check before realpath (cheap reject).
  if (candidate !== publicRoot && !candidate.startsWith(prefix)) {
    return { ok: false, status: 403 };
  }

  // realpath collapses symlinks — must still sit under publicRoot.
  let realFile;
  try {
    realFile = path.resolve(await fs.realpath(candidate));
  } catch {
    return { ok: false, status: 404 };
  }
  if (realFile !== publicRoot && !realFile.startsWith(prefix)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, file: realFile };
}

/**
 * @param {{
 *   host?: string,
 *   port?: number,
 *   stateDir?: string,
 *   publicDir?: string,
 *   socketPath?: string,
 *   client?: ReturnType<typeof createClient>,
 *   readonly?: boolean,
 * }} [options]
 */
export async function startServer(options = {}) {
  const host = options.host ?? process.env.PT2_HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PT2_PORT ?? 7690);
  const stateDir = options.stateDir ?? STATE_DIR;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const readonly =
    options.readonly === true ||
    process.env.PT2_READONLY === '1' ||
    process.env.PT2_READONLY === 'true';

  const client =
    options.client ??
    createClient({
      socketPath: options.socketPath ?? process.env.PT2_HERDR_SOCK ?? DEFAULT_SOCKET_PATH,
      allowWrite: !readonly,
    });

  const manager = createStateManager({
    client,
    stateDir,
    socketPath: options.socketPath,
    readonly,
    allowWrite: !readonly,
  });
  await manager.start();

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handler(req, res) {
    const method = req.method || 'GET';
    const hostHdr = req.headers.host || `${host}:${port}`;
    let url;
    try {
      url = new URL(req.url || '/', `http://${hostHdr}`);
    } catch {
      sendText(res, 400, 'bad request');
      return;
    }

    // Use both raw and parsed paths for safety.
    const rawPath = (req.url || '/').split('?')[0];
    const pathname = url.pathname;

    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      sendText(res, 405, 'method not allowed');
      return;
    }

    // --- API ---
    if (pathname === '/herd/api/state' && (method === 'GET' || method === 'HEAD')) {
      sendJson(res, 200, manager.getState());
      return;
    }

    if (pathname === '/herd/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      // flush headers
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const id = manager.addSseClient(res);
      req.on('close', () => manager.removeSseClient(id));
      return;
    }

    const messagesMatch = pathname.match(
      /^\/herd\/api\/pane\/([^/]+)\/messages$/
    );
    if (messagesMatch && (method === 'GET' || method === 'HEAD')) {
      const paneId = decodeURIComponent(messagesMatch[1]);
      const before = url.searchParams.get('before');
      const limit = url.searchParams.get('limit');
      try {
        const messages = await manager.getMessages(paneId, {
          before,
          limit: limit ? Number(limit) : undefined,
        });
        sendJson(res, 200, messages);
      } catch (err) {
        sendJson(res, 500, {
          error: err?.message || 'messages failed',
        });
      }
      return;
    }

    const sendMatch = pathname.match(/^\/herd\/api\/pane\/([^/]+)\/send$/);
    if (sendMatch && method === 'POST') {
      if (readonly) {
        sendJson(res, 403, { error: 'readonly' });
        return;
      }
      if (!isSameOriginWrite(req)) {
        sendJson(res, 403, { error: 'cross_origin' });
        return;
      }
      const paneId = decodeURIComponent(sendMatch[1]);
      const body = await readBodyLimited(req, SEND_BODY_MAX_BYTES);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      let payload;
      try {
        payload = body.raw ? JSON.parse(body.raw) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }
      if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(res, 400, { error: 'invalid_body' });
        return;
      }
      if (payload.text != null && typeof payload.text !== 'string') {
        sendJson(res, 400, { error: 'invalid_text' });
        return;
      }
      const text = typeof payload.text === 'string' ? payload.text : '';
      const mode = payload.mode == null || payload.mode === '' ? 'run' : payload.mode;
      if (mode !== 'run' && mode !== 'text') {
        sendJson(res, 400, { error: 'invalid_mode' });
        return;
      }
      const result = await manager.sendToPane(paneId, text, mode);
      if (!result.ok) {
        const headers = {};
        if (result.status === 429 && result.retryAfterSec != null) {
          headers['Retry-After'] = String(result.retryAfterSec);
        }
        sendJson(
          res,
          result.status,
          {
            error: result.error,
            ...(result.retryAfterSec != null
              ? { retry_after: result.retryAfterSec }
              : {}),
          },
          headers
        );
        return;
      }
      sendJson(res, 200, { sent: true });
      return;
    }

    const seenMatch = pathname.match(/^\/herd\/api\/seen\/([^/]+)$/);
    if (seenMatch && method === 'POST') {
      const paneId = decodeURIComponent(seenMatch[1]);
      // Drain body (ignore content)
      await new Promise((resolve) => {
        req.on('data', () => {});
        req.on('end', resolve);
        req.on('error', resolve);
      });
      try {
        const result = await manager.markSeen(paneId);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'seen failed' });
      }
      return;
    }

    // --- static under /herd ---
    // Exact /herd (no trailing slash) would make relative assets like ./style.css
    // resolve to /style.css outside our route. Redirect so the browser stays under /herd/.
    if ((method === 'GET' || method === 'HEAD') && pathname === '/herd') {
      res.writeHead(301, { Location: '/herd/' + (url.search || '') });
      res.end();
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      // Prefer rawPath for traversal detection (URL parser collapses /herd/../…)
      const checkPath = rawPath.includes('..') ? rawPath : pathname;
      if (checkPath.startsWith('/herd') || rawPath.startsWith('/herd')) {
        const targetPath = rawPath.includes('..') ? rawPath : pathname;
        const resolved = await resolveStatic(targetPath, publicDir);
        if (!resolved.ok) {
          sendText(res, resolved.status, resolved.status === 403 ? 'forbidden' : 'not found');
          return;
        }
        try {
          const data = await fs.readFile(resolved.file);
          const ext = path.extname(resolved.file).toLowerCase();
          const type = MIME[ext] || 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': data.length,
          });
          if (method === 'HEAD') res.end();
          else res.end(data);
          return;
        } catch {
          sendText(res, 404, 'not found');
          return;
        }
      }
    }

    if (pathname.startsWith('/herd/api/')) {
      sendText(res, 404, 'not found');
      return;
    }

    sendText(res, 404, 'not found');
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err?.message || 'internal error' });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  async function close() {
    await manager.stop();
    await new Promise((resolve) => {
      server.close(() => resolve());
      // Force-close lingering keep-alive / SSE sockets
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  return {
    server,
    manager,
    host,
    port: actualPort,
    readonly,
    close,
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  startServer()
    .then(({ host, port, readonly }) => {
      console.log(
        `pocket-term-2 listening on http://${host}:${port}/herd/` +
          (readonly ? ' (PT2_READONLY)' : '')
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
