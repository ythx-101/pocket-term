/**
 * Tier B: pure functions for terminal-stream bubbles.
 * Clock / silence threshold injectable for tests.
 */

/** CSI / OSC / common ANSI strip. */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  if (!text) return '';
  return String(text)
    .replace(ANSI_RE, '')
    // BEL / OSC leftovers sometimes left after partial strip
    .replace(/\u0007/g, '');
}

/**
 * Compress consecutive blank lines to a single blank line.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function compressBlankLines(lines) {
  const out = [];
  let prevBlank = false;
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank) {
      if (prevBlank) continue;
      out.push('');
      prevBlank = true;
    } else {
      out.push(line);
      prevBlank = false;
    }
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function toLines(text) {
  if (!text) return [];
  // Preserve intentional trailing content; drop only a single final empty from split.
  const parts = String(text).split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Diff terminal snapshots → newly appeared lines.
 * Prefers over-including rather than dropping content on full redraw.
 *
 * @param {string} prevText
 * @param {string} nextText
 * @returns {string[]}
 */
export function diffNewText(prevText, nextText) {
  if (nextText == null) return [];
  const next = String(nextText);
  const prev = prevText == null ? '' : String(prevText);

  if (!prev) return toLines(next);
  if (next === prev) return [];

  // Fast path: pure string append (including mid-line growth).
  if (next.startsWith(prev)) {
    return toLines(next.slice(prev.length));
  }

  const prevLines = toLines(prev);
  const nextLines = toLines(next);

  // Pure line append: next extends prev line-for-line.
  let commonPrefix = 0;
  while (
    commonPrefix < prevLines.length &&
    commonPrefix < nextLines.length &&
    prevLines[commonPrefix] === nextLines[commonPrefix]
  ) {
    commonPrefix++;
  }
  if (commonPrefix === prevLines.length) {
    return nextLines.slice(commonPrefix);
  }

  // Scroll case: longest L where prev suffix of length L == next prefix of length L.
  let L = 0;
  const maxL = Math.min(prevLines.length, nextLines.length);
  for (let n = maxL; n > 0; n--) {
    if (arraysEqual(prevLines.slice(-n), nextLines.slice(0, n))) {
      L = n;
      break;
    }
  }
  if (L > 0) {
    return nextLines.slice(L);
  }

  // Full redraw / no common anchor: treat entire next as new (do not drop).
  return nextLines;
}

/**
 * Fold a time-ordered event stream into sealed bubbles.
 *
 * Event shapes:
 * - `{ ts, lines: string[] }` — new terminal lines
 * - `{ ts, status: string }` — agent status (working|idle|done|…)
 *
 * Seal rules:
 * - silence ≥ silenceMs (default 2000) between events
 * - status transition working → idle|done
 *
 * @param {Array<{ts:number, lines?:string[], status?:string}>} events
 * @param {{ silenceMs?: number, now?: () => number }} [options]
 * @returns {Array<{ts:number, text:string, sealed:boolean}>}
 */
export function foldBubbles(events, options = {}) {
  const silenceMs = options.silenceMs ?? 2000;
  // Clock injectable for callers that want wall-clock seals; sequence uses event.ts.
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  void now;

  /** @type {Array<{ts:number, text:string, sealed:boolean}>} */
  const bubbles = [];
  /** @type {string[]} */
  let openLines = [];
  /** @type {number|null} */
  let openTs = null;
  /** @type {number|null} */
  let lastEventTs = null;
  /** @type {string|null} */
  let lastStatus = null;

  function seal() {
    if (!openLines.length) {
      openTs = null;
      return;
    }
    const cleaned = compressBlankLines(
      openLines.map((l) => stripAnsi(l))
    );
    // Drop leading/trailing pure blanks after compress.
    while (cleaned.length && cleaned[0] === '') cleaned.shift();
    while (cleaned.length && cleaned[cleaned.length - 1] === '') cleaned.pop();
    if (cleaned.length) {
      bubbles.push({
        ts: openTs ?? lastEventTs ?? 0,
        text: cleaned.join('\n'),
        sealed: true,
      });
    }
    openLines = [];
    openTs = null;
  }

  const list = Array.isArray(events) ? events : [];
  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;
    const ts = Number(ev.ts) || 0;

    if (lastEventTs != null && openLines.length && ts - lastEventTs >= silenceMs) {
      seal();
    }

    if (typeof ev.status === 'string') {
      const status = ev.status;
      if (
        lastStatus === 'working' &&
        (status === 'idle' || status === 'done')
      ) {
        seal();
      }
      lastStatus = status;
      lastEventTs = ts;
      continue;
    }

    if (Array.isArray(ev.lines) && ev.lines.length) {
      if (openTs == null) openTs = ts;
      for (const line of ev.lines) {
        openLines.push(String(line));
      }
    }

    lastEventTs = ts;
  }

  // Trailing open content becomes a sealed bubble (end of sequence).
  seal();
  return bubbles;
}
