/**
 * Tier B: pure functions for terminal-stream bubbles.
 * Clock / silence threshold injectable for tests.
 */

/**
 * OSC sequences (ESC ] ...) terminated by BEL or ST (ESC \).
 * Stripped before the generic CSI regex, which would otherwise leak part
 * of an ST-terminated payload. Unterminated payloads (screen slices) are
 * consumed up to the next control byte so no fragment leaks into text.
 */
const OSC_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;

/** CSI / common ANSI strip. */
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
    .replace(OSC_RE, '')
    .replace(ANSI_RE, '')
    // BEL / stray ESC leftovers after partial strip
    .replace(/[\u0007\u001b]/g, '');
}

/**
 * Box-drawing range U+2500–U+257F (─ │ ╭ ╮ ╰ ╯ ├ ┤ ═ ║ …).
 * Deliberately excludes block elements (█ ░ ▓) — progress bars carry meaning.
 */
const DECORATIVE_LINE_RE = /^[\s─-╿]+$/;
/**
 * Vertical frame borders strippable at line edges: │ ┃ ║.
 * Leading indentation before a border belongs to the frame, not the text.
 */
const LEADING_BORDER_RE = /^[ \t]*[│┃║] ?/;
const TRAILING_BORDER_RE = / *[│┃║]$/;

/**
 * Claude Code / TUI spinner & ephemeral status rows — structural match,
 * not a glyph-only kill switch. A spinner line is:
 *   <rotation glyph> <Status word(s)>[…] [timing / token annotations]
 * or a completion note:
 *   <rotation glyph> <Worked|Crunched|Cogitated|…> for <duration> [· extras]
 *
 * `●` / `◆` / `◈` are deliberately NOT rotation glyphs — they mark body
 * bullets and tool rows in Claude Code TUI and must never be filtered.
 * Deliberately excludes block-element progress bars (███░░░).
 */
const SPINNER_GLYPH_RE =
  /^[ \t]*([✻✶✳✢✽✹✸✷✺✦✧★☆·∙•◦○◉◎◐◓◑◒*⠀-⣿])(?:[ \t]+(\S.*))?$/;

/**
 * Glyphs that only ever appear as spinner rotation frames (never as body
 * bullets): Claude Code star rotation set, circle rotation set, braille.
 * A bare status word after one of these is enough (`⠋ running`).
 */
const PURE_SPINNER_GLYPH_RE = /^[✻✶✳✢✽✹✸✷✺◐◓◑◒⠀-⣿]$/;

/** Completion note: `Crunched for 2m 41s`, `Cogitated for 31s · 1 shell still running`. */
const SPINNER_DONE_NOTE_RE = /^[A-Za-z]+ for \d+(?:\.\d+)?(?:h|ms|m|s)\b/;

/** Status phrase: 1–3 Latin words, optional ellipsis, rest = annotations. */
const SPINNER_PHRASE_RE =
  /^([A-Za-z][A-Za-z'-]*(?: [A-Za-z][A-Za-z'-]*){0,2})(…|\.{3})?(?:[ \t]+(.*))?$/;

/**
 * One annotation token: elapsed durations (`12s`, `2m`, `6m7s`, `1h2m`),
 * token counters (`3.2k`, `⇣80.2k`, `↓`), the word `tokens`.
 */
const SPINNER_ANNOTATION_TOKEN_RE =
  /^(?:\d+(?:\.\d+)?(?:h|ms|m|s|k)?|\d+h\d+m?|\d+m\d+s|[↓⇣↑⇡](?:\d+(?:\.\d+)?[km]?)?|tokens?)$/i;

/**
 * True when a spinner tail is timing/token chrome only: parenthetical and
 * bracket groups (`(1m 34s · ↓ 3.2k tokens)`, `[stop]`) are chrome by
 * position; remaining tokens must all be annotation tokens.
 * @param {string} tail
 * @returns {boolean}
 */
function isSpinnerAnnotationTail(tail) {
  const t = String(tail ?? '')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\[[^\][]*\]/g, ' ')
    .trim();
  if (!t) return true;
  return t
    .split(/[\s·]+/)
    .every((tok) => SPINNER_ANNOTATION_TOKEN_RE.test(tok));
}

/**
 * True for lines made only of box-drawing chars and whitespace
 * (frame tops/bottoms, ── separators, ├──┤ rules). Blank lines are not
 * decorative — they are handled by blank compression.
 * @param {string} line
 * @returns {boolean}
 */
export function isDecorativeLine(line) {
  const s = String(line ?? '');
  return s.trim() !== '' && DECORATIVE_LINE_RE.test(s);
}

/**
 * True for ephemeral TUI spinner / thinking indicator lines.
 * @param {string} line
 * @returns {boolean}
 */
export function isSpinnerLine(line) {
  const s = stripAnsi(String(line ?? '')).replace(/\s+$/, '');
  if (!s.trim()) return false;
  const m = s.match(SPINNER_GLYPH_RE);
  if (!m) return false;
  const glyph = m[1];
  const rest = (m[2] ?? '').trim();
  // Lone rotation glyph is redraw noise.
  if (!rest) return true;
  // `✻ Crunched for 2m 41s`, `✻ Cogitated for 31s · 1 shell still running`
  if (SPINNER_DONE_NOTE_RE.test(rest)) return true;
  const pm = rest.match(SPINNER_PHRASE_RE);
  if (!pm) return false;
  const hasEllipsis = Boolean(pm[2]);
  const tail = pm[3] ?? '';
  if (!isSpinnerAnnotationTail(tail)) return false;
  if (PURE_SPINNER_GLYPH_RE.test(glyph)) return true;
  // Bullet-capable glyphs (* · • ✦ …): require the ellipsis or a
  // timing/token tail so real list items like `* done` survive.
  return hasEllipsis || tail.trim() !== '';
}

