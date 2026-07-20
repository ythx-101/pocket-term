/**
 * pocket-term-2 chat SPA — zero-build, hash-routed.
 */
import {
  formatRelativeTime,
  themeChromeColor,
  sortPanes,
  mapBubbleToView,
  agentAvatar,
  statusMeta,
  statusLabel,
  paneRowClass,
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
  fileAssetUrl,
  parseMessageImageSegments,
  parseMessageAttachmentSegments,
  isChatUploadHtmlPath,
  composeImageSendText,
  composeHtmlSendText,
  reduceAttachPreview,
  initialAttachPreview,
  DIM_SLIDER_MAX,
  shouldEmitToast,
  TOAST_DISMISS_MS,
  initialNotifyState,
  reduceNotifications,
  rebaselineNotifyState,
  consumePaneNotifications,
  pendingNotifyCount,
  formatNotifyBadge,
  parseNotifyToggle,
  purgeTierBStreamItems,
  vapidKeyToBytes,
  shouldRecoverLifecycle,
} from './spa-utils.js';
import {
  parseMessageSegments,
  composeDocumentSendText,
  isChatUploadDocumentPath,
  attachmentFilename,
} from './attachment-utils.js';
import {
  renderMarkdownDocument,
  markdownFilename,
  MARKDOWN_MAX_BYTES,
} from './markdown.js';

const APP_VERSION = '0.2.0';
const LS_THEME = 'pt2-theme';
const LS_FONT = 'pt2-font';
const LS_CONFIRM_SEND = 'pt2-confirm-send';
const LS_LOCAL_READONLY = 'pt2-local-readonly';
const LS_NOTIFY_BLOCKED = 'pt2-notify-blocked';
const LS_NOTIFY_DONE = 'pt2-notify-done';

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
    // Deliberately no HTML-string attribute: all dynamic content is text/DOM.
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
// M2.8-P4: paneId -> latest spinner text ("对方正在输入" indicator, SSE-fed)
const typingByPane = new Map();
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
/** @type {{ text: string, at: number }|null} */
let lastToast = null;
/** @type {{ wallpaper: string|null, dim: number }} */
let userSettings = { wallpaper: null, dim: 0.35 };
/** @type {Array<{ name: string, size: number }>} */
let wallpaperCatalog = [];
/** @type {ReturnType<typeof setTimeout>|null} */
let dimSaveTimer = null;
let wallpaperPanelOpen = false;
/** @type {{ path: string|null, kind?: 'image'|'html' }} pending chat attachment */
let attachPreview = initialAttachPreview();
/** @type {string|null} currently open fullscreen image src */
let imageViewerSrc = null;
/** @type {string|null} currently open Markdown document path */
let markdownViewerPath = null;
/** @type {string|null} currently open HTML document path */
let htmlViewerPath = null;
/** In-app notification state (M2.5): baseline + pending + debounce. */
let notifyState = initialNotifyState();

function renderPushDiagnostic(lines, kind = '') {
  const out = $('#push-diagnostic');
  if (!out) return;
  out.textContent = [].concat(lines).join('\n');
  out.classList.toggle('ok', kind === 'ok');
  out.classList.toggle('err', kind === 'err');
}

function diagnosticError(stage, err) {
  const name = err?.name ? `${err.name}: ` : '';
  return `${stage}失败 — ${name}${err?.message || String(err || '未知错误')}\n结论：Web Push 未启用；状态仍见会话列表。`;
}

async function enableWebPush() {
  const button = /** @type {HTMLButtonElement|null} */ ($('#btn-enable-push'));
  if (button) button.disabled = true;
  const steps = [];
  let stage = '浏览器支持检测';
  try {
    const checks = {
      '安全上下文': window.isSecureContext === true,
      'Service Worker': 'serviceWorker' in navigator,
      'Push API': 'PushManager' in window,
      '通知 API': 'Notification' in window,
    };
    for (const [name, ok] of Object.entries(checks)) steps.push(`${ok ? '✓' : '✗'} ${name}`);
    renderPushDiagnostic(steps);
    const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    if (missing.length) throw new Error(`浏览器不支持：${missing.join('、')}`);

    steps.push(`• 当前权限：${Notification.permission}`);
    renderPushDiagnostic(steps);
    stage = '通知权限';
    const permission = Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
    steps.push(`• 权限结果：${permission}`);
    renderPushDiagnostic(steps);
    if (permission !== 'granted') throw new Error(`通知权限为 ${permission}`);

    stage = 'Service Worker 注册';
    const registration = await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
    steps.push(`✓ Service Worker：${registration.scope}`);
    renderPushDiagnostic(steps);

    stage = 'VAPID API';
    const keyRes = await fetch(`${BASE}/api/push/vapid-public`, { cache: 'no-store' });
    const keyBody = await keyRes.json().catch(() => ({}));
    if (!keyRes.ok) throw new Error(`VAPID API HTTP ${keyRes.status} (${keyBody.error || 'unknown'})`);
    steps.push('✓ VAPID 公钥已取得');
    renderPushDiagnostic(steps);

    stage = '浏览器 Push 订阅';
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToBytes(keyBody.publicKey),
      });
    }
    steps.push('✓ 浏览器 Push 订阅已建立');
    renderPushDiagnostic(steps);

    stage = '服务端订阅登记';
    // H2: send Me-page blocked/done prefs with the subscription so dispatch can filter.
    const saveRes = await fetch(`${BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...subscription.toJSON(),
        prefs: getNotifyPrefs(),
      }),
    });
    const saveBody = await saveRes.json().catch(() => ({}));
    if (!saveRes.ok) throw new Error(`订阅登记 HTTP ${saveRes.status} (${saveBody.error || 'unknown'})`);
    steps.push('✓ 服务端登记成功');
    steps.push('结论：Web Push 已启用；页内状态见会话列表，不再弹横幅。');
    renderPushDiagnostic(steps, 'ok');
  } catch (err) {
    renderPushDiagnostic([...steps, diagnosticError(stage, err)], 'err');
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * H2: push current Me-page notify toggles to the server for this browser's
 * push subscription (best-effort; no-op if not subscribed yet).
 */
async function syncPushPrefs() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const registration = await navigator.serviceWorker.getRegistration(`${BASE}/`);
    const sub = await registration?.pushManager?.getSubscription?.();
    if (!sub?.endpoint) return;
    await fetch(`${BASE}/api/push/prefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        prefs: getNotifyPrefs(),
      }),
    });
  } catch {
    /* best-effort */
  }
}

