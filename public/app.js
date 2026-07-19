/**
 * pocket-term-2 chat SPA — zero-build, hash-routed.
 */
import {
  formatRelativeTime,
  sortPanes,
  mapBubbleToView,
  agentAvatar,
  statusMeta,
  paneTitle,
  groupContacts,
  parseRoute,
  sseBackoffMs,
  refetchAfterSseReconnect,
  shouldShowComposer,
  formatHerdrAbout,
  hotkeyPayload,
  shouldConfirmBeforeSend,
  sendErrorToast,
  dimPercentToCssVar,
  dimToPercent,
  dimPercentToApi,
  wallpaperAssetUrl,
  DIM_SLIDER_MAX,
} from './spa-utils.js';

const APP_VERSION = '0.0.1';
const LS_THEME = 'pt2-theme';
const LS_FONT = 'pt2-font';
const LS_CONFIRM_SEND = 'pt2-confirm-send';
const LS_LOCAL_READONLY = 'pt2-local-readonly';

/** API base: /herd when served under /herd/ */
function apiBase() {
  const p = location.pathname.replace(/\/index\.html$/i, '');
  if (p.endsWith('/herd')) return '/herd';
  if (p.includes('/herd/')) {
    const i = p.indexOf('/herd');
    return p.slice(0, i + '/herd'.length);
  }
  // Dev fallback if opened oddly
  return p.endsWith('/') ? p.slice(0, -1) || '' : p || '';
}

const BASE = apiBase();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === false || v == null) {
      /* skip */
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** @type {object|null} */
let state = null;
/** @type {string|null} */
let activePaneId = null;
/** @type {Map<string, object>} */
const bubbleStore = new Map(); // paneId -> { items: [], oldestTs }
/** @type {EventSource|null} */
let es = null;
let sseAttempt = 0;
let sseTimer = null;
let connMode = 'unknown'; // ok | warn | err | unknown
let stickToBottom = true;
let loadingEarlier = false;
let bootFailed = false; // first state fetch failed → offline empty-state
let sending = false;
/** @type {HTMLElement|null} */
let toastHost = null;
/** @type {{ wallpaper: string|null, dim: number }} */
let userSettings = { wallpaper: null, dim: 0.35 };
/** @type {Array<{ name: string, size: number }>} */
let wallpaperCatalog = [];
/** @type {ReturnType<typeof setTimeout>|null} */
let dimSaveTimer = null;
let wallpaperPanelOpen = false;

// —— settings ——
function getLocalPrefs() {
  return {
    confirmBeforeSend: localStorage.getItem(LS_CONFIRM_SEND) === '1',
    localReadonly: localStorage.getItem(LS_LOCAL_READONLY) === '1',
  };
}

/**
 * Apply wallpaper + dim to #wallpaper / #dim / html class (live preview).
 * @param {{ wallpaper?: string|null, dim?: number }} s
 */
function applyWallpaperVisual(s) {
  const wallpaper = s.wallpaper === undefined ? userSettings.wallpaper : s.wallpaper;
  const dim = s.dim === undefined ? userSettings.dim : s.dim;
  const percent = dimToPercent(dim);
  document.documentElement.style.setProperty(
    '--wallpaper-dim',
    dimPercentToCssVar(percent)
  );
  const slider = /** @type {HTMLInputElement|null} */ ($('#dim-slider'));
  if (slider) {
    slider.max = String(DIM_SLIDER_MAX);
    slider.value = String(percent);
    slider.disabled = false;
  }
  const dimVal = $('#dim-value');
  if (dimVal) dimVal.textContent = `${percent}%`;

  const layer = /** @type {HTMLElement|null} */ ($('#wallpaper'));
  const has = typeof wallpaper === 'string' && wallpaper.length > 0;
  document.documentElement.classList.toggle('has-wallpaper', has);
  if (layer) {
    if (has) {
      const url = wallpaperAssetUrl(BASE, wallpaper);
      layer.style.backgroundImage = `url("${url}")`;
    } else {
      layer.style.backgroundImage = 'none';
    }
  }

  // Card summary on 我 page
  const sub = $('#wallpaper-card-sub');
  if (sub) {
    sub.textContent = has ? wallpaper : '无壁纸 · 主题底色';
  }
  const thumb = /** @type {HTMLElement|null} */ ($('#wallpaper-card-thumb'));
  if (thumb) {
    if (has) {
      thumb.style.backgroundImage = `url("${wallpaperAssetUrl(BASE, wallpaper)}")`;
      thumb.classList.add('has-image');
    } else {
      thumb.style.backgroundImage = '';
      thumb.classList.remove('has-image');
    }
  }
}

function loadSettings() {
  const theme = localStorage.getItem(LS_THEME) || 'dark';
  const font = localStorage.getItem(LS_FONT) || 'md';
  const prefs = getLocalPrefs();
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-font', font);
  applyWallpaperVisual(userSettings);
  $$('.seg-btn[data-theme-set]').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeSet === theme);
  });
  $$('.seg-btn[data-font-set]').forEach((b) => {
    b.classList.toggle('active', b.dataset.fontSet === font);
  });
  const ver = $('#app-version');
  if (ver) ver.textContent = APP_VERSION;
  const confirmEl = /** @type {HTMLInputElement|null} */ (
    $('#toggle-confirm-send')
  );
  if (confirmEl) confirmEl.checked = prefs.confirmBeforeSend;
  const roEl = /** @type {HTMLInputElement|null} */ (
    $('#toggle-local-readonly')
  );
  if (roEl) roEl.checked = prefs.localReadonly;
  // Keep browser chrome color in sync with the in-app theme toggle.
  const chrome = $('meta[name="theme-color"]:not([media])');
  if (chrome) {
    chrome.setAttribute('content', theme === 'light' ? '#fffaf3' : '#232136');
  }
  updateHerdrAbout();
  updateComposerVisibility();
}

