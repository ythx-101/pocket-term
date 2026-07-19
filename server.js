/**
 * pocket-term-2 bridge HTTP server (M1: read + guarded pane send).
 * Listen: PT2_HOST / PT2_PORT (default 127.0.0.1:7690)
 * Write fuse: PT2_READONLY=1 → send endpoint 403, client without allowWrite.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createStateManager,
  isSafeWallpaperName,
} from './lib/state-manager.js';
import { createClient, DEFAULT_SOCKET_PATH } from './lib/herdr-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATE_DIR = path.join(ROOT, 'state');

/** Max JSON body for POST /send and /settings (8 KiB). */
export const SEND_BODY_MAX_BYTES = 8 * 1024;

/** Max image upload body (10 MiB). */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Default chat upload sink (shared with pocket-term terminal uploads). */
export const DEFAULT_CHAT_UPLOAD_DIR = '/srv/term-uploads';

/** Allowed image extensions for POST /herd/api/upload. */
export const UPLOAD_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/** Fingerprinted SPA assets: long-cache + ?v= rewrite in HTML (and app.js→spa-utils). */
export const FINGERPRINTED_ASSETS = new Set([
  'app.js',
  'style.css',
  'spa-utils.js',
]);

/** Cache-Control for fingerprinted JS/CSS. */
export const CACHE_FINGERPRINTED = 'public, max-age=31536000, immutable';
/** Cache-Control for index.html (must revalidate every deploy). */
export const CACHE_HTML = 'no-store';
/** Cache-Control for wallpaper images. */
export const CACHE_WALLPAPER = 'public, max-age=86400';

const WALLPAPER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

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
  '.gif': 'image/gif',
};

/**
 * Read package.json version once (sync, boot-time).
 * @param {string} [root]
 * @returns {string}
 */
export function readPkgVersion(root = ROOT) {
  try {
    const raw = fsSync.readFileSync(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * Asset cache-bust token: package version + server start ms (unique every boot).
 * @param {string} [pkgVersion]
 * @param {number} [bootMs]
 * @returns {string}
 */
export function createAssetVersion(pkgVersion = readPkgVersion(), bootMs = Date.now()) {
  return `${pkgVersion}.${bootMs}`;
}

/**
 * Rewrite SPA asset href/src in index.html to append ?v=<version>.
 * @param {string} html
 * @param {string} version
 * @returns {string}
 */
export function injectAssetVersionInHtml(html, version) {
  const v = encodeURIComponent(String(version));
  return String(html).replace(
    /(\.\/(?:app\.js|style\.css|spa-utils\.js))(?:\?[^"'\s>]*)?/g,
    `$1?v=${v}`
  );
}

/**
 * Rewrite spa-utils import inside served app.js so the module URL busts too.
 * @param {string} js
 * @param {string} version
 * @returns {string}
 */
export function injectAssetVersionInAppJs(js, version) {
  const v = encodeURIComponent(String(version));
  return String(js).replace(
    /(from\s*['"])(\.\/spa-utils\.js)(?:\?[^'"]*)?(['"])/g,
    `$1$2?v=${v}$3`
  );
}

/**
 * Cache-Control for a public/ basename.
 * @param {string} basename e.g. "index.html", "app.js"
 * @returns {string|null} header value, or null if no special policy
 */
export function cacheControlForStatic(basename) {
  const name = path.basename(String(basename || ''));
  if (name === 'index.html') return CACHE_HTML;
  if (FINGERPRINTED_ASSETS.has(name)) return CACHE_FINGERPRINTED;
  return null;
}

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
 * Read raw request body as Buffer up to maxBytes (413 when exceeded).
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ ok: true, buf: Buffer } | { ok: false, status: number, error: string }>}
 */
export function readBodyBufferLimited(req, maxBytes) {
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
      done({ ok: true, buf: Buffer.concat(chunks) });
    });
    req.on('error', () => {
      done({ ok: false, status: 400, error: 'bad_body' });
    });
  });
}

/**
 * Detect image type from magic bytes. Returns lowercase ext with leading dot.
 * @param {Buffer} buf
 * @returns {'.jpg'|'.png'|'.webp'|'.gif'|null}
 */
