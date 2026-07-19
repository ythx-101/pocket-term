/**
 * pocket-term-2 bridge HTTP server (M0 read-only herdr face).
 * Listen: PT2_HOST / PT2_PORT (default 127.0.0.1:7690)
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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
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
 * }} [options]
 */
export async function startServer(options = {}) {
  const host = options.host ?? process.env.PT2_HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PT2_PORT ?? 7690);
  const stateDir = options.stateDir ?? STATE_DIR;
  const publicDir = options.publicDir ?? PUBLIC_DIR;

  const client =
    options.client ??
    createClient({
      socketPath: options.socketPath ?? process.env.PT2_HERDR_SOCK ?? DEFAULT_SOCKET_PATH,
    });

  const manager = createStateManager({
    client,
    stateDir,
    socketPath: options.socketPath,
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
    close,
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  startServer()
    .then(({ host, port }) => {
      console.log(`pocket-term-2 listening on http://${host}:${port}/herd/`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