// —— settings ——
function getLocalPrefs() {
  return {
    confirmBeforeSend: localStorage.getItem(LS_CONFIRM_SEND) === '1',
    localReadonly: localStorage.getItem(LS_LOCAL_READONLY) === '1',
  };
}

/** Independent notification toggles; absent = enabled. */
function getNotifyPrefs() {
  return {
    blocked: parseNotifyToggle(localStorage.getItem(LS_NOTIFY_BLOCKED)),
    done: parseNotifyToggle(localStorage.getItem(LS_NOTIFY_DONE)),
  };
}

/** Render 会话 tab unread badge from notifyState (no top banner — M2.6). */
function renderNotifyUI() {
  const badge = $('#tab-badge-chats');
  if (badge) {
    const text = formatNotifyBadge(pendingNotifyCount(notifyState));
    badge.textContent = text;
    badge.classList.toggle('hidden', !text);
  }
  const chatsTab = $('#tab-bar .tab[data-tab="chats"]');
  if (chatsTab) {
    const n = pendingNotifyCount(notifyState);
    chatsTab.setAttribute(
      'aria-label',
      n > 0 ? `会话，${n} 条新通知` : '会话'
    );
  }
}

/** Generation counter so stale wallpaper probes cannot flip a newer setting. */
let wallpaperProbeGen = 0;

/**
 * Apply wallpaper + dim to #wallpaper / #dim / html class (live preview).
 * Probes the image URL; on 404/error removes has-wallpaper so the dim scrim
 * does not leave a pure dark screen (UX#5).
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
  const gen = ++wallpaperProbeGen;

  const clearWallpaperLayers = () => {
    document.documentElement.classList.remove('has-wallpaper');
    if (layer) layer.style.backgroundImage = 'none';
    const thumb = /** @type {HTMLElement|null} */ ($('#wallpaper-card-thumb'));
    if (thumb) {
      thumb.style.backgroundImage = '';
      thumb.classList.remove('has-image');
    }
  };

  if (!has) {
    clearWallpaperLayers();
    const sub = $('#wallpaper-card-sub');
    if (sub) sub.textContent = '无壁纸 · 主题底色';
    return;
  }

  const url = wallpaperAssetUrl(BASE, wallpaper);
  // Optimistic: show wallpaper; probe may clear on 404.
  document.documentElement.classList.add('has-wallpaper');
  if (layer) layer.style.backgroundImage = `url("${url}")`;

  const sub = $('#wallpaper-card-sub');
  if (sub) sub.textContent = wallpaper;
  const thumb = /** @type {HTMLElement|null} */ ($('#wallpaper-card-thumb'));
  if (thumb) {
    thumb.style.backgroundImage = `url("${url}")`;
    thumb.classList.add('has-image');
  }

  const probe = new Image();
  probe.onload = () => {
    /* keep has-wallpaper */
  };
  probe.onerror = () => {
    if (gen !== wallpaperProbeGen) return;
    clearWallpaperLayers();
    if (sub) sub.textContent = '壁纸不可用 · 主题底色';
    showToast('壁纸无法加载，已恢复纯色背景', 'warn');
  };
  probe.src = url;
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
  const notifyPrefs = getNotifyPrefs();
  const nbEl = /** @type {HTMLInputElement|null} */ (
    $('#toggle-notify-blocked')
  );
  if (nbEl) nbEl.checked = notifyPrefs.blocked;
  const ndEl = /** @type {HTMLInputElement|null} */ ($('#toggle-notify-done'));
  if (ndEl) ndEl.checked = notifyPrefs.done;
  // Keep browser chrome color in sync with the in-app theme toggle.
  const chrome = $('meta[name="theme-color"]:not([media])');
  if (chrome) chrome.setAttribute('content', themeChromeColor(theme));
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
  const list = $('#wallpaper-panel-list') || $('#wallpaper-panel');
  if (!list) return;
  list.replaceChildren();

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
  list.append(noneBtn);

  if (!wallpaperCatalog.length) {
    list.append(
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
    list.append(btn);
  }
}

/**
 * Upload raw attachment bytes to bridge.
 * @param {'chat'|'wallpaper'} target
 * @param {File} file
 * @returns {Promise<{ path?: string, name?: string }>}
 */