export function detectImageMagic(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  // PNG
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return '.png';
  }
  // GIF87a / GIF89a
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return '.gif';
  }
  // WEBP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return '.webp';
  }
  return null;
}

/**
 * Whether claimed extension matches detected magic (jpeg aliases .jpg).
 * @param {string} claimedExt e.g. ".jpeg"
 * @param {string|null} magicExt e.g. ".jpg"
 */
export function magicMatchesExt(claimedExt, magicExt) {
  if (!magicExt) return false;
  const c = String(claimedExt || '').toLowerCase();
  const m = String(magicExt).toLowerCase();
  if (c === m) return true;
  if ((c === '.jpg' || c === '.jpeg') && m === '.jpg') return true;
  return false;
}

/**
 * Sanitize a filename into a short filesystem-safe slug (no ext).
 * Rejects empty / injection-only names via returning null.
 * @param {unknown} rawHeader X-Filename value
 * @returns {{ ok: true, slug: string, ext: string } | { ok: false, error: string }}
 */
export function parseUploadFilename(rawHeader) {
  if (rawHeader == null || rawHeader === '') {
    return { ok: false, error: 'missing_filename' };
  }
  let raw = String(rawHeader);
  // Reject null bytes and absurd length before any path work.
  if (raw.includes('\0')) {
    return { ok: false, error: 'invalid_filename' };
  }
  if (raw.length > 512) {
    return { ok: false, error: 'filename_too_long' };
  }
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return { ok: false, error: 'invalid_filename' };
  }
  if (raw.includes('\0')) {
    return { ok: false, error: 'invalid_filename' };
  }
  // Reject path injection / traversal; only pure basenames accepted.
  // (Brief says "仅取 basename" — we require the client already sent a basename.)
  if (
    raw.includes('/') ||
    raw.includes('\\') ||
    raw.includes('..') ||
    raw === '.' ||
    raw === '..'
  ) {
    return { ok: false, error: 'invalid_filename' };
  }
  const base = path.basename(raw);
  if (base !== raw || !base) {
    return { ok: false, error: 'invalid_filename' };
  }
  const ext = path.extname(base).toLowerCase();
  if (!UPLOAD_EXTS.has(ext)) {
    return { ok: false, error: 'invalid_extension' };
  }
  let stem = base.slice(0, base.length - ext.length);
  // Keep alnum / . _ - ; collapse everything else to _
  stem = stem.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_');
  stem = stem.replace(/^[._\-]+|[._\-]+$/g, '');
  if (!stem) stem = 'image';
  // Cap slug length (final name stays well under common NAME_MAX)
  if (stem.length > 80) stem = stem.slice(0, 80);
  return { ok: true, slug: stem, ext };
}

/**
 * Build final stored basename: YYYYMMDD-HHMMSS-<slug>.<ext>
 * @param {string} slug
 * @param {string} ext with leading dot
 * @param {Date} [now]
 * @returns {string}
 */
export function buildUploadStoredName(slug, ext, now = new Date()) {
  const d = now instanceof Date ? now : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const e = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  // Normalize jpeg → jpg in stored names for consistency with magic
  const storedExt = e === '.jpeg' ? '.jpg' : e;
  const safeSlug = String(slug || 'image').replace(/[^\w.\-]+/g, '_') || 'image';
  return `${stamp}-${safeSlug}${storedExt}`;
}

/**
 * Atomically write buffer to destDir/finalName via O_EXCL tmp + rename.
 * Cleans up tmp on any failure. Retries final name on rare collisions.
 *
 * @param {string} destDir
 * @param {string} finalName basename
 * @param {Buffer} buf
 * @returns {Promise<{ ok: true, name: string, path: string } | { ok: false, status: number, error: string }>}
 */