function setTheme(theme) {
  localStorage.setItem(LS_THEME, theme);
  loadSettings();
}
function setFont(font) {
  localStorage.setItem(LS_FONT, font);
  loadSettings();
}

/**
 * Pull settings from bridge state payload.
 * @param {object|null|undefined} next
 */
function ingestServerSettings(next) {
  const s = next?.settings;
  if (!s || typeof s !== 'object') return;
  if ('wallpaper' in s) {
    userSettings.wallpaper =
      s.wallpaper === null || s.wallpaper === ''
        ? null
        : String(s.wallpaper);
  }
  if (typeof s.dim === 'number' && Number.isFinite(s.dim)) {
    userSettings.dim = s.dim;
  }
  applyWallpaperVisual(userSettings);
  if (wallpaperPanelOpen) renderWallpaperPanel();
}

async function fetchWallpapers() {
  const res = await fetch(`${BASE}/api/wallpapers`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`wallpapers ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body?.wallpapers)
    ? body.wallpapers
    : Array.isArray(body)
      ? body
      : [];
  wallpaperCatalog = list
    .filter((x) => x && typeof x.name === 'string')
    .map((x) => ({ name: x.name, size: Number(x.size) || 0 }));
  return wallpaperCatalog;
}

/**
 * POST settings patch; updates local userSettings on success.
 * @param {{ wallpaper?: string|null, dim?: number }} patch
 */
async function postSettings(patch) {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(body?.error || `settings ${res.status}`);
  }
  if (body && typeof body === 'object') {
    if ('wallpaper' in body) {
      userSettings.wallpaper =
        body.wallpaper === null || body.wallpaper === ''
          ? null
          : String(body.wallpaper);
    }
    if (typeof body.dim === 'number') userSettings.dim = body.dim;
  } else {
    Object.assign(userSettings, patch);
  }
  applyWallpaperVisual(userSettings);
  return body;
}

function renderWallpaperPanel() {
  const panel = $('#wallpaper-panel');
  if (!panel) return;
  panel.replaceChildren();

  const noneBtn = el(
    'button',
    {
      type: 'button',
      className: `wallpaper-option${userSettings.wallpaper == null ? ' selected' : ''}`,
      role: 'option',
      'aria-selected': userSettings.wallpaper == null ? 'true' : 'false',
      onClick: () => selectWallpaper(null),
    },
    [
      el('span', { className: 'wallpaper-option-thumb none', text: '∅' }),
      el('span', { className: 'wallpaper-option-label', text: '无壁纸' }),
    ]
  );
  panel.append(noneBtn);

  if (!wallpaperCatalog.length) {
    panel.append(
      el('div', {
        className: 'wallpaper-empty',
        text: '暂无可用壁纸',
      })
    );
    return;
  }

  for (const item of wallpaperCatalog) {
    const selected = userSettings.wallpaper === item.name;
    const thumb = el('span', {
      className: 'wallpaper-option-thumb',
      style: `background-image:url("${wallpaperAssetUrl(BASE, item.name)}")`,
    });
    const btn = el(
      'button',
      {
        type: 'button',
        className: `wallpaper-option${selected ? ' selected' : ''}`,
        role: 'option',
        'aria-selected': selected ? 'true' : 'false',
        title: item.name,
        onClick: () => selectWallpaper(item.name),
      },
      [
        thumb,
        el('span', { className: 'wallpaper-option-label', text: item.name }),
      ]
    );
    panel.append(btn);
  }
}

/**
 * @param {string|null} name
 */
async function selectWallpaper(name) {
  // Optimistic visual
  applyWallpaperVisual({ wallpaper: name });
  userSettings.wallpaper = name;
  renderWallpaperPanel();
  try {
    await postSettings({ wallpaper: name });
  } catch {
    showToast('壁纸保存失败', 'err');
  }
}

async function toggleWallpaperPanel() {
  const panel = $('#wallpaper-panel');
  const btn = $('#btn-wallpaper');
  if (!panel) return;
  wallpaperPanelOpen = !wallpaperPanelOpen;
  panel.classList.toggle('hidden', !wallpaperPanelOpen);
  btn?.setAttribute('aria-expanded', wallpaperPanelOpen ? 'true' : 'false');
  if (wallpaperPanelOpen) {
    try {
      await fetchWallpapers();
    } catch {
      showToast('无法加载壁纸列表', 'warn');
    }
    renderWallpaperPanel();
  }
}

/**
 * Live dim preview + debounced persist.
 * @param {number} percent
 */
function onDimSliderInput(percent) {
  const css = dimPercentToCssVar(percent);
  document.documentElement.style.setProperty('--wallpaper-dim', css);
  const dimVal = $('#dim-value');
  if (dimVal) dimVal.textContent = `${Math.round(Number(percent) || 0)}%`;
  userSettings.dim = dimPercentToApi(percent);
  if (dimSaveTimer) clearTimeout(dimSaveTimer);
  dimSaveTimer = setTimeout(() => {
    dimSaveTimer = null;
    postSettings({ dim: userSettings.dim }).catch(() => {
      showToast('暗化设置保存失败', 'err');
    });
  }, 280);
}

function updateHerdrAbout() {
  const elAbout = $('#herdr-about');
  if (elAbout) elAbout.textContent = formatHerdrAbout(state);
}

/**
 * @param {string} message
 * @param {'info'|'warn'|'err'} [kind]
 */
function showToast(message, kind = 'info') {
  if (!toastHost) {
    toastHost = el('div', {
      className: 'toast-host',
      id: 'toast-host',
      'aria-live': 'polite',
    });
    document.body.append(toastHost);
  }
  const node = el('div', {
    className: `toast${kind === 'info' ? '' : ` ${kind}`}`,
    text: message,
  });
  toastHost.append(node);
  setTimeout(() => {
    try {
      node.remove();
    } catch {
      /* ignore */
    }
  }, 2800);
}

function updateComposerVisibility() {
  const show = shouldShowComposer(state, getLocalPrefs());
  const composer = $('#composer');
  const roBar = $('#readonly-bar');
  if (composer) composer.classList.toggle('hidden', !show);
  if (roBar) {
    roBar.classList.toggle('hidden', show);
    if (state?.readonly) {
      roBar.textContent = '只读模式 · 服务端已关闭发送';
    } else if (getLocalPrefs().localReadonly) {
      roBar.textContent = '只读模式 · 本机开关已开';
    } else {
      roBar.textContent = '只读模式 · 无法发送';
    }
  }
}

// —— connection LED ——
function setConn(mode, label) {
  connMode = mode;
  const led = $('#conn-led');
  if (!led) return;
  led.classList.remove('ok', 'warn', 'err');
  if (mode === 'ok' || mode === 'warn' || mode === 'err') {
    led.classList.add(mode);
  }
  led.setAttribute('aria-label', `连接状态：${label}`);
  led.title = label;
}

// —— fetch helpers ——
async function fetchState() {
  const res = await fetch(`${BASE}/api/state`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json();
}

async function fetchMessages(paneId, { before, limit = 40 } = {}) {
  const q = new URLSearchParams();
  if (before != null) q.set('before', String(before));
  q.set('limit', String(limit));
  const res = await fetch(
    `${BASE}/api/pane/${encodeURIComponent(paneId)}/messages?${q}`,
    { cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`messages ${res.status}`);
  return res.json();
}

async function postSeen(paneId) {
  if (!paneId) return;
  try {
    await fetch(`${BASE}/api/seen/${encodeURIComponent(paneId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    /* ignore */
  }
}

/**
 * POST /herd/api/pane/:id/send
 * @param {string} paneId
 * @param {string} text
 * @param {'run'|'text'} [mode]
 */
async function postSend(paneId, text, mode = 'run') {
  const res = await fetch(
    `${BASE}/api/pane/${encodeURIComponent(paneId)}/send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode }),
    }
  );
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

/**
 * @param {{
 *   text: string,
 *   mode?: 'run'|'text',
 *   clearInput?: boolean,
 *   skipConfirm?: boolean,
 *   label?: string,
 * }} opts
 */
async function sendToActivePane(opts) {
  const paneId = activePaneId;
  if (!paneId || sending) return;
  if (!shouldShowComposer(state, getLocalPrefs())) {
    showToast('当前为只读模式', 'warn');
    return;
  }
  const text = opts.text ?? '';
  const mode = opts.mode === 'text' ? 'text' : 'run';
  if (
    !opts.skipConfirm &&
    shouldConfirmBeforeSend(getLocalPrefs(), text, {
      skipEmpty: mode === 'run' && !text,
    })
  ) {
    const preview =
      text === ''
        ? opts.label || '回车'
        : text.length > 80
          ? `${text.slice(0, 80)}…`
          : text;
    const ok = window.confirm(`发送到当前会话？\n\n${preview}`);
    if (!ok) return;
  }

  sending = true;
  const btn = /** @type {HTMLButtonElement|null} */ ($('#btn-send'));
  if (btn) btn.disabled = true;
  try {
    const { res, body } = await postSend(paneId, text, mode);
    if (!res.ok) {
      showToast(sendErrorToast(res.status, body), res.status === 429 ? 'warn' : 'err');
      return;
    }
    // Optimistic right bubble for typed text (SSE may also deliver; deduped ±10s).
    if (text) {
      const ts = Date.now();
      appendBubble(paneId, {
        id: `local-user:${paneId}:${ts}`,
        ts,
        text,
        role: 'user',
      });
    }
    if (opts.clearInput !== false) {
      const input = /** @type {HTMLTextAreaElement|null} */ ($('#composer-input'));
      if (input) {
        input.value = '';
        autoSizeComposer(input);
      }
    }
  } catch {
    showToast('发送失败：网络错误', 'err');
  } finally {
    sending = false;
    if (btn) btn.disabled = false;
  }
}

function autoSizeComposer(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(40, input.scrollHeight))}px`;
}

// —— list rendering ——
/** Loading / offline placeholder while no state yet; null once state exists. */
function pendingStateNode() {
  if (state != null) return null;
  if (bootFailed) {
    return el('div', {
      className: 'empty offline',
      text: '无法连接服务 · 点顶部圆点重试',
    });
  }
  return el('div', { className: 'empty loading', text: '加载中…' });
}

function renderChatList() {
  const root = $('#chat-list');
  if (!root) return;
  root.replaceChildren();
  const pending = pendingStateNode();
  if (pending) {
    root.append(pending);
    return;
  }
  const panes = sortPanes(state?.panes || []);
  if (!panes.length) {
    root.append(el('div', { className: 'empty', text: '暂无会话' }));
    return;
  }
  const now = Date.now();
  for (const p of panes) {
    const av = agentAvatar(p.agent);
    const st = statusMeta(p.agent_status);
    const title = paneTitle(p);
    const row = el('a', {
      className: 'row',
      href: `#/chat/${encodeURIComponent(p.pane_id)}`,
      role: 'listitem',
    });
    const avatar = el('div', {
      className: 'avatar',
      text: av.letter,
      style: `background:${av.color}`,
      title: p.agent || '',
    });
    avatar.append(
      el('span', {
        className: `status-dot ${st.cls}`,
        'aria-label': st.label,
      })
    );
    const summary = el('div', { className: 'row-summary' });
    if (p.agent_status === 'blocked') {
      summary.append(
        el('span', { className: 'row-badge blocked', text: '[等你回复]' })
      );
    } else if (p.agent_status === 'working') {
      summary.append(
        el('span', { className: 'row-badge working', text: '[进行中]' })
      );
    }
    summary.append(document.createTextNode(p.summary || '暂无摘要'));
    const main = el('div', { className: 'row-main' }, [
      el('div', { className: 'row-title', text: title }),
      summary,
    ]);
    const meta = el('div', { className: 'row-meta' }, [
      el('div', {
        className: 'row-time',
        text: formatRelativeTime(p.last_activity, now),
      }),
      p.unread ? el('div', { className: 'unread-dot', 'aria-label': '未读' }) : null,
    ]);
    row.append(avatar, main, meta);
    root.append(row);
  }
}

function renderContacts() {
  const root = $('#contact-list');
  if (!root) return;
  root.replaceChildren();
  const pending = pendingStateNode();
  if (pending) {
    root.append(pending);
    return;
  }
  const groups = groupContacts(state?.panes || []);
  if (!groups.length) {
    root.append(el('div', { className: 'empty', text: '暂无联系人' }));
    return;
  }
  for (const ws of groups) {
    root.append(
      el('div', {
        className: 'group-head',
        text: `${ws.workspace_label} · ${ws.pane_count} 个会话`,
      })
    );
    for (const tab of ws.tabs) {
      root.append(
        el('div', {
          className: 'group-sub',
          text: `标签 ${tab.tab_label}（${tab.pane_count}）`,
        })
      );
      for (const p of tab.panes) {
        const av = agentAvatar(p.agent);
        const st = statusMeta(p.agent_status);
        const row = el('a', {
          className: 'row',
          href: `#/chat/${encodeURIComponent(p.pane_id)}`,
          role: 'listitem',
        });
        const avatar = el('div', {
          className: 'avatar',
          text: av.letter,
          style: `background:${av.color}`,
        });
        avatar.append(
          el('span', {
            className: `status-dot ${st.cls}`,
            'aria-label': st.label,
          })
        );
        row.append(
          avatar,
          el('div', { className: 'row-main' }, [
            el('div', { className: 'row-title', text: paneTitle(p) }),
            el('div', {
              className: 'row-summary',
              text: `${p.agent || 'agent'} · ${p.pane_id}`,
            }),
          ])
        );
        root.append(row);
      }
    }
  }
}

// —— chat view ——
function getPane(paneId) {
  return (state?.panes || []).find((p) => p.pane_id === paneId) || null;
}

function ensureBubbleBucket(paneId) {
  if (!bubbleStore.has(paneId)) {
    bubbleStore.set(paneId, { items: [], ids: new Set() });
  }
  return bubbleStore.get(paneId);
}

function isNearBottom(scroller, threshold = 80) {
  return (
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
    threshold
  );
}

function scrollToBottom(force = false) {
  const sc = $('#bubble-scroll');
  if (!sc) return;
  if (force || stickToBottom) {
    sc.scrollTop = sc.scrollHeight;
    stickToBottom = true;
    $('#btn-jump-bottom')?.classList.add('hidden');
  }
}

/** WeChat-style chip text: HH:MM today, 昨天 HH:MM, else MM-DD HH:MM. */
function timeChipText(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`;
  const now = new Date();
  const dayStart = (x) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (days <= 0) return hm;
  if (days === 1) return `昨天 ${hm}`;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${m}-${dd} ${hm}`;
}

const TIME_CHIP_GAP_MS = 10 * 60 * 1000;

function renderBubbles(paneId) {
  const list = $('#bubble-list');
  if (!list) return;
  const bucket = ensureBubbleBucket(paneId);
  list.replaceChildren();
  let lastChipTs = null;
  for (const msg of bucket.items) {
    const vm = mapBubbleToView(msg);
    if (
      vm.ts != null &&
      (lastChipTs == null || vm.ts - lastChipTs >= TIME_CHIP_GAP_MS)
    ) {
      const chip = timeChipText(vm.ts);
      if (chip) list.append(el('div', { className: 'time-chip', text: chip }));
      lastChipTs = vm.ts;
    }
    const row = el('div', { className: `bubble-row ${vm.side}` });
    const bubble = el('div', {
      className: `bubble ${vm.variant}`,
      text: vm.text || ' ',
    });
    row.append(bubble);
    list.append(row);
  }
  const load = $('#load-earlier');
  if (load) {
    load.classList.toggle('hidden', bucket.items.length < 10);
  }
}

function appendBubble(paneId, msg, { render = true } = {}) {
  const bucket = ensureBubbleBucket(paneId);
  const id = String(msg.id ?? `${msg.ts}:${msg.role}:${msg.text?.slice?.(0, 20)}`);
  if (bucket.ids.has(id)) return false;
  // Dedupe optimistic local user bubble vs SSE/server echo (±10s, same text).
  if (msg.role === 'user') {
    const text = String(msg.text ?? '');
    const ts = Number(msg.ts) || Date.now();
    const dup = bucket.items.some(
      (m) =>
        m.role === 'user' &&
        String(m.text ?? '') === text &&
        Math.abs((Number(m.ts) || 0) - ts) <= 10_000
    );
    if (dup) return false;
  }
  bucket.ids.add(id);
  bucket.items.push({ ...msg, id });
  bucket.items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (render && paneId === activePaneId) {
    const sc = $('#bubble-scroll');
    const follow = sc ? isNearBottom(sc) : true;
    stickToBottom = follow;
    renderBubbles(paneId);
    if (follow) scrollToBottom(true);
    else $('#btn-jump-bottom')?.classList.remove('hidden');
  }
  return true;
}

function mergeMessages(paneId, messages, { prepend = false } = {}) {
  const bucket = ensureBubbleBucket(paneId);
  let added = 0;
  for (const m of messages || []) {
    const id = String(m.id ?? `${m.ts}:${m.role}:${(m.text || '').slice(0, 20)}`);
    if (bucket.ids.has(id)) continue;
    bucket.ids.add(id);
    bucket.items.push({ ...m, id });
    added++;
  }
  bucket.items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (paneId === activePaneId) {
    const sc = $('#bubble-scroll');
    const prevHeight = sc?.scrollHeight || 0;
    const prevTop = sc?.scrollTop || 0;
    renderBubbles(paneId);
    if (prepend && sc) {
      sc.scrollTop = sc.scrollHeight - prevHeight + prevTop;
    } else if (stickToBottom) {
      scrollToBottom(true);
    }
  }
  return added;
}

async function loadChatMessages(paneId, { reset = false } = {}) {
  if (reset) {
    bubbleStore.set(paneId, { items: [], ids: new Set() });
  }
  const messages = await fetchMessages(paneId, { limit: 50 });
  mergeMessages(paneId, messages);
  stickToBottom = true;
  scrollToBottom(true);
}

async function loadEarlier() {
  if (!activePaneId || loadingEarlier) return;
  const bucket = ensureBubbleBucket(activePaneId);
  if (!bucket.items.length) return;
  const oldest = bucket.items[0]?.ts;
  if (oldest == null) return;
  loadingEarlier = true;
  try {
    const messages = await fetchMessages(activePaneId, {
      before: oldest,
      limit: 40,
    });
    mergeMessages(activePaneId, messages, { prepend: true });
  } catch {
    /* ignore */
  } finally {
    loadingEarlier = false;
  }
}

function updateChatHeader(paneId) {
  const pane = getPane(paneId);
  const title = $('#chat-title');
  const dot = $('#chat-status-dot');
  const blocked = $('#blocked-bar');
  if (title) title.textContent = paneTitle(pane || { pane_id: paneId });
  const st = statusMeta(pane?.agent_status);
  if (dot) {
    dot.className = `status-dot ${st.cls}`;
    dot.setAttribute('aria-label', st.label);
  }
  if (blocked) {
    blocked.classList.toggle('hidden', pane?.agent_status !== 'blocked');
  }
}

async function enterChat(paneId) {
  activePaneId = paneId;
  updateChatHeader(paneId);
  stickToBottom = true;
  try {
    await loadChatMessages(paneId, { reset: true });
  } catch {
    renderBubbles(paneId);
  }
  await postSeen(paneId);
}

async function leaveChat() {
  if (activePaneId) {
    await postSeen(activePaneId);
  }
  activePaneId = null;
}

// —— routing ——
function showView(name) {
  $$('.view').forEach((v) => {
    const match = v.dataset.view === name;
    v.classList.toggle('hidden', !match);
  });
  const chatOpen = name === 'chat';
  document.body.classList.toggle('chat-open', chatOpen);
  $$('#tab-bar .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
}

async function applyRoute() {
  const route = parseRoute(location.hash || '#/chats');
  if (route.name === 'chat' && route.paneId) {
    if (activePaneId && activePaneId !== route.paneId) {
      await leaveChat();
    }
    showView('chat');
    await enterChat(route.paneId);
    return;
  }
  if (activePaneId) await leaveChat();
  if (route.name === 'contacts') {
    showView('contacts');
    renderContacts();
  } else if (route.name === 'me') {
    showView('me');
  } else {
    showView('chats');
    renderChatList();
  }
}

// —— state apply ——
function applyState(next) {
  state = next;
  if (next != null) bootFailed = false;
  const herdr = next?.herdr;
  const banner = $('#banner-herdr');
  if (herdr === 'disconnected') {
    banner?.classList.remove('hidden');
    if (connMode !== 'err') setConn('warn', 'herdr 断开');
  } else {
    banner?.classList.add('hidden');
  }
  ingestServerSettings(next);
  updateHerdrAbout();
  updateComposerVisibility();
  if (activePaneId) {
    updateChatHeader(activePaneId);
  }
  const route = parseRoute(location.hash || '#/chats');
  if (route.name === 'chats' || route.name === '' || !location.hash) {
    renderChatList();
  } else if (route.name === 'contacts') {
    renderContacts();
  }
}

// —— SSE ——
function stopSse() {
  if (sseTimer) {
    clearTimeout(sseTimer);
    sseTimer = null;
  }
  if (es) {
    try {
      es.close();
    } catch {
      /* ignore */
    }
    es = null;
  }
}

function scheduleSseReconnect() {
  stopSse();
  setConn('warn', '重连中');
  const delay = sseBackoffMs(sseAttempt);
  sseAttempt += 1;
  sseTimer = setTimeout(() => connectSse(), delay);
}

function connectSse() {
  stopSse();
  // stopSse clears es; reopen
  if (sseTimer) {
    clearTimeout(sseTimer);
    sseTimer = null;
  }
  try {
    es = new EventSource(`${BASE}/api/events`);
  } catch {
    scheduleSseReconnect();
    return;
  }

  es.addEventListener('open', () => {
    sseAttempt = 0;
    setConn('ok', '已连接');
    // Spec: on reconnect, re-pull state + open chat messages (not only wait for SSE).
    refetchAfterSseReconnect({
      fetchState,
      applyState,
      activePaneId,
      reloadMessages: (paneId) => loadChatMessages(paneId, { reset: true }),
    }).catch(() => {
      /* keep stream; next state event may heal */
    });
  });

  es.addEventListener('state', async (ev) => {
    try {
      const data = JSON.parse(ev.data);
      applyState(data);
      setConn(
        data.herdr === 'disconnected' ? 'warn' : 'ok',
        data.herdr === 'disconnected' ? 'herdr 断开' : '已连接'
      );
    } catch {
      /* ignore */
    }
  });

  es.addEventListener('bubble', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const paneId = data.pane_id;
      const bubble = data.bubble;
      if (!paneId || !bubble) return;
      appendBubble(paneId, bubble);
      // refresh list summary via next state event; optimistic summary
      if (state?.panes) {
        const p = state.panes.find((x) => x.pane_id === paneId);
        if (p && bubble.text) {
          const line = String(bubble.text).split('\n').find((l) => l.trim());
          if (line) p.summary = line.trim().slice(0, 120);
          p.last_activity = bubble.ts || Date.now();
          if (parseRoute(location.hash).name === 'chats') renderChatList();
        }
      }
    } catch {
      /* ignore */
    }
  });

  es.onerror = () => {
    setConn('err', '连接断开');
    try {
      es?.close();
    } catch {
      /* ignore */
    }
    es = null;
    scheduleSseReconnect();
  };
}

async function reconnectHard() {
  sseAttempt = 0;
  stopSse();
  setConn('warn', '重连中');
  try {
    const s = await fetchState();
    applyState(s);
    if (activePaneId) {
      await loadChatMessages(activePaneId, { reset: true });
    }
  } catch {
    setConn('err', '拉取失败');
  }
  connectSse();
}

// —— wire UI ——
function wire() {
  $('#conn-led')?.addEventListener('click', () => {
    reconnectHard();
  });
  $('#btn-back')?.addEventListener('click', () => {
    // Prefer history back when we pushed chat; else go list
    if (history.length > 1) history.back();
    else location.hash = '#/chats';
  });
  $('#btn-jump-bottom')?.addEventListener('click', () => {
    stickToBottom = true;
    scrollToBottom(true);
  });
  $('#btn-load-earlier')?.addEventListener('click', () => loadEarlier());
  $('#bubble-scroll')?.addEventListener('scroll', () => {
    const sc = $('#bubble-scroll');
    if (!sc) return;
    stickToBottom = isNearBottom(sc);
    if (stickToBottom) $('#btn-jump-bottom')?.classList.add('hidden');
    // pull earlier near top
    if (sc.scrollTop < 40) loadEarlier();
  });

  $$('.seg-btn[data-theme-set]').forEach((b) => {
    b.addEventListener('click', () => setTheme(b.dataset.themeSet));
  });
  $$('.seg-btn[data-font-set]').forEach((b) => {
    b.addEventListener('click', () => setFont(b.dataset.fontSet));
  });

  // Me-page send prefs
  $('#toggle-confirm-send')?.addEventListener('change', (ev) => {
    const on = /** @type {HTMLInputElement} */ (ev.target).checked;
    localStorage.setItem(LS_CONFIRM_SEND, on ? '1' : '0');
  });
  $('#toggle-local-readonly')?.addEventListener('change', (ev) => {
    const on = /** @type {HTMLInputElement} */ (ev.target).checked;
    localStorage.setItem(LS_LOCAL_READONLY, on ? '1' : '0');
    updateComposerVisibility();
  });

  // Wallpaper picker + dim (M2)
  $('#btn-wallpaper')?.addEventListener('click', () => {
    toggleWallpaperPanel();
  });
  const dimSlider = /** @type {HTMLInputElement|null} */ ($('#dim-slider'));
  dimSlider?.addEventListener('input', (ev) => {
    const v = /** @type {HTMLInputElement} */ (ev.target).value;
    onDimSliderInput(v);
  });

  // Composer: tap send (do not hijack Enter — mobile IME safe)
  $('#btn-send')?.addEventListener('click', () => {
    const input = /** @type {HTMLTextAreaElement|null} */ ($('#composer-input'));
    const text = input?.value ?? '';
    sendToActivePane({ text, mode: 'run', clearInput: true });
  });
  const composerInput = /** @type {HTMLTextAreaElement|null} */ (
    $('#composer-input')
  );
  composerInput?.addEventListener('input', () => autoSizeComposer(composerInput));
  // Prevent accidental form submit; Enter inserts newline (IME-safe).
  composerInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      // Mobile IME: do not steal Enter for send. Desktop: still newline unless
      // user taps 发送. Spec: 点按发送, Enter 不抢.
      /* leave default newline behavior for Shift+Enter; plain Enter also newline */
    }
  });

  $$('.hotkey-btn[data-hotkey]').forEach((b) => {
    b.addEventListener('click', () => {
      const key = b.dataset.hotkey;
      try {
        const payload = hotkeyPayload(/** @type {any} */ (key));
        sendToActivePane({
          text: payload.text,
          mode: payload.mode,
          clearInput: false,
          skipConfirm: payload.mode === 'run' && payload.text === '',
          label: payload.label,
        });
      } catch {
        /* ignore unknown */
      }
    });
  });

  $('#btn-confirm-enter')?.addEventListener('click', () => {
    const payload = hotkeyPayload('enter');
    sendToActivePane({
      text: payload.text,
      mode: payload.mode,
      clearInput: false,
      skipConfirm: true,
      label: '回车确认',
    });
  });

  window.addEventListener('hashchange', () => {
    applyRoute();
  });

  // Page hide → mark seen
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && activePaneId) {
      postSeen(activePaneId);
    }
  });
}

async function boot() {
  loadSettings();
  wire();
  if (!location.hash || location.hash === '#') {
    location.replace('#/chats');
  }
  setConn('warn', '连接中');
  try {
    const s = await fetchState();
    applyState(s);
    setConn(s.herdr === 'disconnected' ? 'warn' : 'ok', s.herdr === 'disconnected' ? 'herdr 断开' : '已连接');
  } catch {
    setConn('err', '无法拉取状态');
    bootFailed = true;
    applyState(null);
  }
  await applyRoute();
  connectSse();
}

boot();