async function uploadImage(target, file) {
  const buf = await file.arrayBuffer();
  const res = await fetch(
    `${BASE}/api/upload?target=${encodeURIComponent(target)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': file.name || 'image.jpg',
      },
      body: buf,
    }
  );
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = body?.error || `upload ${res.status}`;
    const e = new Error(err);
    // @ts-ignore
    e.status = res.status;
    // @ts-ignore
    e.code = body?.error;
    throw e;
  }
  return body && typeof body === 'object' ? body : {};
}

/**
 * Render attach preview strip above the composer (Telegram-style).
 */
function renderAttachPreview() {
  const strip = $('#attach-preview');
  if (!strip) return;
  const pathAbs = attachPreview?.path || null;
  strip.replaceChildren();
  if (!pathAbs) {
    strip.classList.add('hidden');
    strip.setAttribute('aria-hidden', 'true');
    updateSendButtonState();
    updateComposerStackOffset();
    return;
  }
  strip.classList.remove('hidden');
  strip.removeAttribute('aria-hidden');
  const kind = attachPreview?.kind || (
    isChatUploadDocumentPath(pathAbs) ? 'markdown' :
      isChatUploadHtmlPath(pathAbs) ? 'html' : 'image'
  );
  const thumb = kind === 'markdown'
    ? el('div', {
        className: 'attach-preview-thumb attach-preview-document',
        role: 'img',
        'aria-label': `待发送 Markdown：${attachmentFilename(pathAbs)}`,
      }, [
        el('span', { className: 'bubble-document-icon', text: 'MD' }),
        el('span', { className: 'attach-preview-document-name', text: attachmentFilename(pathAbs) }),
      ])
    : kind === 'html'
      ? el('div', {
          className: 'attach-preview-thumb attach-preview-document',
          role: 'img',
          'aria-label': '待发送 HTML 文档',
        }, [el('span', { className: 'attach-preview-document-icon', text: 'HTML' })])
      : el('img', {
          className: 'attach-preview-thumb',
          src: fileAssetUrl(BASE, pathAbs),
          alt: '待发送图片',
          loading: 'lazy',
        });
  if (kind === 'image') {
    thumb.addEventListener('error', () => {
      thumb.classList.add('broken');
      thumb.removeAttribute('src');
      thumb.alt = '预览失败';
    });
  }
  const removeBtn = el(
    'button',
    {
      type: 'button',
      className: 'attach-preview-remove',
      'aria-label': kind === 'markdown'
        ? '移除 Markdown 文档'
        : kind === 'html' ? '移除 HTML 文档' : '移除图片',
      title: '移除',
      onClick: () => {
        attachPreview = reduceAttachPreview(attachPreview, { type: 'remove' });
        renderAttachPreview();
      },
    },
    ['×']
  );
  strip.append(
    el('div', { className: 'attach-preview-item' }, [thumb, removeBtn]),
    el('span', { className: 'attach-preview-hint', text: kind === 'markdown' ? 'Markdown 文档 · 配文可选' : kind === 'html' ? 'HTML 文档 · 配文可选' : '配文可选，点发送发出' })
  );
  updateSendButtonState();
  updateComposerStackOffset();
}

/**
 * Open fullscreen image viewer.
 * @param {string} src
 */
function openImageViewer(src) {
  const viewer = $('#image-viewer');
  const img = /** @type {HTMLImageElement|null} */ ($('#image-viewer-img'));
  if (!viewer || !img) return;
  const wasOpen = !!imageViewerSrc;
  imageViewerSrc = src;
  img.src = src;
  img.alt = '图片预览';
  viewer.classList.remove('hidden');
  viewer.removeAttribute('hidden');
  document.body.classList.add('image-viewer-open');
  // Push history entry so Android/browser back closes the viewer (返回手势).
  if (!wasOpen) {
    try {
      history.pushState({ pt2ImageViewer: true }, '');
    } catch {
      /* ignore */
    }
  }
}

/**
 * Close fullscreen image viewer.
 * @param {{ fromPopstate?: boolean }} [opts]
 */
function closeImageViewer(opts = {}) {
  const viewer = $('#image-viewer');
  const img = /** @type {HTMLImageElement|null} */ ($('#image-viewer-img'));
  if (!viewer) return;
  const wasOpen = !!imageViewerSrc;
  imageViewerSrc = null;
  if (img) {
    img.removeAttribute('src');
    img.alt = '';
  }
  viewer.classList.add('hidden');
  viewer.setAttribute('hidden', '');
  document.body.classList.remove('image-viewer-open');
  // If closed via UI (not back), drop the history entry we pushed.
  if (wasOpen && !opts.fromPopstate) {
    try {
      if (history.state && history.state.pt2ImageViewer) {
        history.back();
      }
    } catch {
      /* ignore */
    }
  }
}

/** Open a safe Markdown preview modal from an attachment path. */
async function openMarkdownViewer(pathValue) {
  if (!isChatUploadDocumentPath(pathValue)) return;
  const viewer = $('#markdown-viewer');
  const body = $('#markdown-viewer-body');
  const title = $('#markdown-viewer-title');
  const status = $('#markdown-viewer-status');
  if (!viewer || !body || !title) return;
  markdownViewerPath = String(pathValue);
  const openPath = markdownViewerPath;
  title.textContent = markdownFilename(markdownViewerPath);
  body.replaceChildren();
  if (status) status.textContent = '加载中…';
  viewer.classList.remove('hidden');
  viewer.removeAttribute('hidden');
  document.body.classList.add('markdown-viewer-open');
  try {
    const res = await fetch(fileAssetUrl(BASE, markdownViewerPath), { cache: 'no-store' });
    const length = Number(res.headers.get('content-length')) || 0;
    if (!res.ok) throw new Error(res.status === 413 ? 'too_large' : `http_${res.status}`);
    if (length > MARKDOWN_MAX_BYTES) throw new Error('too_large');
    const source = await res.text();
    if (new TextEncoder().encode(source).length > MARKDOWN_MAX_BYTES) throw new Error('too_large');
    if (markdownViewerPath !== openPath) return;
    renderMarkdownDocument(body, source);
    if (status) status.textContent = 'Markdown 预览 · 原始 HTML、图片与危险链接已禁用';
  } catch (err) {
    if (markdownViewerPath !== openPath) return;
    body.replaceChildren(el('p', { className: 'markdown-error', text: err?.message === 'too_large' ? '文档过大，无法预览' : '文档无法加载' }));
    if (status) status.textContent = '加载失败';
  }
}

function closeMarkdownViewer(opts = {}) {
  const viewer = $('#markdown-viewer');
  const body = $('#markdown-viewer-body');
  if (!viewer) return;
  const wasOpen = !!markdownViewerPath;
  markdownViewerPath = null;
  body?.replaceChildren();
  viewer.classList.add('hidden');
  viewer.setAttribute('hidden', '');
  document.body.classList.remove('markdown-viewer-open');
  if (wasOpen && !opts.fromPopstate) {
    try {
      if (history.state && history.state.pt2MarkdownViewer) history.back();
    } catch { /* ignore */ }
  }
}

function documentCard(pathValue) {
  const name = attachmentFilename(pathValue);
  return el('button', {
    type: 'button',
    className: 'bubble-document',
    'aria-label': `预览 Markdown 文档 ${name}`,
    title: name,
    onClick: (ev) => {
      ev.stopPropagation();
      try { history.pushState({ pt2MarkdownViewer: true }, ''); } catch { /* ignore */ }
      openMarkdownViewer(pathValue);
    },
  }, [
    el('span', { className: 'bubble-document-icon', text: 'MD' }),
    el('span', { className: 'bubble-document-name', text: name }),
    el('span', { className: 'bubble-document-open', text: '预览' }),
  ]);
}

function htmlDocumentCard(pathValue) {
  const name = attachmentFilename(pathValue);
  return el('button', {
    type: 'button',
    className: 'bubble-document',
    'aria-label': `预览 HTML 文档 ${name}`,
    title: name,
    onClick: (ev) => {
      ev.stopPropagation();
      try { history.pushState({ pt2HtmlViewer: true }, ''); } catch { /* ignore */ }
      openHtmlViewer(pathValue);
    },
  }, [
    el('span', { className: 'bubble-document-icon html-document-icon', text: 'HTML' }),
    el('span', { className: 'bubble-document-name', text: name }),
    el('span', { className: 'bubble-document-open', text: '预览' }),
  ]);
}

const PREVIEW_ALLOWED_TAGS = new Set([
  'html',
  'head',
  'body',
  'title',
  'style',
  'main',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'div',
  'span',
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'small',
  'mark',
  'del',
  'ins',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'q',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'colgroup',
  'col',
  'figure',
  'figcaption',
  'picture',
  'img',
  'a',
]);
const PREVIEW_GLOBAL_ATTRS = new Set([
  'class',
  'id',
  'title',
  'lang',
  'dir',
  'hidden',
  'role',
  'tabindex',
  'style',
]);
const PREVIEW_TAG_ATTRS = new Map([
  ['style', new Set(['media'])],
  ['img', new Set(['alt', 'width', 'height', 'loading', 'decoding', 'src'])],
  ['a', new Set(['target'])],
  ['th', new Set(['colspan', 'rowspan', 'scope'])],
  ['td', new Set(['colspan', 'rowspan'])],
  ['col', new Set(['span', 'width'])],
]);
const PREVIEW_DENIED_TAGS = new Set([
  'script',
  'noscript',
  'meta',
  'base',
  'link',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'optgroup',
  'datalist',
  'fieldset',
  'output',
  'audio',
  'video',
  'source',
  'track',
  'svg',
  'math',
  'canvas',
  'template',
]);
const PREVIEW_DENIED_ATTRS = new Set([
  'href',
  'xlink:href',
  'action',
  'formaction',
  'srcset',
  'poster',
  'cite',
  'background',
  'profile',
  'manifest',
  'ping',
  'usemap',
]);

/** CSS accepted in a static preview; reject tokenization tricks as well. */
function isSafePreviewCss(value) {
  const css = String(value || '');
  if (css.includes('\\')) return false;
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return !/(?:url\s*\(|@import\b|expression\s*\()/i.test(withoutComments);
}

function isSafePreviewImage(value) {
  const src = String(value || '').trim();
  if (!/^data:/i.test(src)) return false;
  const comma = src.indexOf(',');
  if (comma < 0) return false;

  let metadata;
  try {
    metadata = decodeURIComponent(src.slice(5, comma));
  } catch {
    return false;
  }
  const [rawMime, ...params] = metadata.split(';');
  const mime = rawMime.trim().toLowerCase();
  // SVG data can contain nested external references; keep explicit raster MIME only.
  if (!new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).has(mime)) {
    return false;
  }
  return rawMime === rawMime.trim() && params.every((param) => param.trim() !== '');
}

/**
 * Copy parsed HTML through explicit tag/attribute allowlists. This returns
 * serialized nodes built by the browser, never the uploaded string itself.
 * @param {string} html
 * @returns {string}
 */
function sanitizePreviewHtml(html) {
  const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const out = document.createElement('template');

  /** @param {Node} node @param {Node} parent */
  function copy(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(document.createTextNode(node.nodeValue || ''));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const source = /** @type {Element} */ (node);
    const tag = source.localName.toLowerCase();
    if (PREVIEW_DENIED_TAGS.has(tag) || !PREVIEW_ALLOWED_TAGS.has(tag)) return;
    if (tag === 'style' && !isSafePreviewCss(source.textContent || '')) return;
    const target = document.createElement(tag);
    for (const attr of source.attributes) {
      const name = attr.name.toLowerCase();
      if (PREVIEW_DENIED_ATTRS.has(name) || name.startsWith('on')) continue;
      const allowed = PREVIEW_GLOBAL_ATTRS.has(name) || PREVIEW_TAG_ATTRS.get(tag)?.has(name);
      if (!allowed) continue;
      if (name === 'style' && !isSafePreviewCss(attr.value)) continue;
      if (name === 'src' && (tag !== 'img' || !isSafePreviewImage(attr.value))) continue;
      target.setAttribute(name, attr.value);
    }
    parent.append(target);
    for (const child of source.childNodes) copy(child, target);
  }

  for (const child of parsed.documentElement.childNodes) copy(child, out.content);
  return new XMLSerializer().serializeToString(out.content);
}

function htmlPreviewFailure(frame) {
  if (!frame.isConnected) return;
  frame.replaceWith(
    el('div', {
      className: 'bubble-html-placeholder',
      text: 'HTML 预览无法加载',
      role: 'status',
    })
  );
}

async function loadHtmlPreview(frame, absPath) {
  try {
    if (!isChatUploadHtmlPath(absPath)) throw new Error('preview_path');
    const requestUrl = new URL(fileAssetUrl(BASE, absPath), location.href);
    if (requestUrl.origin !== location.origin) throw new Error('preview_origin');
    const response = await fetch(requestUrl.href, {
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) throw new Error(`preview_http_${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/^text\/html(?:\s*;|$)/i.test(contentType)) {
      throw new Error('preview_content_type');
    }
    const safeHtml = sanitizePreviewHtml(await response.text());
    if (!frame.isConnected) return;
    frame.srcdoc = safeHtml;
    frame.removeAttribute('aria-busy');
  } catch {
    htmlPreviewFailure(frame);
  }
}