export async function writeUploadAtomic(destDir, finalName, buf) {
  await fs.mkdir(destDir, { recursive: true });
  let rootReal;
  try {
    rootReal = path.resolve(await fs.realpath(destDir));
  } catch {
    return { ok: false, status: 500, error: 'upload_dir_missing' };
  }

  let name = path.basename(finalName);
  if (name !== finalName || name.includes('..') || name.includes('\0')) {
    return { ok: false, status: 400, error: 'invalid_filename' };
  }

  const maxAttempts = 32;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tryName =
      attempt === 0
        ? name
        : name.replace(/(\.[^.]+)$/, `-${attempt}$1`);
    const dest = path.join(rootReal, tryName);
    // Lexical containment
    const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (!dest.startsWith(prefix)) {
      return { ok: false, status: 400, error: 'invalid_filename' };
    }

    const tmpName = `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.tmp`;
    const tmpPath = path.join(rootReal, tmpName);
    if (!tmpPath.startsWith(prefix)) {
      return { ok: false, status: 500, error: 'tmp_path_error' };
    }

    let fd = null;
    try {
      fd = fsSync.openSync(
        tmpPath,
        fsSync.constants.O_WRONLY |
          fsSync.constants.O_CREAT |
          fsSync.constants.O_EXCL,
        0o640
      );
      const st = fsSync.fstatSync(fd);
      if (!st.isFile()) {
        fsSync.closeSync(fd);
        fd = null;
        try {
          fsSync.unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        return { ok: false, status: 400, error: 'not_regular_file' };
      }
      fsSync.writeSync(fd, buf, 0, buf.length, 0);
      fsSync.fsyncSync(fd);
      fsSync.closeSync(fd);
      fd = null;

      try {
        fsSync.renameSync(tmpPath, dest);
      } catch (err) {
        // Collision on final name — clean tmp and retry with suffix
        try {
          fsSync.unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') {
          continue;
        }
        // On Linux rename overwrites; EEXIST is rare. Other errors: surface.
        return { ok: false, status: 500, error: 'rename_failed' };
      }

      // If dest already existed and rename overwrote, that's fine for unique
      // timestamped names. Verify regular file.
      try {
        const dstSt = fsSync.statSync(dest);
        if (!dstSt.isFile()) {
          try {
            fsSync.unlinkSync(dest);
          } catch {
            /* ignore */
          }
          return { ok: false, status: 400, error: 'not_regular_file' };
        }
      } catch {
        return { ok: false, status: 500, error: 'stat_failed' };
      }

      return { ok: true, name: tryName, path: dest };
    } catch (err) {
      if (fd != null) {
        try {
          fsSync.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        fsSync.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') {
        // tmp collision — retry
        continue;
      }
      return {
        ok: false,
        status: 500,
        error: /** @type {Error} */ (err).message || 'write_failed',
      };
    }
  }
  return { ok: false, status: 500, error: 'could_not_create_unique_file' };
}

/**
 * Validate and store an image upload.
 * @param {{
 *   target: 'chat'|'wallpaper',
 *   rawFilename: unknown,
 *   body: Buffer,
 *   chatUploadDir: string,
 *   stateDir: string,
 *   readonly: boolean,
 *   now?: Date,
 * }} opts
 * @returns {Promise<
 *   | { ok: true, status: 200, body: { path: string } | { name: string } }
 *   | { ok: false, status: number, error: string }
 * >}
 */
export async function handleImageUpload(opts) {
  const target = opts.target;
  if (target !== 'chat' && target !== 'wallpaper') {
    return { ok: false, status: 400, error: 'invalid_target' };
  }
  if (opts.readonly && target === 'chat') {
    return { ok: false, status: 403, error: 'readonly' };
  }
  if (!Buffer.isBuffer(opts.body) || opts.body.length === 0) {
    return { ok: false, status: 400, error: 'empty_body' };
  }
  if (opts.body.length > UPLOAD_MAX_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }

  const parsed = parseUploadFilename(opts.rawFilename);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }

  const magic = detectImageMagic(opts.body);
  if (!magicMatchesExt(parsed.ext, magic)) {
    return { ok: false, status: 400, error: 'magic_mismatch' };
  }

  // Prefer magic-normalized ext for stored name (jpeg→jpg already in builder)
  const stored = buildUploadStoredName(
    parsed.slug,
    parsed.ext === '.jpeg' ? '.jpg' : parsed.ext,
    opts.now
  );

  // Wallpaper names must also pass isSafeWallpaperName (basename + whitelist)
  if (target === 'wallpaper' && !isSafeWallpaperName(stored)) {
    return { ok: false, status: 400, error: 'invalid_filename' };
  }

  const destDir =
    target === 'chat'
      ? opts.chatUploadDir
      : path.join(opts.stateDir, 'wallpapers');

  const written = await writeUploadAtomic(destDir, stored, opts.body);
  if (!written.ok) {
    return { ok: false, status: written.status, error: written.error };
  }

  if (target === 'chat') {
    // Absolute path on disk (prod: /srv/term-uploads/<name>)
    return { ok: true, status: 200, body: { path: written.path } };
  }
  return { ok: true, status: 200, body: { name: written.name } };
}

