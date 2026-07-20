/* Safe, deliberately small Markdown renderer for the chat preview. */

export const MARKDOWN_MAX_BYTES = 512 * 1024;
export const MARKDOWN_MAX_LINES = 4096;
export const MARKDOWN_MAX_BLOCKS = 2048;

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const BLOCK_START_RE = /^(?: {0,3}(?:#{1,6}(?:[ \t]+|$)|>|(?:[-+*]|\d+[.)])[ \t]+)| {0,3}(?:```+|~~~+)| {0,3}(?:---+|___+|\*\*\*+)[ \t]*)$/;

/**
 * Normalize untrusted Markdown without interpreting HTML.
 * @param {unknown} source
 * @returns {string}
 */
export function normalizeMarkdown(source) {
  return String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '\ufffd')
    .replace(CONTROL_RE, (ch) => (ch === '\t' ? '\t' : ''))
    .slice(0, MARKDOWN_MAX_BYTES);
}

/**
 * Allow only explicit web/mail schemes. Protocol-relative, data, javascript,
 * file and custom schemes remain plain text.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeMarkdownUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return false;
  if (!/^(?:https?:\/\/|mailto:)/i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function appendText(parent, text, doc) {
  if (text) parent.append(doc.createTextNode(text));
}

/**
 * Render inline Markdown directly to DOM nodes. No HTML string is ever built.
 * @param {HTMLElement} parent
 * @param {string} source
 * @param {Document} doc
 * @param {number} depth
 */
function renderInline(parent, source, doc, depth = 0) {
  const s = String(source ?? '').slice(0, 8192);
  if (depth > 4) {
    appendText(parent, s, doc);
    return;
  }
  let plain = '';
  const flush = () => {
    if (plain) appendText(parent, plain, doc);
    plain = '';
  };
  for (let i = 0; i < s.length;) {
    if (s[i] === '\\' && i + 1 < s.length && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(s[i + 1])) {
      plain += s[i + 1];
      i += 2;
      continue;
    }
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        const code = doc.createElement('code');
        code.textContent = s.slice(i + 1, end).replace(/\s+/g, ' ').trim();
        parent.append(code);
        i = end + 1;
        continue;
      }
    }
    if (s[i] === '!' && s[i + 1] === '[') {
      // Images are intentionally inert text, never an <img> or link.
      const end = s.indexOf(')', i + 2);
      if (end >= 0 && s.slice(i, end + 1).includes('](')) {
        plain += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (s[i] === '[') {
      const closeText = s.indexOf(']', i + 1);
      const openDest = closeText >= 0 ? s.indexOf('(', closeText + 1) : -1;
      const closeDest = openDest >= 0 ? s.indexOf(')', openDest + 1) : -1;
      if (closeText > i + 1 && openDest === closeText + 1 && closeDest > openDest + 1) {
        const label = s.slice(i + 1, closeText);
        const destPart = s.slice(openDest + 1, closeDest).trim();
        const dest = destPart.split(/[ \t]+/, 1)[0];
        if (isSafeMarkdownUrl(dest)) {
          flush();
          const a = doc.createElement('a');
          a.textContent = label;
          a.href = dest;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          parent.append(a);
          i = closeDest + 1;
          continue;
        }
      }
    }
    let marker = null;
    let tag = null;
    if (s.startsWith('**', i) || s.startsWith('__', i)) {
      marker = s.slice(i, i + 2);
      tag = 'strong';
    } else if (s[i] === '*' || s[i] === '_') {
      marker = s[i];
      tag = 'em';
    }
    if (marker) {
      const end = s.indexOf(marker, i + marker.length);
      if (end > i + marker.length) {
        flush();
        const node = doc.createElement(tag);
        renderInline(node, s.slice(i + marker.length, end), doc, depth + 1);
        parent.append(node);
        i = end + marker.length;
        continue;
      }
    }
    if (s[i] === '\n') {
      flush();
      parent.append(doc.createElement('br'));
      i += 1;
      continue;
    }
    plain += s[i];
    i += 1;
  }
  flush();
}

function appendInline(parent, text, doc) {
  renderInline(parent, String(text ?? ''), doc);
}

function makeParagraph(lines, doc, tag = 'p') {
  const node = doc.createElement(tag);
  appendInline(node, lines.join('\n'), doc);
  return node;
}

function isFence(line) {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line);
}

/**
 * Render a bounded Markdown document into an existing element.
 * Raw HTML is always text; unsupported constructs degrade to text.
 * @param {HTMLElement} container
 * @param {unknown} source
 * @param {Document} [doc]
 * @returns {{ truncated: boolean, blocks: number }}
 */
export function renderMarkdownDocument(container, source, doc = container?.ownerDocument || document) {
  if (!container || !doc) return { truncated: false, blocks: 0 };
  container.replaceChildren();
  const normalized = normalizeMarkdown(source);
  const sourceBytes = new TextEncoder().encode(String(source ?? '')).length;
  const truncated = sourceBytes > MARKDOWN_MAX_BYTES;
  const lines = normalized.split('\n').slice(0, MARKDOWN_MAX_LINES);
  let blocks = 0;
  const add = (node) => {
    if (blocks >= MARKDOWN_MAX_BLOCKS) return false;
    container.append(node);
    blocks += 1;
    return true;
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = isFence(line);
    if (fence) {
      const marker = fence[1][0];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker}{${fence[1].length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = body.join('\n');
      pre.append(code);
      add(pre);
      continue;
    }
    const heading = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
    if (heading) {
      let text = heading[3].replace(/[ \t]+#+[ \t]*$/, '').trim();
      add(makeParagraph([text], doc, `h${heading[2].length}`));
      i += 1;
      continue;
    }
    if (/^ {0,3}(?:---+|___+|\*\*\*+)[ \t]*$/.test(line)) {
      add(doc.createElement('hr'));
      i += 1;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote = doc.createElement('blockquote');
      const quoteLines = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''));
        i += 1;
      }
      quote.append(makeParagraph(quoteLines, doc));
      add(quote);
      continue;
    }
    const listMatch = /^ {0,3}([-+*]|\d+[.)])[ \t]+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const list = doc.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const item = /^ {0,3}([-+*]|\d+[.)])[ \t]+(.*)$/.exec(lines[i]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const li = doc.createElement('li');
        li.append(makeParagraph([item[2]], doc));
        list.append(li);
        i += 1;
      }
      add(list);
      continue;
    }
    const paragraph = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !BLOCK_START_RE.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    add(makeParagraph(paragraph, doc));
  }
  if (truncated || lines.length >= MARKDOWN_MAX_LINES || blocks >= MARKDOWN_MAX_BLOCKS) {
    const note = doc.createElement('p');
    note.className = 'markdown-truncated';
    note.textContent = '文档过大，预览已截断。';
    container.append(note);
  }
  return { truncated, blocks };
}

/** @param {string} pathValue */
export function markdownFilename(pathValue) {
  const raw = String(pathValue ?? '');
  const base = raw.split('/').pop() || '文档.md';
  return base.endsWith('.md') || base.endsWith('.MD') ? base : `${base}.md`;
}