/** Create an empty-sandbox iframe whose srcdoc is populated only after sanitizing. */
function createHtmlPreviewFrame(absPath, className = 'bubble-html-preview') {
  const frame = el('iframe', {
    className,
    title: 'HTML 文档预览',
    sandbox: true,
    referrerpolicy: 'no-referrer',
    loading: 'lazy',
    'aria-busy': true,
  });
  frame.addEventListener('error', () => htmlPreviewFailure(frame), { once: true });
  void loadHtmlPreview(frame, absPath);
  return frame;
}

async function openHtmlViewer(pathValue) {
  if (!isChatUploadHtmlPath(pathValue)) return;
  const viewer = $('#html-viewer');
  const body = $('#html-viewer-body');
  const title = $('#html-viewer-title');
  const status = $('#html-viewer-status');
  if (!viewer || !body || !title) return;
  htmlViewerPath = String(pathValue);
  title.textContent = attachmentFilename(htmlViewerPath);
  body.replaceChildren(createHtmlPreviewFrame(htmlViewerPath, 'html-viewer-frame'));
  if (status) status.textContent = 'HTML 预览 · 沙箱与白名单隔离';
  viewer.classList.remove('hidden');
  viewer.removeAttribute('hidden');
  document.body.classList.add('html-viewer-open');
}