/** Model footer: `Opus 4.8 · pocket-term-2 · ⎇ master* · +961/-87`. */
const CHROME_MODEL_FOOTER_RE = / · ⎇ /;
/** Mode footer: `⏵⏵ auto mode on · 1 shell · ← for agents`. */
const CHROME_MODE_FOOTER_RE = /^⏵/;
/** Bare `❯` prompt row (a `❯ cmd` echo is content and is kept). */
const CHROME_BARE_PROMPT_RE = /^❯$/;
/** One hotkey-bar token: `Shift+Tab:mode`, `Ctrl+c:cancel`, `Ctrl+x:shortcuts`. */
const CHROME_HOTKEY_TOKEN_RE =
  /(?:shift|ctrl|alt|opt|cmd|esc|tab|enter|space|fn|f\d{1,2})(?:\+[\w↑↓←→]+)*:\S+/gi;
/** Interrupt hint row: `esc to interrupt` (also parenthesized). */
const CHROME_INTERRUPT_HINT_RE = /^\(?esc(?:ape)? to interrupt\)?$/i;
/** Auto-approval footnote. */
const CHROME_CLASSIFIER_RE = /^(?:allowed|denied) by .{0,60}classifier$/i;
/** grok status tail: `6m7s ⇣80.2k [stop]` (wrapped without its spinner glyph). */
const CHROME_STOP_TAIL_RE = /\[stop\]$/i;

/**
 * True for TUI chrome rows that are UI furniture, not conversation
 * content: model/mode footers, bare prompt rows, hotkey bars, interrupt
 * hints, auto-approval footnotes and `[stop]` status tails.
 * @param {string} line
 * @returns {boolean}
 */
export function isChromeLine(line) {
  const s = stripAnsi(String(line ?? '')).replace(/\s+$/, '');
  const t = s.trim();
  if (!t) return false;
  if (CHROME_MODEL_FOOTER_RE.test(s)) return true;
  if (CHROME_MODE_FOOTER_RE.test(t)) return true;
  if (CHROME_BARE_PROMPT_RE.test(t)) return true;
  if (CHROME_INTERRUPT_HINT_RE.test(t)) return true;
  if (CHROME_CLASSIFIER_RE.test(t)) return true;
  // Hotkey bar: at least two key:action tokens on one row.
  const hotkeys = t.match(CHROME_HOTKEY_TOKEN_RE);
  if (hotkeys && hotkeys.length >= 2) return true;
  // `… [stop]` where everything before is timing/token annotations.
  if (CHROME_STOP_TAIL_RE.test(t)) {
    const prefix = t.replace(CHROME_STOP_TAIL_RE, '').trim();
    if (isSpinnerAnnotationTail(prefix)) return true;
  }
  return false;
}

/**
 * Content line usable for full-redraw set-diff (not blank / frame / spinner / chrome).
 * @param {string} line already ANSI-stripped preferred
 * @returns {string|null} normalized key or null if noise
 */
function contentLineKey(line) {
  const cleaned = stripAnsi(String(line ?? '')).replace(/\s+$/, '');
  if (!cleaned.trim()) return null;
  if (isDecorativeLine(cleaned)) return null;
  if (isSpinnerLine(cleaned)) return null;
  if (isChromeLine(cleaned)) return null;
  return cleaned;
}

/**
 * Strip a single leading and/or trailing vertical frame border (│ ┃ ║)
 * with its padding space. Interior verticals are kept so table rows like
 * `│ a │ b │` stay readable as `a │ b`.
 * @param {string} line
 * @returns {string}
 */
export function stripFrameBorders(line) {
  let s = String(line ?? '').replace(/\s+$/, '');
  s = s.replace(LEADING_BORDER_RE, '');
  s = s.replace(TRAILING_BORDER_RE, '');
  return s;
}

/**
 * Tier B display cleaning for one sealed bubble's raw terminal lines:
 * strip ANSI, trim trailing pad spaces, drop decorative frame lines,
 * peel side borders, compress blank runs. Text content — including CJK,
 * mixed `── Title ──` headers, and table interiors — is preserved.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function cleanStreamLines(lines) {
  const cleaned = (Array.isArray(lines) ? lines : []).map((raw) => {
    const noAnsi = stripAnsi(String(raw)).replace(/\s+$/, '');
    if (noAnsi === '') return '';
    if (isDecorativeLine(noAnsi)) return '';
    if (isSpinnerLine(noAnsi)) return '';
    if (isChromeLine(noAnsi)) return '';
    return stripFrameBorders(noAnsi);
  });
  const out = compressBlankLines(cleaned);
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
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
 * Append/scroll paths prefer over-including. Full-redraw (no common
 * anchor) filters decorative/spinner noise and only emits content lines
 * not already present in prev — short-window bubble dedupe in
 * state-manager catches any remaining redraw spam.
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

  // Full redraw / no common anchor: do not dump the whole window.
  // Drop frame/spinner noise; emit only content lines absent from prev.
  const prevContent = new Set();
  for (const pl of prevLines) {
    const key = contentLineKey(pl);
    if (key != null) prevContent.add(key);
  }
  const out = [];
  for (const nl of nextLines) {
    const key = contentLineKey(nl);
    if (key == null) continue;
    if (prevContent.has(key)) continue;
    out.push(nl);
  }
  return out;
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
    // cleanStreamLines also drops leading/trailing blanks after compress.
    const cleaned = cleanStreamLines(openLines);
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
