/* Chat attachment token helpers: images and Markdown documents only. */

export const ATTACH_ROOT = '/srv/term-uploads/';
export const ATTACH_IMAGE_RE = /\.(?:jpg|jpeg|png|webp|gif)$/i;
export const ATTACH_DOCUMENT_RE = /\.md$/i;

function safePath(value, extension) {
  const s = String(value || '');
  if (!s.startsWith(ATTACH_ROOT)) return false;
  const rest = s.slice(ATTACH_ROOT.length);
  if (!rest || rest.includes('/') || rest.includes('\\') || rest.includes('..')) return false;
  return extension.test(rest);
}

export function isChatUploadImagePath(value) {
  return safePath(value, ATTACH_IMAGE_RE);
}

export function isChatUploadDocumentPath(value) {
  return safePath(value, ATTACH_DOCUMENT_RE);
}

/**
 * @param {string|null|undefined} text
 * @returns {Array<{type:'text',text:string}|{type:'image'|'document',path:string}>}
 */
export function parseMessageSegments(text) {
  const s = String(text ?? '');
  if (!s) return [{ type: 'text', text: '' }];
  const hits = [];
  const add = (type, path, start, end) => {
    const valid = type === 'image' ? isChatUploadImagePath(path) : isChatUploadDocumentPath(path);
    if (valid) hits.push({ type, path, start, end });
  };
  for (const [label, type] of [['图片', 'image'], ['文档', 'document']]) {
    const re = new RegExp(`\\[${label}:\\s*(\\/srv\\/term-uploads\\/[^\\]\\n]+?)\\]`, 'g');
    let m;
    while ((m = re.exec(s)) !== null) add(type, m[1].trim(), m.index, m.index + m[0].length);
  }
  const bare = /(\/srv\/term-uploads\/[^\s\[\]<>"']+\.(?:jpg|jpeg|png|webp|gif|md))/gi;
  let m;
  while ((m = bare.exec(s)) !== null) {
    const type = ATTACH_DOCUMENT_RE.test(m[1]) ? 'document' : 'image';
    add(type, m[1], m.index, m.index + m[0].length);
  }
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  const clean = [];
  for (const hit of hits) {
    if (clean.some((x) => hit.start < x.end && x.start < hit.end)) continue;
    clean.push(hit);
  }
  if (!clean.length) return [{ type: 'text', text: s }];
  const out = [];
  let cursor = 0;
  for (const hit of clean) {
    if (hit.start > cursor) out.push({ type: 'text', text: s.slice(cursor, hit.start) });
    out.push({ type: hit.type, path: hit.path });
    cursor = hit.end;
  }
  if (cursor < s.length) out.push({ type: 'text', text: s.slice(cursor) });
  return out;
}

export function composeDocumentSendText(caption, path) {
  const p = String(path || '');
  const cap = String(caption ?? '').trim();
  if (!p) return cap;
  return cap ? `[文档: ${p}] ${cap}` : `[文档: ${p}]`;
}

export function attachmentFilename(path) {
  return String(path || '').split('/').pop() || '文档.md';
}