/**
 * List wallpaper images under state/wallpapers (jpg/png/webp/gif).
 * @param {string} stateDir
 * @returns {Promise<Array<{ name: string, size: number }>>}
 */
export async function listWallpapers(stateDir) {
  const dir = path.join(stateDir, 'wallpapers');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {Array<{ name: string, size: number }>} */
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (!isSafeWallpaperName(name)) continue;
    const ext = path.extname(name).toLowerCase();
    if (!WALLPAPER_EXTS.has(ext)) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, size: st.size });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Resolve a wallpaper file under state/wallpapers with strict basename checks.
 * Rejects traversal (`..`, encoded variants, separators).
 *
 * @param {string} stateDir
 * @param {string} rawName path segment (may still be percent-encoded)
 * @returns {Promise<
 *   | { ok: true, file: string, ext: string }
 *   | { ok: false, status: number }
 * >}
 */
export async function resolveWallpaperFile(stateDir, rawName) {
  if (rawName == null) return { ok: false, status: 400 };
  const raw = String(rawName);
  // Reject traversal tokens before and after decode.
  if (
    raw.includes('\0') ||
    raw.includes('/') ||
    raw.includes('\\') ||
    raw.includes('..')
  ) {
    return { ok: false, status: 403 };
  }
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return { ok: false, status: 403 };
  }
  if (
    name.includes('\0') ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    name !== path.basename(name)
  ) {
    return { ok: false, status: 403 };
  }
  if (!isSafeWallpaperName(name)) {
    return { ok: false, status: 403 };
  }
  const wallpapersDir = path.join(stateDir, 'wallpapers');
  let rootReal;
  try {
    rootReal = path.resolve(await fs.realpath(wallpapersDir));
  } catch {
    return { ok: false, status: 404 };
  }
  const candidate = path.resolve(rootReal, name);
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (candidate !== rootReal && !candidate.startsWith(prefix)) {
    return { ok: false, status: 403 };
  }
  if (path.basename(candidate) !== name) {
    return { ok: false, status: 403 };
  }
  let realFile;
  try {
    realFile = path.resolve(await fs.realpath(candidate));
  } catch {
    return { ok: false, status: 404 };
  }
  if (realFile !== rootReal && !realFile.startsWith(prefix)) {
    return { ok: false, status: 403 };
  }
  try {
    const st = await fs.stat(realFile);
    if (!st.isFile()) return { ok: false, status: 404 };
  } catch {
    return { ok: false, status: 404 };
  }
  return {
    ok: true,
    file: realFile,
    ext: path.extname(realFile).toLowerCase(),
  };
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
 *   assetVersion?: string,
 *   chatUploadDir?: string,
 * }} [options]
 */
