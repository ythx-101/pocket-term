/**
 * Tier A: read Claude Code session JSONL into chat messages.
 * Path-constrained: only real paths under allowedRoot may be read.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_ALLOWED_ROOT = '/root/.claude/projects';

/**
 * @param {string} code
 * @param {string} message
 */
function pathError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.name = 'TranscriptPathError';
  return err;
}

/**
 * Resolve and assert jsonlPath is a real path under allowedRoot.
 * Rejects `..`, symlink escape, and anything outside the root.
 *
 * @param {string} jsonlPath
 * @param {string} allowedRoot
 * @returns {Promise<string>} absolute real path
 */
export async function resolveSafePath(jsonlPath, allowedRoot = DEFAULT_ALLOWED_ROOT) {
  if (typeof jsonlPath !== 'string' || !jsonlPath) {
    throw pathError('invalid_path', 'jsonlPath must be a non-empty string');
  }
  if (typeof allowedRoot !== 'string' || !allowedRoot) {
    throw pathError('invalid_root', 'allowedRoot must be a non-empty string');
  }

  // Reject obvious traversal before resolve.
  if (jsonlPath.includes('\0')) {
    throw pathError('invalid_path', 'jsonlPath contains NUL');
  }
  // Reject any '..' path segment outright (even if realpath would stay inside root).
  const segments = jsonlPath.split(/[/\\]+/);
  if (segments.some((seg) => seg === '..')) {
    throw pathError(
      'path_escape',
      `Path contains '..' segment (not allowed): ${jsonlPath}`
    );
  }

  let realRoot;
  try {
    realRoot = await fs.realpath(allowedRoot);
  } catch (err) {
    throw pathError(
      'root_missing',
      `allowedRoot does not exist or is not accessible: ${allowedRoot}`
    );
  }
  realRoot = path.resolve(realRoot);
  // Ensure directory semantics for prefix checks.
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

  // Resolve the candidate: realpath fails if missing; for missing files still
  // validate the parent real path + final segment stays under root.
  let realPath;
  try {
    realPath = await fs.realpath(jsonlPath);
  } catch {
    // File may not exist yet — resolve parent and join basename.
    const abs = path.resolve(jsonlPath);
    // If any segment is `..` relative to root after resolve, catch below.
    const parent = path.dirname(abs);
    let realParent;
    try {
      realParent = await fs.realpath(parent);
    } catch {
      throw pathError(
        'path_escape',
        `Path escapes allowedRoot or does not exist: ${jsonlPath}`
      );
    }
    realPath = path.join(realParent, path.basename(abs));
  }

  realPath = path.resolve(realPath);
  const ok =
    realPath === realRoot ||
    realPath.startsWith(rootPrefix);
  if (!ok) {
    throw pathError(
      'path_escape',
      `Path escapes allowedRoot (symlink or absolute): ${jsonlPath}`
    );
  }

  return realPath;
}

/**
 * One-line tool summary from tool_use block.
 * @param {{ name?: string, input?: unknown }} block
 */
function toolSummary(block) {
  const name = block.name || 'tool';
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  let detail = '';
  if (typeof input.file_path === 'string') detail = input.file_path;
  else if (typeof input.command === 'string') detail = input.command;
  else if (typeof input.description === 'string') detail = input.description;
  else if (typeof input.skill === 'string') detail = input.skill;
  else if (typeof input.pattern === 'string') detail = input.pattern;
  else if (typeof input.path === 'string') detail = input.path;
  // Keep one short line.
  if (detail.length > 120) detail = detail.slice(0, 117) + '...';
  return detail ? `${name}: ${detail}` : name;
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function extractUserText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
    // tool_result blocks are not user chat — skip
  }
  return parts.join('\n');
}

/**
 * Map one JSONL record → zero or more messages.
 * @param {object} rec
 * @returns {Array<{role:string, text?:string, kind?:string, summary?:string, ts:string}>}
 */
export function mapRecord(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const type = rec.type;
  const ts = rec.timestamp || rec.ts || null;

  // Skip meta / progress / bookkeeping record types.
  if (
    type === 'mode' ||
    type === 'permission-mode' ||
    type === 'ai-title' ||
    type === 'last-prompt' ||
    type === 'attachment' ||
    type === 'queue-operation' ||
    type === 'file-history-snapshot' ||
    type === 'file-history-delta' ||
    type === 'progress' ||
    type === 'summary' ||
    type === 'system'
  ) {
    return [];
  }

  if (type === 'user') {
    if (rec.isMeta) return [];
    const text = extractUserText(rec.message?.content);
    if (!text) return [];
    return [{ role: 'user', text, ts }];
  }

  if (type === 'assistant') {
    const content = rec.message?.content;
    const out = [];
    if (typeof content === 'string') {
      if (content) out.push({ role: 'agent', text: content, ts });
      return out;
    }
    if (!Array.isArray(content)) return out;

    const textParts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        // Flush pending text before tool so order is preserved.
        if (textParts.length) {
          out.push({ role: 'agent', text: textParts.join('\n'), ts });
          textParts.length = 0;
        }
        out.push({
          role: 'system',
          kind: 'tool',
          summary: toolSummary(block),
          ts,
        });
      }
      // thinking / image / other → skip
    }
    if (textParts.length) {
      out.push({ role: 'agent', text: textParts.join('\n'), ts });
    }
    return out;
  }

  // Unknown record types: skip without throwing.
  return [];
}

/**
 * Incrementally read messages from a Claude Code JSONL transcript.
 *
 * @param {string} jsonlPath
 * @param {{ afterOffset?: number, allowedRoot?: string }} [options]
 * @returns {Promise<{ messages: Array<object>, offset: number }>}
 */
export async function readMessages(jsonlPath, options = {}) {
  const afterOffset = Number(options.afterOffset ?? 0) || 0;
  const allowedRoot = options.allowedRoot ?? DEFAULT_ALLOWED_ROOT;
  const safePath = await resolveSafePath(jsonlPath, allowedRoot);

  let stat;
  try {
    stat = await fs.stat(safePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { messages: [], offset: afterOffset };
    }
    throw err;
  }
  if (!stat.isFile()) {
    throw pathError('not_a_file', `Not a file: ${jsonlPath}`);
  }

  if (afterOffset >= stat.size) {
    return { messages: [], offset: afterOffset };
  }

  const fh = await fs.open(safePath, 'r');
  try {
    const length = stat.size - afterOffset;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, afterOffset);
    const chunk = buf.subarray(0, bytesRead);

    // Only process complete lines; leave trailing half-line for next read.
    const lastNl = chunk.lastIndexOf(0x0a); // \n
    if (lastNl === -1) {
      // No complete line yet.
      return { messages: [], offset: afterOffset };
    }

    const complete = chunk.subarray(0, lastNl + 1);
    const newOffset = afterOffset + complete.length;
    const text = complete.toString('utf8');
    const messages = [];

    for (const line of text.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        // Malformed line: skip, do not throw (session may still be useful).
        continue;
      }
      const mapped = mapRecord(rec);
      for (const m of mapped) messages.push(m);
    }

    return { messages, offset: newOffset };
  } finally {
    await fh.close();
  }
}

/** Sync helper for path prefix checks. */
export function isPathInsideRoot(realPath, realRoot) {
  const root = path.resolve(realRoot);
  const target = path.resolve(realPath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target === root || target.startsWith(prefix);
}