function closeHtmlViewer(opts = {}) {
  const viewer = $('#html-viewer');
  const body = $('#html-viewer-body');
  if (!viewer) return;
  const wasOpen = !!htmlViewerPath;
  htmlViewerPath = null;
  body?.replaceChildren();
  viewer.classList.add('hidden');
  viewer.setAttribute('hidden', '');
  document.body.classList.remove('html-viewer-open');
  if (wasOpen && !opts.fromPopstate) {
    try {
      if (history.state && history.state.pt2HtmlViewer) history.back();
    } catch { /* ignore */ }
  }
}

/**
 * Fill a bubble with safe image/document cards + caption text.
 * @param {HTMLElement} bubble
 * @param {string} text
 * @param {{ mono?: boolean }} [opts]
 */
function fillBubbleContent(bubble, text, opts = {}) {
  const segments = parseMessageSegments(text);
  const hasImage = segments.some((s) => s.type === 'image');
  const hasMarkdown = segments.some((s) => s.type === 'document');
  const hasHtml = segments.some((s) => s.type === 'html');
  if (!hasImage && !hasMarkdown && !hasHtml) {
    bubble.textContent = text || ' ';
    return;
  }
  bubble.classList.add('has-attachment');
  if (hasImage) bubble.classList.add('has-image');
  bubble.replaceChildren();
  for (const seg of segments) {
    if (seg.type === 'image') {
      const src = fileAssetUrl(BASE, seg.path);
      const img = el('img', { className: 'bubble-img', src, alt: '图片', loading: 'lazy', decoding: 'async' });
      img.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); openImageViewer(src); });
      img.addEventListener('error', () => {
        img.classList.add('broken');
        img.removeAttribute('src');
        img.alt = '图片已清理或无法加载';
        img.replaceWith(el('div', { className: 'bubble-img-placeholder', text: '图片无法加载', title: seg.path }));
      });
      bubble.append(img);
    } else if (seg.type === 'document') {
      bubble.append(documentCard(seg.path));
    } else if (seg.type === 'html') {
      bubble.append(htmlDocumentCard(seg.path));
    } else if (seg.text && seg.text.trim()) {
      bubble.append(el('div', { className: opts.mono ? 'bubble-caption mono' : 'bubble-caption', text: seg.text.trim() }));
    }
  }
  if (!bubble.childNodes.length) bubble.textContent = ' ';
}

/**
 * M2.8-P3: fill a Tier B stream card with body/tool hierarchy segments
 * (computed by the bridge via segmentStreamText). Cards carrying image
 * tokens keep the Telegram-style image path via fillBubbleContent.
 * @param {HTMLElement} bubble
 * @param {{ text: string, mono: boolean, segments: Array<{type:'body'|'tool', text:string}>|null }} vm
 */
function fillStreamBubbleContent(bubble, vm) {
  const text = vm.text || ' ';
  const hasAttachment = parseMessageSegments(text).some(
    (s) => s.type === 'image' || s.type === 'document' || s.type === 'html'
  );
  if (hasAttachment || !vm.segments || !vm.segments.length) {
    fillBubbleContent(bubble, text, { mono: vm.mono });
    return;
  }
  bubble.replaceChildren();
  for (const seg of vm.segments) {
    bubble.append(
      el('div', {
        className: `stream-seg ${seg.type === 'tool' ? 'seg-tool' : 'seg-body'}`,
        text: seg.text,
      })
    );
  }
}

/**
 * Chat attach flow: pick image/HTML → upload → preview strip.
 * Markdown is intentionally not accepted.
 * @param {File} file
 */