export async function startServer(options = {}) {
  const host = options.host ?? process.env.PT2_HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PT2_PORT ?? 7690);
  const stateDir = options.stateDir ?? STATE_DIR;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const chatUploadDir =
    options.chatUploadDir ??
    process.env.PT2_CHAT_UPLOAD_DIR ??
    DEFAULT_CHAT_UPLOAD_DIR;
  const readonly =
    options.readonly === true ||
    process.env.PT2_READONLY === '1' ||
    process.env.PT2_READONLY === 'true';
  const assetVersion =
    options.assetVersion != null && String(options.assetVersion)
      ? String(options.assetVersion)
      : createAssetVersion();

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

    // Reject traversal tokens in the raw request path before route matching
    // (URL parser collapses /wallpaper/../… into another route). Also reject
    // percent-encoded dot segments (%2e) so encodings never reach static serve.
    if (
      rawPath.includes('\0') ||
      rawPath.includes('\\') ||
      rawPath.includes('..') ||
      /%2e/i.test(rawPath)
    ) {
      sendText(res, 403, 'forbidden');
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

    // --- image upload (M2-P1) ---
    if (pathname === '/herd/api/upload' && method === 'POST') {
      if (!isSameOriginWrite(req)) {
        sendJson(res, 403, { error: 'cross_origin' });
        return;
      }
      const targetRaw = String(url.searchParams.get('target') || '').trim();
      if (targetRaw !== 'chat' && targetRaw !== 'wallpaper') {
        sendJson(res, 400, { error: 'invalid_target' });
        return;
      }
      // Content-Length early reject (also re-checked while streaming)
      const clHdr = req.headers['content-length'];
      if (clHdr != null && Number(clHdr) > UPLOAD_MAX_BYTES) {
        req.resume();
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      const body = await readBodyBufferLimited(req, UPLOAD_MAX_BYTES);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      const result = await handleImageUpload({
        target: /** @type {'chat'|'wallpaper'} */ (targetRaw),
        rawFilename: req.headers['x-filename'],
        body: body.buf,
        chatUploadDir,
        stateDir,
        readonly,
      });
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, result.status, result.body);
      return;
    }

    // --- wallpapers + settings (M2) ---
    if (pathname === '/herd/api/wallpapers' && (method === 'GET' || method === 'HEAD')) {
      try {
        const wallpapers = await listWallpapers(stateDir);
        sendJson(res, 200, { wallpapers });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'wallpapers failed' });
      }
      return;
    }

    const wallpaperMatch = pathname.match(/^\/herd\/api\/wallpaper\/([^/]+)$/);
    if (wallpaperMatch && (method === 'GET' || method === 'HEAD')) {
      // Prefer raw path segment so encoded `..` is visible before URL parser
      // collapses it; fall back to pathname capture.
      let rawSeg = wallpaperMatch[1];
      const rawApi = rawPath.match(/^\/herd\/api\/wallpaper\/([^/?#]+)/);
      if (rawApi) rawSeg = rawApi[1];
      // Also reject if the raw request path itself contains traversal.
      if (rawPath.includes('..') || rawPath.includes('\\') || rawPath.includes('\0')) {
        sendText(res, 403, 'forbidden');
        return;
      }
      const resolved = await resolveWallpaperFile(stateDir, rawSeg);
      if (!resolved.ok) {
        sendText(
          res,
          resolved.status,
          resolved.status === 403 ? 'forbidden' : 'not found'
        );
        return;
      }
      try {
        const data = await fs.readFile(resolved.file);
        const type = MIME[resolved.ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': data.length,
          'Cache-Control': CACHE_WALLPAPER,
        });
        if (method === 'HEAD') res.end();
        else res.end(data);
      } catch {
        sendText(res, 404, 'not found');
      }
      return;
    }

    if (pathname === '/herd/api/settings' && (method === 'GET' || method === 'HEAD')) {
      sendJson(res, 200, manager.getSettings());
      return;
    }

    if (pathname === '/herd/api/settings' && method === 'POST') {
      if (!isSameOriginWrite(req)) {
        sendJson(res, 403, { error: 'cross_origin' });
        return;
      }
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
      const result = await manager.updateSettings(payload, {
        wallpaperExists: async (name) => {
          const r = await resolveWallpaperFile(stateDir, name);
          return r.ok;
        },
      });
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, 200, result.settings);
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
          let data = await fs.readFile(resolved.file);
          const ext = path.extname(resolved.file).toLowerCase();
          const basename = path.basename(resolved.file);
          const type = MIME[ext] || 'application/octet-stream';
          const headers = {
            'Content-Type': type,
          };

          // index.html: never cache; rewrite asset refs to ?v=<boot version>
          if (basename === 'index.html') {
            const html = injectAssetVersionInHtml(data.toString('utf8'), assetVersion);
            data = Buffer.from(html, 'utf8');
            headers['Cache-Control'] = CACHE_HTML;
          } else if (FINGERPRINTED_ASSETS.has(basename)) {
            // app.js must also rewrite its spa-utils import so the module URL busts.
            if (basename === 'app.js') {
              const js = injectAssetVersionInAppJs(data.toString('utf8'), assetVersion);
              data = Buffer.from(js, 'utf8');
            }
            headers['Cache-Control'] = CACHE_FINGERPRINTED;
          }

          headers['Content-Length'] = data.length;
          res.writeHead(200, headers);
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
    assetVersion,
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