async function handleChatImageUpload(file) {
  const isHtml = /\.(?:html|htm)$/i.test(file?.name || '');
  const btn = /** @type {HTMLButtonElement|null} */ ($('#btn-attach'));
  if (btn) {
    btn.disabled = true;
    btn.classList.add('uploading');
    btn.setAttribute('aria-busy', 'true');
    btn.title = '上传中…';
  }
  try {
    const result = await uploadImage('chat', file);
    if (!result.path) throw new Error('missing_path');
    attachPreview = reduceAttachPreview(attachPreview, {
      type: 'set',
      path: String(result.path),
      kind: isHtml ? 'html' : 'image',
    });
    renderAttachPreview();
    const input = /** @type {HTMLTextAreaElement|null} */ ($('#composer-input'));
    input?.focus();
    showToast(isHtml ? 'HTML 文档已附加' : '图片已附加', 'info');
  } catch (err) {
    const code = /** @type {any} */ (err)?.code || err?.message;
    if (code === 'payload_too_large' || /** @type {any} */ (err)?.status === 413) {
      showToast(isHtml ? 'HTML 太大（上限 2MB）' : '图片太大（上限 10MB）', 'err');
    } else if (code === 'readonly') {
      showToast('只读模式，无法上传聊天附件', 'err');
    } else if (code === 'invalid_extension' || code === 'magic_mismatch') {
      showToast('仅支持 jpg/png/webp/gif 或 html/htm', 'err');
    } else {
      showToast(isHtml ? 'HTML 上传失败' : '图片上传失败', 'err');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('uploading');
      btn.removeAttribute('aria-busy');
      btn.title = '上传附件';
    }
  }
}

/** Chat attach flow for Markdown documents (512 KiB server limit). */
async function handleChatMarkdownUpload(file) {
  const btn = /** @type {HTMLButtonElement|null} */ ($('#btn-attach'));
  if (btn) {
    btn.disabled = true;
    btn.classList.add('uploading');
    btn.setAttribute('aria-busy', 'true');
    btn.title = '上传中…';
  }
  try {
    const result = await uploadImage('chat', file);
    if (!result.path || !isChatUploadDocumentPath(String(result.path))) {
      throw new Error('invalid_document_path');
    }
    attachPreview = reduceAttachPreview(attachPreview, {
      type: 'set',
      path: String(result.path),
    });
    renderAttachPreview();
    $('#composer-input')?.focus();
    showToast('Markdown 文档已附加', 'info');
  } catch (err) {
    const code = /** @type {any} */ (err)?.code || err?.message;
    if (code === 'payload_too_large' || /** @type {any} */ (err)?.status === 413) {
      showToast('Markdown 太大（上限 512KiB）', 'err');
    } else if (code === 'readonly') {
      showToast('只读模式，无法上传文档', 'err');
    } else {
      showToast('Markdown 上传失败', 'err');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('uploading');
      btn.removeAttribute('aria-busy');
      btn.title = '上传图片或 Markdown';
    }
  }
}

/**
 * Wallpaper add flow: pick image → upload → refresh list + select.
 * @param {File} file
 */
async function handleWallpaperImageUpload(file) {
  const btn = /** @type {HTMLButtonElement|null} */ ($('#btn-add-wallpaper'));
  if (btn) {
    btn.disabled = true;
    btn.classList.add('uploading');
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = '上传中…';
  }
  try {
    const result = await uploadImage('wallpaper', file);
    if (!result.name) throw new Error('missing_name');
    try {
      await fetchWallpapers();
    } catch {
      /* still try select */
    }
    await selectWallpaper(String(result.name));
    showToast('壁纸已添加', 'info');
  } catch (err) {
    const code = /** @type {any} */ (err)?.code || err?.message;
    if (code === 'payload_too_large' || /** @type {any} */ (err)?.status === 413) {
      showToast('图片太大（上限 10MB）', 'err');
    } else if (code === 'invalid_extension' || code === 'magic_mismatch') {
      showToast('仅支持 jpg/png/webp/gif', 'err');
    } else {
      showToast('壁纸上传失败', 'err');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('uploading');
      btn.removeAttribute('aria-busy');
      btn.textContent = '添加壁纸';
    }
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
  const decision = shouldEmitToast(message, lastToast, Date.now());
  lastToast = decision.last;
  if (!decision.show) return;

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
  }, TOAST_DISMISS_MS);
}

function updateComposerVisibility() {
  const show = shouldShowComposer(state, getLocalPrefs());
  const composer = $('#composer');
  const roBar = $('#readonly-bar');
  if (composer) composer.classList.toggle('hidden', !show);
  updateComposerStackOffset();
  updateSendButtonState();
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
 *   useAttach?: boolean,
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
  // Merge attachment into outbound text; no Markdown interpretation.
  const rawText = opts.text ?? '';
  const attachPath =
    opts.useAttach !== false && attachPreview?.path ? attachPreview.path : null;
  const attachKind = attachPreview?.kind || (attachPath && isChatUploadHtmlPath(attachPath) ? 'html' : 'image');
  const text =
    attachPath != null
      ? isChatUploadDocumentPath(attachPath)
        ? composeDocumentSendText(rawText, attachPath)
        : attachKind === 'html'
          ? composeHtmlSendText(rawText, attachPath)
          : composeImageSendText(rawText, attachPath)
      : rawText;
  const mode = opts.mode === 'text' ? 'text' : 'run';
  // Hotkeys / empty enter: do not require attach; skip if nothing to send.
  if (!text && mode === 'run' && !opts.label) {
    /* allow empty run for 回车 hotkey via label */
  }
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
    // Image+caption renders via fillBubbleContent (same path as Tier A/B).
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
      if (attachPath != null) {
        attachPreview = reduceAttachPreview(attachPreview, { type: 'send' });
        renderAttachPreview();
      }
    }
  } catch {
    showToast('发送失败：网络错误', 'err');
  } finally {
    sending = false;
    updateSendButtonState();
  }
}

/**
 * UX#6: disable send when input empty and no attach (uses .send-btn:disabled).
 */
function updateSendButtonState() {
  const btn = /** @type {HTMLButtonElement|null} */ ($('#btn-send'));
  if (!btn) return;
  if (sending) {
    btn.disabled = true;
    return;
  }
  const input = /** @type {HTMLTextAreaElement|null} */ ($('#composer-input'));
  const empty = !(input?.value || '').trim() && !attachPreview?.path;
  btn.disabled = empty;
}

/**
 * Measure composer stack so jump-bottom / toast clear multi-line input.
 */
function updateComposerStackOffset() {
  const composer = $('#composer');
  const root = document.documentElement;
  if (!composer || composer.classList.contains('hidden')) {
    root.style.setProperty('--composer-stack-h', '5.5rem');
    return;
  }
  const h = composer.getBoundingClientRect().height;
  // Small gap above the stack so the jump chip does not sit on the border.
  root.style.setProperty('--composer-stack-h', `${Math.max(44, Math.ceil(h + 10))}px`);
}

function autoSizeComposer(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(40, input.scrollHeight))}px`;
  updateSendButtonState();
  updateComposerStackOffset();
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
      className: paneRowClass(p),
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
        'aria-hidden': 'true',
      })
    );
    // Keep the status reminder inline with the latest summary, matching the
    // earlier compact list treatment while retaining the avatar status dot.
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
      // done unread: blue status-dot + red unread badge
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
  if (!bucket.items.length) {
    // UX#3: centered empty-state so chat is not a blank void above the composer
    list.append(
      el('div', {
        className: 'bubble-empty',
        text: '暂无消息',
        role: 'status',
      })
    );
  } else {
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
      });
      if (vm.variant === 'stream') {
        fillStreamBubbleContent(bubble, vm);
      } else {
        fillBubbleContent(bubble, vm.text || ' ', { mono: vm.mono });
      }
      row.append(bubble);
      list.append(row);
    }
  }
  const load = $('#load-earlier');
  if (load) {
    load.classList.toggle('hidden', bucket.items.length < 10);
  }
}

/**
 * M4: B→A purge — drop Tier B stream cards for a pane; keep Tier A / user.
 * @param {string} paneId
 */
function applyPurgeTierB(paneId) {
  if (!paneId) return;
  const bucket = bubbleStore.get(paneId);
  if (!bucket) return;
  const next = purgeTierBStreamItems(bucket.items);
  if (next.length === bucket.items.length) return;
  bucket.items = next;
  bucket.ids = new Set(next.map((m) => String(m.id)));
  if (paneId === activePaneId) {
    renderBubbles(paneId);
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
  const labelEl = $('#chat-status-label');
  const blocked = $('#blocked-bar');
  if (title) title.textContent = paneTitle(pane || { pane_id: paneId });
  const st = statusMeta(pane?.agent_status);
  const label = statusLabel(pane?.agent_status);
  if (dot) {
    dot.className = `status-dot ${st.cls}`;
    dot.setAttribute('aria-hidden', 'true');
  }
  if (labelEl) {
    labelEl.className = `chat-status-label ${st.cls}`;
    labelEl.textContent = label;
    labelEl.setAttribute('aria-label', label);
  }
  if (blocked) {
    blocked.classList.toggle('hidden', pane?.agent_status !== 'blocked');
  }
}

/**
 * M2.8-P4: render the in-place typing indicator for the active pane.
 * Spinner text never enters the bubble list — it lives (and updates in
 * place) on this single status line below the newest card.
 */
function renderTypingLine() {
  const line = $('#typing-line');
  if (!line) return;
  const text = activePaneId ? typingByPane.get(activePaneId) : null;
  line.textContent = text || '';
  line.classList.toggle('hidden', !text);
  if (text && stickToBottom) scrollToBottom(true);
}

async function enterChat(paneId) {
  activePaneId = paneId;
  // Opening the pane consumes its pending notifications (M2.5).
  notifyState = consumePaneNotifications(notifyState, paneId).state;
  renderNotifyUI();
  updateChatHeader(paneId);
  stickToBottom = true;
  try {
    await loadChatMessages(paneId, { reset: true });
  } catch {
    renderBubbles(paneId);
  }
  renderTypingLine();
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
  // M2.8-P4: typing indicator only lives while a pane is working.
  if (Array.isArray(next?.panes)) {
    for (const p of next.panes) {
      if (p?.agent_status !== 'working' && typingByPane.has(p?.pane_id)) {
        typingByPane.delete(p.pane_id);
        if (p.pane_id === activePaneId) renderTypingLine();
      }
    }
  }
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
  if (next != null) {
    // Tab badge always tracks blocked/done edges; Me toggles are Web Push only (M2.6).
    const reduced = reduceNotifications(
      notifyState,
      next.panes || [],
      {},
      Date.now()
    );
    notifyState = reduced.state;
    // The open chat is already on screen — its notifications are seen.
    if (activePaneId) {
      notifyState = consumePaneNotifications(notifyState, activePaneId).state;
    }
  }
  renderNotifyUI();
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
  // Connection lost: first snapshot after reconnect is baseline-only.
  notifyState = rebaselineNotifyState(notifyState);
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

  // M2.8-P4: in-place typing indicator — spinner text rides its own event.
  es.addEventListener('typing', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const paneId = data?.pane_id;
      if (!paneId) return;
      if (data.text) typingByPane.set(paneId, String(data.text));
      else typingByPane.delete(paneId);
      if (paneId === activePaneId) renderTypingLine();
    } catch {
      /* ignore */
    }
  });

  // M4: server purged Tier B buffer on B→A — clear matching stream cards in DOM.
  es.addEventListener('purge', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const paneId = data?.pane_id;
      if (paneId) applyPurgeTierB(paneId);
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
  // Manual reconnect: treat the refetched snapshot as baseline-only too.
  notifyState = rebaselineNotifyState(notifyState);
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

function isSseHealthy() {
  return Boolean(es && es.readyState === 1 && connMode === 'ok');
}

let lifecycleRecoveryPending = false;
function recoverForLifecycle(type, details = {}) {
  if (shouldRecoverLifecycle({
    type,
    visibilityState: document.visibilityState,
    persisted: details.persisted === true,
    online: navigator.onLine,
    sseHealthy: isSseHealthy(),
    recoveryPending: lifecycleRecoveryPending,
  })) {
    lifecycleRecoveryPending = true;
    Promise.resolve(reconnectHard()).finally(() => {
      lifecycleRecoveryPending = false;
    });
  }
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

  // Notification toggles (M2.6/M2.7): Web Push only — list status is always on.
  // H2: also POST prefs so dispatch() filters blocked/done per subscription.
  $('#toggle-notify-blocked')?.addEventListener('change', (ev) => {
    const on = /** @type {HTMLInputElement} */ (ev.target).checked;
    localStorage.setItem(LS_NOTIFY_BLOCKED, on ? '1' : '0');
    void syncPushPrefs();
  });
  $('#toggle-notify-done')?.addEventListener('change', (ev) => {
    const on = /** @type {HTMLInputElement} */ (ev.target).checked;
    localStorage.setItem(LS_NOTIFY_DONE, on ? '1' : '0');
    void syncPushPrefs();
  });
  $('#btn-enable-push')?.addEventListener('click', () => enableWebPush());

  // Wallpaper picker + dim (M2)
  $('#btn-wallpaper')?.addEventListener('click', () => {
    toggleWallpaperPanel();
  });
  const dimSlider = /** @type {HTMLInputElement|null} */ ($('#dim-slider'));
  dimSlider?.addEventListener('input', (ev) => {
    const v = /** @type {HTMLInputElement} */ (ev.target).value;
    onDimSliderInput(v);
  });

  // Wallpaper: add image (M2-P1)
  $('#btn-add-wallpaper')?.addEventListener('click', () => {
    const input = /** @type {HTMLInputElement|null} */ ($('#wallpaper-file-input'));
    input?.click();
  });
  $('#wallpaper-file-input')?.addEventListener('change', (ev) => {
    const input = /** @type {HTMLInputElement} */ (ev.target);
    const file = input.files && input.files[0];
    input.value = '';
    if (file) handleWallpaperImageUpload(file);
  });

  // Chat attach image / Markdown document (M2-P1 / M2-P2 / MD preview)
  $('#btn-attach')?.addEventListener('click', () => {
    const input = /** @type {HTMLInputElement|null} */ ($('#attach-input'));
    input?.click();
  });
  $('#attach-input')?.addEventListener('change', (ev) => {
    const input = /** @type {HTMLInputElement} */ (ev.target);
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (/\.md$/i.test(file.name)) handleChatMarkdownUpload(file);
    else handleChatImageUpload(file);
  });

  // Fullscreen image viewer (M2-P2)
  const viewer = $('#image-viewer');
  viewer?.addEventListener('click', (ev) => {
    // Click backdrop or image closes (Telegram-style dismiss)
    const t = /** @type {HTMLElement} */ (ev.target);
    if (
      t.id === 'image-viewer' ||
      t.id === 'image-viewer-img' ||
      t.id === 'image-viewer-close' ||
      t.classList?.contains('image-viewer-close')
    ) {
      closeImageViewer();
    }
  });
  $('#image-viewer-close')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeImageViewer();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (htmlViewerPath) closeHtmlViewer();
    else if (markdownViewerPath) closeMarkdownViewer();
    else if (imageViewerSrc) closeImageViewer();
  });
  window.addEventListener('popstate', () => {
    if (htmlViewerPath) closeHtmlViewer({ fromPopstate: true });
    if (markdownViewerPath) closeMarkdownViewer({ fromPopstate: true });
    if (imageViewerSrc) closeImageViewer({ fromPopstate: true });
  });
  const markdownViewer = $('#markdown-viewer');
  markdownViewer?.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    if (target.id === 'markdown-viewer' || target.id === 'markdown-viewer-close') {
      closeMarkdownViewer();
    }
  });
  $('#markdown-viewer-close')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMarkdownViewer();
  });
  const htmlViewer = $('#html-viewer');
  htmlViewer?.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    if (target.id === 'html-viewer' || target.id === 'html-viewer-close') {
      closeHtmlViewer();
    }
  });
  $('#html-viewer-close')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeHtmlViewer();
  });

  // Composer: tap send only (Enter = newline; no empty keydown shell — P5)
  $('#btn-send')?.addEventListener('click', () => {
    const input = /** @type {HTMLTextAreaElement|null} */ ($('#composer-input'));
    const text = input?.value ?? '';
    // Allow send with only attach (empty caption)
    if (!text.trim() && !attachPreview?.path) return;
    sendToActivePane({ text, mode: 'run', clearInput: true });
  });
  const composerInput = /** @type {HTMLTextAreaElement|null} */ (
    $('#composer-input')
  );
  composerInput?.addEventListener('input', () => autoSizeComposer(composerInput));
  updateSendButtonState();
  updateComposerStackOffset();

  $$('.hotkey-btn[data-hotkey]').forEach((b) => {
    b.addEventListener('click', () => {
      const key = b.dataset.hotkey;
      try {
        const payload = hotkeyPayload(/** @type {any} */ (key));
        sendToActivePane({
          text: payload.text,
          mode: payload.mode,
          clearInput: false,
          useAttach: false,
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
      useAttach: false,
      skipConfirm: true,
      label: '回车确认',
    });
  });

  window.addEventListener('hashchange', () => {
    applyRoute();
  });

  // Page hide → mark seen; mobile return → repair only an unhealthy SSE.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && activePaneId) {
      postSeen(activePaneId);
    } else if (document.visibilityState === 'visible') {
      recoverForLifecycle('visibilitychange');
    }
  });
  window.addEventListener('pageshow', (event) => {
    recoverForLifecycle('pageshow', { persisted: event.persisted });
  });
  window.addEventListener('online', () => recoverForLifecycle('online'));
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
