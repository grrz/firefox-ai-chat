import {renderMarkdown, renderPartialMarkdown} from './lib/markdown.js';
import {ACTIONS} from '../shared/actions.js';
import {loadSettings, saveSettings} from '../shared/settings.js';
import {PROVIDERS} from '../shared/constants.js';

const PAGE_CHATS_STORAGE_KEY = 'pageChatsByUrl';
const MAX_SAVED_PAGE_CHATS = 50;
const SCROLL_BOTTOM_THRESHOLD_PX = 24;

// ========== State ==========

// Display state for the currently visible tab
const state = {
  mode: 'welcome', // 'welcome' | 'chat'
  messages: [],     // {role: 'user'|'assistant'|'notice'|'error', content: string}
  draftText: '',
  pageContext: null,
  technicalAnalysisMode: false,
  settings: null,
  currentWindowId: null,
  currentTabId: null,
  currentPageKey: null,
};

// Per-tab conversation state (in-memory cache, with persistent fallback by page URL)
const tabStates = new Map();
let persistQueue = Promise.resolve();

// Active streams that keep running even when their tab isn't displayed.
// Keyed by tabId → { port, streamedText, streamedThinking, thinkingStartTime, thinkingElapsed, tabId }
const activeStreams = new Map();
let shouldAutoScroll = true;
let clearChatConfirmArmed = false;
let actionButtonsCompactRaf = null;
let actionButtonsResizeObserver = null;
const sourceGroupCursors = new Map();
const SAFE_HTML_TAGS = new Set([
  'a', 'blockquote', 'br', 'button', 'code', 'details', 'div', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre',
  'span', 'strong', 'summary', 'table', 'tbody', 'td', 'th', 'thead',
  'tr', 'ul',
]);
const SAFE_SVG_TAGS = new Set(['svg', 'path', 'polyline', 'line', 'circle', 'text']);
const SAFE_HTML_ATTRS = new Set([
  'class', 'hidden', 'id', 'open', 'rel', 'role', 'tabindex', 'target', 'title', 'type',
]);
const SAFE_SVG_ATTRS = new Set([
  'aria-hidden', 'cx', 'cy', 'd', 'dominant-baseline', 'fill', 'focusable', 'height',
  'points', 'r', 'stroke', 'stroke-linecap', 'stroke-linejoin', 'stroke-width',
  'text-anchor', 'viewbox', 'width', 'x', 'x1', 'x2', 'y', 'y1', 'y2',
]);

// ========== DOM References ==========
const $ = (sel) => document.querySelector(sel);
const welcomeState = $('#welcomeState');
const chatState = $('#chatState');
const messagesEl = $('#messages');
const actionCardsEl = $('#actionCards');
const actionBarEl = $('#actionBar');
const scrollToBottomBtn = $('#scrollToBottomBtn');
const userInput = $('#userInput');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');
const techModeIndicator = $('#techModeIndicator');
const welcomeTechToggleBtn = $('#welcomeTechToggleBtn');
const settingsBtn = $('#settingsBtn');
const languageToggleBtn = $('#languageToggleBtn');
const historyBarEl = $('#historyBar');
const historyDropdownEl = $('#historyDropdown');
const historyToggleBtn = $('#historyToggleBtn');
const historyMenuEl = $('#historyMenu');
const loadingOverlay = $('#loadingOverlay');
const pageTitleEl = $('#pageTitle');
const pageWordCountEl = $('#pageWordCount');

// ========== Initialization ==========
async function init() {
  state.settings = await loadSettings();
  updateLanguageToggleUI();
  updateTechnicalModeUI();
  renderActionCards();
  bindEvents();

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    state.currentWindowId = tabs[0].windowId ?? null;
    state.currentTabId = tabs[0].id;
    state.currentPageKey = normalizePageUrl(tabs[0].url);
    await restoreTabState(state.currentTabId);
  } else {
    fetchPageContext();
  }
}

// ========== Per-Tab State ==========
function saveTabState() {
  if (state.currentTabId == null) return;
  const draftText = getCurrentDraftText();
  state.draftText = draftText;
  tabStates.set(state.currentTabId, {
    mode: state.mode,
    messages: cloneChatMessages(state.messages),
    draftText,
    pageContext: state.pageContext,
    technicalAnalysisMode: !!state.technicalAnalysisMode,
    pageKey: state.currentPageKey,
  });
  queuePersistCurrentPageChat();
}

function pageContextMatchesCurrentPage(context = state.pageContext) {
  if (!context?.url || !state.currentPageKey) return false;
  return normalizePageUrl(context.url) === state.currentPageKey;
}

async function restoreTabState(tabId) {
  const saved = tabStates.get(tabId);
  const savedForPage = saved && saved.pageKey === state.currentPageKey ? saved : null;
  const persisted = savedForPage ? null : await loadPersistedChatForPage(state.currentPageKey);
  const source = savedForPage || persisted;
  const stream = activeStreams.get(tabId);

  if (source) {
    state.mode = source.mode;
    state.messages = cloneChatMessages(source.messages);
    state.draftText = typeof source.draftText === 'string' ? source.draftText : '';
    state.pageContext = source.pageContext || null;
    state.technicalAnalysisMode = !!source.technicalAnalysisMode;
    tabStates.set(tabId, {
      mode: source.mode,
      messages: cloneChatMessages(source.messages),
      draftText: state.draftText,
      pageContext: source.pageContext || null,
      technicalAnalysisMode: !!source.technicalAnalysisMode,
      pageKey: state.currentPageKey,
    });
  } else {
    state.mode = 'welcome';
    state.messages = [];
    state.draftText = '';
    state.pageContext = null;
    state.technicalAnalysisMode = false;
  }

  rebuildUI();

  // If this tab has an active stream, attach the streaming UI
  if (stream) {
    // Ensure we're in chat mode
    if (state.mode !== 'chat') {
      state.mode = 'chat';
      welcomeState.classList.add('hidden');
      chatState.classList.remove('hidden');
      renderActionBar();
    }
    createStreamingElement(stream);
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    scrollToBottom();
  } else if (!pageContextMatchesCurrentPage()) {
    await fetchPageContext();
  }
}

function rebuildUI() {
  userInput.value = state.draftText || '';
  autoResize();
  messagesEl.innerHTML = '';
  actionBarEl.innerHTML = '';
  shouldAutoScroll = true;
  updateScrollToBottomButton();

  // Reset button state (streaming tabs override this after rebuildUI)
  sendBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');

  if (state.mode === 'chat' && state.messages.length > 0) {
    welcomeState.classList.add('hidden');
    chatState.classList.remove('hidden');
    for (let i = 0; i < state.messages.length; i++) {
      const msg = state.messages[i];
      if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'notice' || msg.role === 'error') {
        const el = renderMessage(msg, i);
        if (msg.role === 'assistant') {
          const bubble = el.querySelector('.message-bubble');
          setAssistantBubbleHtml(bubble, renderStreamingBubble(msg.content, msg.thinking || '', { partial: false }));
        }
        messagesEl.appendChild(el);
      }
    }
    renderActionBar();
    scrollToBottom(true);
    updateHistoryDropdownUI();
  } else {
    welcomeState.classList.remove('hidden');
    chatState.classList.add('hidden');
    updatePageInfo();
    updateHistoryDropdownUI();
  }
  updateTechnicalModeUI();
}

function updatePageInfo() {
  const ctx = state.pageContext;
  if (ctx) {
    pageTitleEl.textContent = ctx.title || 'Untitled page';
    if (ctx.wordCount) {
      pageWordCountEl.textContent = `${ctx.wordCount.toLocaleString()} words extracted`;
    } else if (ctx.error) {
      pageWordCountEl.textContent = 'Could not extract page content';
    } else {
      pageWordCountEl.textContent = '';
    }
  } else {
    pageTitleEl.textContent = 'Loading page info...';
    pageWordCountEl.textContent = '';
  }
}

function getResponseLanguage() {
  return state.settings?.responseLanguage === 'ru' ? 'ru' : 'en';
}

function updateLanguageToggleUI() {
  if (!languageToggleBtn) return;
  const lang = getResponseLanguage();
  languageToggleBtn.dataset.lang = lang;
  languageToggleBtn.textContent = lang.toUpperCase();
  const langName = lang === 'ru' ? 'Russian' : 'English';
  languageToggleBtn.title = `Response language: ${langName}`;
  languageToggleBtn.setAttribute('aria-label', `Response language: ${langName}`);
}

function updateTechnicalModeUI() {
  const enabled = !!state.technicalAnalysisMode;
  techModeIndicator?.classList.toggle('hidden', !enabled);
  if (welcomeTechToggleBtn) {
    welcomeTechToggleBtn.classList.toggle('active', enabled);
    const text = enabled ? 'ON' : 'OFF';
    welcomeTechToggleBtn.title = `Technical analysis mode: ${text}`;
    welcomeTechToggleBtn.setAttribute('aria-label', `Technical analysis mode: ${text}`);
  }
}

async function toggleResponseLanguage() {
  const current = getResponseLanguage();
  const next = current === 'en' ? 'ru' : 'en';
  await setResponseLanguage(next);
}

async function setResponseLanguage(lang) {
  const next = lang === 'ru' ? 'ru' : 'en';
  const nextSettings = {
    ...state.settings,
    responseLanguage: next,
  };
  await saveSettings(nextSettings);
  state.settings = nextSettings;
  updateLanguageToggleUI();
}

async function handleTabChange(tabId) {
  if (tabId === state.currentTabId) return;

  // Save current tab's conversation (don't abort its stream)
  saveTabState();

  // Switch to new tab
  state.currentTabId = tabId;
  state.currentPageKey = await getPageKeyForTabId(tabId);
  await restoreTabState(tabId);
}

// ========== Page Context ==========
async function fetchPageContext(retries = 2) {
  if (state.currentTabId == null) return;
  try {
    loadingOverlay.classList.remove('hidden');
    const freshContext = await Promise.race([
      browser.runtime.sendMessage({
        type: 'getDistilledContent',
        tabId: state.currentTabId,
        options: { includeTechnicalContext: !!state.technicalAnalysisMode },
      }),
      new Promise((_, reject) => setTimeout(() => {
        const err = new Error('timeout');
        err.code = 'context_timeout';
        reject(err);
      }, 5000)),
    ]);
    state.pageContext = freshContext;
    if (freshContext?.url) {
      state.currentPageKey = normalizePageUrl(freshContext.url) || state.currentPageKey;
    }
  } catch (err) {
    if (err?.code === 'context_timeout' || err?.message === 'timeout') {
      let tab = null;
      try {
        tab = await browser.tabs.get(state.currentTabId);
      } catch {}
      state.pageContext = {
        title: tab?.title || '',
        url: tab?.url || '',
        textContent: '',
        wordCount: 0,
        error: 'Timed out reading page content',
      };
      return;
    }
    if (retries > 0) {
      // Content script may not be injected yet — retry after a short delay
      await new Promise(r => setTimeout(r, 500));
      return fetchPageContext(retries - 1);
    }
    state.pageContext = { title: '', url: '', textContent: '', wordCount: 0, error: 'Could not access page' };
  } finally {
    loadingOverlay.classList.add('hidden');
    updatePageInfo();
    saveTabState();
  }
}

// ========== UI State Switching ==========
function switchToChat() {
  state.mode = 'chat';
  welcomeState.classList.add('hidden');
  chatState.classList.remove('hidden');
  renderActionBar();
}

function disarmClearChatConfirm() {
  if (!clearChatConfirmArmed) return;
  clearChatConfirmArmed = false;
  renderActionBar();
}

function switchToWelcome() {
  // Abort stream for current tab if any
  const stream = activeStreams.get(state.currentTabId);
  if (stream) {
    stream.userAborted = true;
    stream.port?.postMessage({ type: 'abort' });
  }

  disarmClearChatConfirm();
  state.mode = 'welcome';
  state.messages = [];
  state.draftText = '';
  state.technicalAnalysisMode = false;
  closeHistoryMenu();
  welcomeState.classList.remove('hidden');
  chatState.classList.add('hidden');
  messagesEl.innerHTML = '';
  actionBarEl.innerHTML = '';
  shouldAutoScroll = true;
  updateScrollToBottomButton();
  userInput.value = '';
  autoResize();
  sendBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  updatePageInfo();
  updateHistoryDropdownUI();
  updateTechnicalModeUI();
  if (state.currentTabId != null) {
    tabStates.delete(state.currentTabId);
  }
  queuePersistCurrentPageChat();
}

// ========== Actions ==========
function renderActionCards() {
  setSanitizedHtml(actionCardsEl, ACTIONS.map(action => `
    <div class="action-card" data-action="${action.id}">
      <div class="action-card-icon">${action.icon}</div>
      <div class="action-card-label">${action.label}</div>
    </div>
  `).join(''));

  actionCardsEl.querySelectorAll('.action-card').forEach(card => {
    card.addEventListener('click', () => executeAction(card.dataset.action));
  });
}

function renderActionBar() {
  const actionButtons = ACTIONS.map(action => `
    <button class="action-btn" data-action="${action.id}">
      <span class="action-btn-icon">${action.icon}</span>
      <span class="action-btn-label">${action.label}</span>
    </button>
  `).join('');
  const clearLabel = clearChatConfirmArmed ? 'Clear chat (confirm?)' : 'Clear chat';
  const currentLang = getResponseLanguage();
  const techModeLabel = state.technicalAnalysisMode ? 'Technical mode: ON' : 'Technical mode: OFF';
  setSanitizedHtml(actionBarEl, [
    '<div class="action-buttons-scroll" id="actionButtonsScroll">',
    actionButtons,
    '</div>',
    '<div class="action-menu-wrap" id="actionMenuWrap">',
    '  <button class="action-menu-toggle" id="actionMenuToggle" title="Menu" aria-label="Menu">⋯</button>',
    '  <div class="action-menu hidden" id="actionMenu">',
    `    <button class="action-menu-item${clearChatConfirmArmed ? ' danger' : ''}" id="menuClearChat">${clearLabel}</button>`,
    '    <div class="action-menu-language">',
    '      <span class="action-menu-language-label">Language</span>',
    '      <div class="action-menu-language-switch" role="group" aria-label="Response language">',
    `        <button class="action-menu-lang-btn${currentLang === 'en' ? ' active' : ''}" id="menuLangEn" data-lang="en">EN</button>`,
    `        <button class="action-menu-lang-btn${currentLang === 'ru' ? ' active' : ''}" id="menuLangRu" data-lang="ru">RU</button>`,
    '      </div>',
    '    </div>',
    `    <button class="action-menu-item" id="menuToggleTechnicalMode">${techModeLabel}</button>`,
    '    <button class="action-menu-item" id="menuOpenSettings">Settings</button>',
    '  </div>',
    '</div>',
  ].join(''));

  actionBarEl.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (activeStreams.has(state.currentTabId)) return;
      executeAction(btn.dataset.action);
    });
  });

  const menuEl = $('#actionMenu');
  $('#actionMenuToggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    menuEl?.classList.toggle('hidden');
  });
  $('#menuClearChat')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!clearChatConfirmArmed) {
      clearChatConfirmArmed = true;
      renderActionBar();
      $('#actionMenu')?.classList.remove('hidden');
      return;
    }
    clearChatConfirmArmed = false;
    switchToWelcome();
  });
  const handleMenuLanguageClick = async (e) => {
    e.stopPropagation();
    const nextLang = e.currentTarget?.dataset?.lang;
    if (!nextLang || nextLang === getResponseLanguage()) return;
    await setResponseLanguage(nextLang);
    renderActionBar();
    $('#actionMenu')?.classList.remove('hidden');
  };
  $('#menuLangEn')?.addEventListener('click', handleMenuLanguageClick);
  $('#menuLangRu')?.addEventListener('click', handleMenuLanguageClick);
  $('#menuToggleTechnicalMode')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.technicalAnalysisMode = !state.technicalAnalysisMode;
    updateTechnicalModeUI();
    renderActionBar();
    $('#actionMenu')?.classList.remove('hidden');
    saveTabState();
  });
  $('#menuOpenSettings')?.addEventListener('click', (e) => {
    e.stopPropagation();
    browser.runtime.openOptionsPage();
    menuEl?.classList.add('hidden');
  });

  bindActionButtonsResizeObserver();
  scheduleActionButtonsCompactMode();
}

function updateActionButtonsCompactMode() {
  const buttonsWrap = $('#actionButtonsScroll');
  if (!buttonsWrap) return;
  if (buttonsWrap.clientWidth <= 0) return;
  const wasCompact = buttonsWrap.classList.contains('compact');
  buttonsWrap.classList.remove('compact');
  const overflowPx = buttonsWrap.scrollWidth - buttonsWrap.clientWidth;
  const COLLAPSE_THRESHOLD_PX = 2;
  const EXPAND_THRESHOLD_PX = 0;
  if (wasCompact) {
    // Stay compact until labels fit without overflow.
    if (overflowPx > -EXPAND_THRESHOLD_PX) {
      buttonsWrap.classList.add('compact');
    }
    return;
  }
  if (overflowPx > COLLAPSE_THRESHOLD_PX) {
    buttonsWrap.classList.add('compact');
  }
}

function scheduleActionButtonsCompactMode() {
  if (actionButtonsCompactRaf != null) {
    cancelAnimationFrame(actionButtonsCompactRaf);
  }
  actionButtonsCompactRaf = requestAnimationFrame(() => {
    actionButtonsCompactRaf = null;
    updateActionButtonsCompactMode();
  });
}

function bindActionButtonsResizeObserver() {
  if (actionButtonsResizeObserver) {
    actionButtonsResizeObserver.disconnect();
  }
  const buttonsWrap = $('#actionButtonsScroll');
  if (!buttonsWrap || !window.ResizeObserver) return;
  actionButtonsResizeObserver = new ResizeObserver(() => {
    scheduleActionButtonsCompactMode();
  });
  actionButtonsResizeObserver.observe(buttonsWrap);
  if (actionBarEl) actionButtonsResizeObserver.observe(actionBarEl);
}

function executeAction(actionId) {
  const action = ACTIONS.find(a => a.id === actionId);
  if (!action) return;
  userInput.value = action.prompt;
  handleSend({ action });
}

function getActionById(actionId) {
  if (!actionId) return null;
  return ACTIONS.find((a) => a.id === actionId) || null;
}

function truncateText(text, max = 80) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function getHistoryEntries() {
  const entries = [];
  for (let i = 0; i < state.messages.length; i++) {
    const msg = state.messages[i];
    if (!msg || msg.role !== 'user' || !msg.content) continue;
    const action = getActionById(msg.actionId);
    entries.push({
      messageIndex: i,
      label: action ? action.label : truncateText(msg.content),
      iconHtml: action
        ? action.icon
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    });
  }
  return entries;
}

function closeHistoryMenu() {
  historyMenuEl.classList.add('hidden');
  historyDropdownEl.classList.add('menu-closed');
}

function toggleHistoryMenu() {
  historyMenuEl.classList.toggle('hidden');
  historyDropdownEl.classList.toggle('menu-closed', historyMenuEl.classList.contains('hidden'));
}

function getMessageElementByIndex(index) {
  if (!Number.isFinite(index)) return null;
  return messagesEl.querySelector(`.message[data-index="${index}"]`);
}

function getActiveHistoryEntry(entries) {
  if (!entries.length) return null;
  const viewportProbe = messagesEl.scrollTop + Math.max(8, Math.floor(messagesEl.clientHeight * 0.5));
  let fallback = entries[entries.length - 1];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const currentEl = getMessageElementByIndex(entry.messageIndex);
    if (!currentEl) continue;

    const nextEntry = entries[i + 1] || null;
    const nextEl = nextEntry ? getMessageElementByIndex(nextEntry.messageIndex) : null;
    const start = currentEl.offsetTop;
    const end = nextEl ? nextEl.offsetTop : messagesEl.scrollHeight;

    if (viewportProbe < start) {
      return i > 0 ? entries[i - 1] : entry;
    }
    if (viewportProbe >= start && viewportProbe < end) {
      return entry;
    }

    fallback = entry;
  }

  return fallback;
}

function updateHistoryDropdownUI() {
  const entries = getHistoryEntries();
  const shouldShow = state.mode === 'chat' && entries.length > 1;
  if (!shouldShow) {
    historyBarEl.classList.add('hidden');
    chatState.classList.remove('history-visible');
    closeHistoryMenu();
    return;
  }

  historyBarEl.classList.remove('hidden');
  chatState.classList.add('history-visible');
  historyDropdownEl.classList.toggle('menu-closed', historyMenuEl.classList.contains('hidden'));

  const activeEntry = getActiveHistoryEntry(entries) || entries[entries.length - 1];
  setSanitizedHtml(historyToggleBtn, [
    `<span class="history-toggle-icon">${activeEntry.iconHtml}</span>`,
    `<span class="history-label">${escapeHtml(activeEntry.label)}</span>`,
    '<span class="history-toggle-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>',
  ].join(''));

  setSanitizedHtml(historyMenuEl, entries
      .map((entry) => (
          `<button class="history-menu-item${entry.messageIndex === activeEntry.messageIndex ? ' active' : ''}" data-message-index="${entry.messageIndex}"${entry.messageIndex === activeEntry.messageIndex ? ' aria-current="true"' : ''}>` +
          `<span class="history-item-icon">${entry.iconHtml}</span>` +
          `<span class="history-item-label">${escapeHtml(entry.label)}</span>` +
          '</button>'
      ))
      .join(''));

  historyMenuEl.querySelectorAll('.history-menu-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.messageIndex);
      const msgEl = messagesEl.querySelector(`.message[data-index="${idx}"]`);
      if (msgEl) {
        shouldAutoScroll = false;
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      updateScrollToBottomButton();
      closeHistoryMenu();
    });
  });
}

// ========== Message Rendering ==========
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sanitizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.startsWith('source:') || lower.startsWith('source-group:') || lower.startsWith('mailto:')) {
    return raw;
  }
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return raw;
  } catch {
    return '';
  }
  return '';
}

function getYouTubeVideoIdFromUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '');
    if ((host === 'youtube.com' || host === 'm.youtube.com') && url.pathname === '/watch') {
      return url.searchParams.get('v') || '';
    }
    if (host === 'youtu.be') {
      return url.pathname.split('/').filter(Boolean)[0] || '';
    }
  } catch {}
  return '';
}

function parseYouTubeTimeValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);

  const colonMatch = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (colonMatch) {
    const first = Number(colonMatch[1]);
    const second = Number(colonMatch[2]);
    const third = colonMatch[3] == null ? null : Number(colonMatch[3]);
    return third == null ? first * 60 + second : first * 3600 + second * 60 + third;
  }

  let total = 0;
  let matched = false;
  for (const match of raw.matchAll(/(\d+(?:\.\d+)?)\s*([hms])/g)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    if (match[2] === 'h') total += amount * 3600;
    else if (match[2] === 'm') total += amount * 60;
    else total += amount;
    matched = true;
  }

  return matched ? Math.max(0, Math.floor(total)) : null;
}

function buildYouTubeTimestampUrl(videoId, seconds) {
  if (!videoId) return '';
  const startSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${startSeconds}s`;
}

function parseYouTubeTimestampLink(rawHref) {
  if (!rawHref) return null;
  try {
    const url = new URL(rawHref, state.pageContext?.url || window.location.href);
    const videoId = getYouTubeVideoIdFromUrl(url.toString());
    if (!videoId) return null;

    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    const rawTime =
      url.searchParams.get('t') ||
      url.searchParams.get('start') ||
      url.searchParams.get('time_continue') ||
      hashParams.get('t') ||
      hashParams.get('start');
    const seconds = parseYouTubeTimeValue(rawTime);
    if (seconds == null) return null;

    return {
      url: url.toString(),
      videoId,
      seconds,
    };
  } catch {
    return null;
  }
}

function getCurrentYouTubeVideoId() {
  return getYouTubeVideoIdFromUrl(state.pageContext?.url || state.currentPageKey || '');
}

function createYouTubeTimestampAnchor(videoId, timecode) {
  const seconds = parseYouTubeTimeValue(timecode);
  const href = seconds == null ? '' : buildYouTubeTimestampUrl(videoId, seconds);
  if (!href) return null;

  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = timecode;
  return anchor;
}

function getSingleTimecodeText(text) {
  const match = String(text || '').trim().match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)]?$/);
  return match ? match[1] : '';
}

function linkifyYouTubeTimecodesInElement(root) {
  const videoId = getCurrentYouTubeVideoId();
  if (!videoId || !root) return;

  for (const codeEl of Array.from(root.querySelectorAll('code'))) {
    if (codeEl.closest('pre')) continue;
    const timecode = getSingleTimecodeText(codeEl.textContent);
    if (!timecode) continue;
    const anchor = createYouTubeTimestampAnchor(videoId, timecode);
    if (anchor) codeEl.replaceWith(anchor);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.textContent || '';
      if (!/\d{1,2}:\d{2}/.test(text)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest('a, pre, code')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const text = node.textContent || '';
    const fragment = document.createDocumentFragment();
    const re = /\[?(\d{1,2}:\d{2}(?::\d{2})?)]?/g;
    let lastIndex = 0;
    let changed = false;
    for (const match of text.matchAll(re)) {
      const start = match.index || 0;
      const full = match[0];
      const timecode = match[1];
      const anchor = createYouTubeTimestampAnchor(videoId, timecode);
      if (!anchor) continue;
      fragment.append(document.createTextNode(text.slice(lastIndex, start)));
      fragment.append(anchor);
      lastIndex = start + full.length;
      changed = true;
    }
    if (!changed) continue;
    fragment.append(document.createTextNode(text.slice(lastIndex)));
    node.replaceWith(fragment);
  }
}

async function seekCurrentYouTubeTimestamp(linkInfo) {
  if (!linkInfo || state.currentTabId == null) return false;
  let currentTabUrl = '';
  try {
    const tab = await browser.tabs.get(state.currentTabId);
    currentTabUrl = tab?.url || '';
  } catch {}

  const currentVideoId =
    getYouTubeVideoIdFromUrl(currentTabUrl) ||
    getYouTubeVideoIdFromUrl(state.pageContext?.url || state.currentPageKey || '');
  const isCurrentVideo = !!currentVideoId && currentVideoId === linkInfo.videoId;

  if (!isCurrentVideo) return false;

  try {
    const response = await browser.runtime.sendMessage({
      type: 'seekYouTubeVideo',
      tabId: state.currentTabId,
      seconds: linkInfo.seconds,
      url: linkInfo.url,
    });
    if (response?.ok) return true;
  } catch {}
  return false;
}

function sanitizeHtmlNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const tagName = String(node.localName || '').toLowerCase();
  const isSvg = SAFE_SVG_TAGS.has(tagName);
  let element;

  if (SAFE_HTML_TAGS.has(tagName)) {
    element = document.createElement(tagName);
  } else if (isSvg) {
    element = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  } else {
    const fragment = document.createDocumentFragment();
    for (const child of Array.from(node.childNodes)) {
      const safeChild = sanitizeHtmlNode(child);
      if (safeChild) fragment.appendChild(safeChild);
    }
    return fragment;
  }

  for (const attr of Array.from(node.attributes)) {
    const name = attr.name;
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('on')) continue;

    if (lowerName === 'href') {
      const safeHref = sanitizeUrl(attr.value);
      if (safeHref) element.setAttribute('href', safeHref);
      continue;
    }

    if (lowerName.startsWith('data-') || lowerName.startsWith('aria-')) {
      element.setAttribute(name, attr.value);
      continue;
    }

    if (!isSvg && SAFE_HTML_ATTRS.has(lowerName)) {
      element.setAttribute(name, attr.value);
      continue;
    }

    if (isSvg && SAFE_SVG_ATTRS.has(lowerName)) {
      element.setAttribute(name, attr.value);
    }
  }

  if (tagName === 'a') {
    const href = element.getAttribute('href') || '';
    if (href.startsWith('http://') || href.startsWith('https://')) {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  }

  for (const child of Array.from(node.childNodes)) {
    const safeChild = sanitizeHtmlNode(child);
    if (safeChild) element.appendChild(safeChild);
  }

  return element;
}

function createSanitizedFragment(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html || ''), 'text/html');
  const fragment = document.createDocumentFragment();
  for (const child of Array.from(doc.body.childNodes)) {
    const safeChild = sanitizeHtmlNode(child);
    if (safeChild) fragment.appendChild(safeChild);
  }
  return fragment;
}

function setSanitizedHtml(element, html) {
  element.replaceChildren(createSanitizedFragment(html));
}

function setAssistantBubbleHtml(element, html) {
  setSanitizedHtml(element, html);
  linkifyYouTubeTimecodesInElement(element);
}

function renderUserTechMarker() {
  return '<span class="user-tech-marker" title="Technical analysis mode was used" aria-label="Technical analysis mode was used"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 7 3 12 8 17"/><polyline points="16 7 21 12 16 17"/></svg></span>';
}

function renderAssistantContextBadge(mode) {
  if (mode === 'tools') {
    return '<div class="assistant-context-badge tools" title="Used tool calls for page inspection">Context: tools</div>';
  }
  if (mode === 'full_context') {
    return '<div class="assistant-context-badge full" title="Used full page context in prompt">Context: full page</div>';
  }
  return '';
}

function normalizeErrorMessage(input) {
  if (input && typeof input === 'object') {
    return {
      role: 'error',
      title: input.title || 'Something went wrong',
      message: input.message || input.userMessage || input.error || input.content || 'The AI request failed.',
      technicalDetails: input.technicalDetails || '',
      retryable: !!input.retryable,
      action: input.action || '',
      code: input.code || '',
      status: input.status || null,
      partial: !!input.partial,
    };
  }
  return {
    role: 'error',
    title: 'Something went wrong',
    message: String(input || 'The AI request failed.'),
    technicalDetails: '',
    retryable: false,
    action: '',
    code: '',
    status: null,
    partial: false,
  };
}

function renderErrorMessage(message) {
  const normalized = normalizeErrorMessage(message);
  const detailText = String(normalized.technicalDetails || '').trim();
  const parts = [
    `<strong>${escapeHtml(normalized.title)}</strong>`,
    `<div class="error-message-text">${escapeHtml(normalized.message)}</div>`,
  ];

  if (normalized.action === 'settings') {
    parts.push('<button type="button" class="error-link" data-error-action="settings">Open Settings</button>');
  }
  if (normalized.retryable) {
    parts.push('<div class="error-hint">You can try again.</div>');
  }
  if (detailText) {
    parts.push([
      '<details class="error-details">',
      '<summary>Technical details</summary>',
      `<pre>${escapeHtml(detailText)}</pre>`,
      '</details>',
    ].join(''));
  }

  return parts.join('');
}

function bindErrorBubbleActions(bubble) {
  bubble.querySelectorAll('[data-error-action="settings"]').forEach((link) => {
    link.addEventListener('click', () => browser.runtime.openOptionsPage());
  });
}

function getSourceAnchorsMap() {
  const map = state.pageContext?.sourceAnchors;
  if (!map || typeof map !== 'object') return {};
  return map;
}

function linkifySourceTags(text) {
  if (!text) return text;
  const anchors = getSourceAnchorsMap();
  if (Object.keys(anchors).length === 0) return text;
  return String(text).replace(/\[(s\d+(?:\s*[-–—]\s*s?\d+)?(?:\s*,\s*s?\d+(?:\s*[-–—]\s*s?\d+)?)*)]/gi, (match, group) => {
    const parts = [];
    const tokens = group
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    for (const token of tokens) {
      const rangeMatch = token.match(/^s(\d+)\s*[-–—]\s*s?(\d+)$/i);
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const lo = Math.min(start, end);
        const hi = Math.max(start, end);
        const cap = Math.min(hi, lo + 50); // safety bound
        const ids = [];
        for (let i = lo; i <= cap; i++) ids.push(`s${i}`);
        const hasAny = ids.some((id) => !!anchors[id]);
        if (hasAny) {
          const label = `s${lo}-s${hi}`;
          parts.push(`[→](source-group:${label})`);
        }
        continue;
      }
      const singleMatch = token.match(/^s(\d+)$/i);
      if (singleMatch) {
        const id = `s${Number(singleMatch[1])}`;
        if (anchors[id]) parts.push(`[→](source:${id})`);
      }
    }
    if (parts.length === 0) return '';
    return parts.join(' ');
  });
}

function linkifyAssistantContent(text) {
  return linkifySourceTags(text);
}

async function scrollToSourceFromChat(sourceId) {
  const id = String(sourceId || '').trim().toLowerCase();
  if (!id) return;
  const anchor = getSourceAnchorsMap()[id];
  if (!anchor?.selector) return;
  if (state.currentTabId == null) return;
  try {
    await browser.runtime.sendMessage({
      type: 'scrollToSource',
      tabId: state.currentTabId,
      selector: anchor.selector,
      snippet: anchor.snippet || '',
      occurrence: Number(anchor.occurrence) || 1,
    });
  } catch {
    // Ignore scroll failures; links remain best-effort.
  }
}

async function scrollToSourceGroupFromChat(label) {
  const normalized = String(label || '').trim().toLowerCase();
  const match = normalized.match(/^s(\d+)-s?(\d+)$/i);
  if (!match) return;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const cap = Math.min(hi, lo + 50);
  const anchors = getSourceAnchorsMap();
  const ids = [];
  for (let i = lo; i <= cap; i++) ids.push(`s${i}`);
  const available = ids.filter((id) => !!anchors[id]?.selector);
  if (available.length === 0) return;
  const cursor = sourceGroupCursors.get(normalized) || 0;
  for (let step = 0; step < available.length; step++) {
    const idx = (cursor + step) % available.length;
    const id = available[idx];
    if (anchors[id]?.selector) {
      sourceGroupCursors.set(normalized, (idx + 1) % available.length);
      await scrollToSourceFromChat(id);
      return;
    }
  }
}

function renderMessage(message, index) {
  const el = document.createElement('div');
  el.className = `message message-${message.role}`;
  el.dataset.index = index;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  if (message.role === 'user') {
    const action = getActionById(message.actionId);
    if (action) {
      el.classList.add('message-user-action');
      setSanitizedHtml(bubble, [
        '<details class="user-action-message">',
        `<summary class="user-action-summary"><span class="user-action-icon">${action.icon}</span><span class="user-action-label">${escapeHtml(action.label)}</span>${message.technicalModeUsed ? renderUserTechMarker() : ''}<span class="user-action-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span></summary>`,
        `<div class="user-action-text">${escapeHtml(message.content)}</div>`,
        '</details>',
      ].join(''));
    } else {
      setSanitizedHtml(bubble, `${escapeHtml(message.content)}${message.technicalModeUsed ? renderUserTechMarker() : ''}`);
    }
  } else if (message.role === 'assistant') {
    setAssistantBubbleHtml(bubble, `${renderAssistantContextBadge(message.contextMode)}${renderMarkdown(linkifyAssistantContent(message.content))}`);
  } else if (message.role === 'notice') {
    setSanitizedHtml(bubble, renderContextLimitNotice(message.details || []));
  } else if (message.role === 'error') {
    setSanitizedHtml(bubble, renderErrorMessage(message));
    bindErrorBubbleActions(bubble);
  }

  el.appendChild(bubble);
  return el;
}

function renderContextLimitNotice(details) {
  const safeDetails = Array.isArray(details) ? details : [];
  const items = safeDetails.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('');
  return [
    '<strong>Context was limited before sending to the model.</strong>',
    '<div>Applied limits:</div>',
    `<ul>${items}</ul>`,
  ].join('');
}

function maybeAppendContextLimitNotice() {
  const details = state.pageContext?.contextLimits?.details;
  if (!state.pageContext?.contextLimits?.applied || !Array.isArray(details) || details.length === 0) return;

  const signature = details.join(' | ');
  const hasSameNotice = state.messages.some(
    (m) => m.role === 'notice' && m.noticeKey === 'context-limits' && m.signature === signature
  );
  if (hasSameNotice) return;

  appendMessage({
    role: 'notice',
    noticeKey: 'context-limits',
    signature,
    details,
  });
}

function appendMessage(message) {
  state.messages.push(message);
  const el = renderMessage(message, state.messages.length - 1);
  messagesEl.appendChild(el);
  scrollToBottom();
  updateHistoryDropdownUI();
  saveTabState();
}

function getDistanceFromBottom() {
  return Math.max(0, messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight);
}

function isNearBottom() {
  return getDistanceFromBottom() <= SCROLL_BOTTOM_THRESHOLD_PX;
}

function updateScrollToBottomButton() {
  const isFarFromBottom = getDistanceFromBottom() > messagesEl.clientHeight;
  scrollToBottomBtn.classList.toggle('hidden', !isFarFromBottom);
}

function handleMessagesScroll() {
  shouldAutoScroll = isNearBottom();
  updateScrollToBottomButton();
  updateHistoryDropdownUI();
}

function scrollToBottom(force = false) {
  if (force || shouldAutoScroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (force) shouldAutoScroll = true;
  }
  updateScrollToBottomButton();
}

// ========== Pre-flight Checks ==========
function checkApiKey() {
  const providerId = state.settings.activeProvider;
  const providerDef = PROVIDERS[providerId];
  const providerSettings = state.settings.providers[providerId];

  if (providerDef.requiresKey && !providerSettings?.apiKey) {
    return {
      valid: false,
      title: 'Missing API key',
      message: `No API key configured for ${providerDef.name}.`,
      action: 'settings',
      technicalDetails: `Provider: ${providerId}\nRequired setting: apiKey`,
    };
  }
  return { valid: true };
}

// ========== Send & Stream ==========
function handleSend(meta = {}) {
  const text = userInput.value.trim();
  if (!text || activeStreams.has(state.currentTabId)) return;

  const keyCheck = checkApiKey();
  if (!keyCheck.valid) {
    if (state.mode === 'welcome') switchToChat();
    state.draftText = '';
    userInput.value = '';
    autoResize();
    appendMessage({ role: 'user', content: text });
    appendErrorMessage(keyCheck);
    return;
  }

  if (state.mode === 'welcome') switchToChat();

  const userMessage = { role: 'user', content: text };
  userMessage.technicalModeUsed = !!state.technicalAnalysisMode;
  if (meta?.action?.id) {
    userMessage.actionId = meta.action.id;
    userMessage.actionLabel = meta.action.label;
  }
  state.draftText = '';
  userInput.value = '';
  autoResize();
  appendMessage(userMessage);

  startStreaming();
}

// ========== Thinking Helpers ==========

function parseThinkingTags(text) {
  const startTag = '<think>';
  const endTag = '</think>';
  const startIdx = text.indexOf(startTag);

  if (startIdx === -1) {
    return { thinking: '', content: text, isThinking: false };
  }

  const before = text.slice(0, startIdx);
  const afterStart = startIdx + startTag.length;
  const endIdx = text.indexOf(endTag, afterStart);

  if (endIdx === -1) {
    return { thinking: text.slice(afterStart), content: before, isThinking: true };
  }

  const thinking = text.slice(afterStart, endIdx);
  const after = text.slice(endIdx + endTag.length);
  return { thinking, content: (before + after).trim(), isThinking: false };
}

function buildThinkingHtml(thinkingText, { streaming = false, elapsed = 0 } = {}) {
  if (streaming) {
    return `<details class="thinking-block thinking-active"><summary class="thinking-summary">Thinking\u2026</summary></details>`;
  }
  const secs = Math.round(elapsed / 1000);
  const label = secs > 0 ? `Thought for ${secs}s` : 'Thought';
  const rendered = renderMarkdown(thinkingText);
  return `<details class="thinking-block"><summary class="thinking-summary">${escapeHtml(label)}</summary><div class="thinking-content">${rendered}</div></details>`;
}

function formatStreamElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function buildStreamStatusText(message, elapsedMs) {
  const label = String(message || 'Still working...').trim();
  if (!Number.isFinite(Number(elapsedMs)) || Number(elapsedMs) < 1000) return label;
  return `${label} ${formatStreamElapsed(elapsedMs)}`;
}

function renderStreamingBubble(rawText, apiThinking, { partial = true } = {}) {
  const render = partial ? renderPartialMarkdown : renderMarkdown;
  let thinkingText = apiThinking;
  let contentText = rawText;
  let isThinking = false;

  if (!thinkingText) {
    const parsed = parseThinkingTags(rawText);
    thinkingText = parsed.thinking;
    contentText = parsed.content;
    isThinking = parsed.isThinking;
  }

  // We need timing from the stream object, but this function is also used
  // for static rendering (finished messages). For static, elapsed is baked
  // into the apiThinking path or we just show "Thought".
  // For live streams, the caller passes timing via the stream object and
  // this function reads from a temporary holder on the function itself.
  const timing = renderStreamingBubble._timing || { start: 0, elapsed: 0 };

  if (thinkingText && !timing.start) {
    timing.start = Date.now();
  }
  if (thinkingText && !isThinking && !timing.elapsed) {
    timing.elapsed = timing.start ? Date.now() - timing.start : 0;
  }

  let html = '';
  const contextMode = renderStreamingBubble._contextMode || '';
  if (contextMode) {
    html += renderAssistantContextBadge(contextMode);
  }
  if (thinkingText) {
    html += isThinking
      ? buildThinkingHtml('', { streaming: true })
      : buildThinkingHtml(thinkingText, { streaming: false, elapsed: timing.elapsed || 0 });
  }
  if (contentText) {
    html += render(linkifyAssistantContent(contentText));
  }
  if (!contentText && !thinkingText) {
    const statusText = renderStreamingBubble._statusText || 'Waiting for model...';
    html += `<div class="stream-status">${escapeHtml(statusText)}</div>`;
  }
  return html;
}

// ========== Streaming ==========

/**
 * Create the streaming message DOM element for an active stream,
 * rendering any text accumulated so far.
 */
function createStreamingElement(stream) {
  // Remove any leftover streaming element
  const old = document.getElementById('streamingMessage');
  if (old) old.remove();

  const streamEl = document.createElement('div');
  streamEl.className = 'message message-assistant';
  streamEl.id = 'streamingMessage';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble streaming-cursor';

  // Render what's been accumulated so far
  if (stream.streamedText || stream.streamedThinking) {
    renderStreamingBubble._timing = { start: stream.thinkingStartTime, elapsed: stream.thinkingElapsed };
    renderStreamingBubble._contextMode = stream.contextMode || '';
    renderStreamingBubble._statusText = stream.statusText || '';
    setAssistantBubbleHtml(bubble, renderStreamingBubble(stream.streamedText, stream.streamedThinking));
    renderStreamingBubble._timing = null;
    renderStreamingBubble._contextMode = '';
    renderStreamingBubble._statusText = '';
  } else if (stream.statusText) {
    renderStreamingBubble._statusText = stream.statusText;
    setAssistantBubbleHtml(bubble, renderStreamingBubble('', ''));
    renderStreamingBubble._statusText = '';
  }

  streamEl.appendChild(bubble);
  messagesEl.appendChild(streamEl);
  updateScrollToBottomButton();
}

/**
 * Update the streaming DOM if the given stream's tab is currently displayed.
 */
function updateStreamingDOM(stream) {
  if (state.currentTabId !== stream.tabId) return;
  const bubble = document.querySelector('#streamingMessage .message-bubble');
  if (!bubble) return;

  renderStreamingBubble._timing = { start: stream.thinkingStartTime, elapsed: stream.thinkingElapsed };
  renderStreamingBubble._contextMode = stream.contextMode || '';
  renderStreamingBubble._statusText = stream.statusText || '';
  setAssistantBubbleHtml(bubble, renderStreamingBubble(stream.streamedText, stream.streamedThinking));
  renderStreamingBubble._timing = null;
  renderStreamingBubble._contextMode = '';
  renderStreamingBubble._statusText = '';

  bubble.classList.add('streaming-cursor');
  scrollToBottom();
}

async function startStreaming() {
  const tabId = state.currentTabId;
  sendBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');

  // Re-distill the page so the AI sees the current DOM state
  try {
    const freshContext = await Promise.race([
      browser.runtime.sendMessage({
        type: 'getDistilledContent',
        tabId,
        options: { includeTechnicalContext: !!state.technicalAnalysisMode },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000)),
    ]);
    if (freshContext && !freshContext.error) {
      state.pageContext = freshContext;
      updatePageInfo();
    }
  } catch {
    // Keep existing context
  }

  maybeAppendContextLimitNotice();

  const stream = {
    tabId,
    port: null,
    streamedText: '',
    streamedThinking: '',
    thinkingStartTime: 0,
    thinkingElapsed: 0,
    contextMode: '',
    userAborted: false,
    statusText: 'Preparing request...',
    lastHeartbeatAt: 0,
    elapsedMs: 0,
  };
  activeStreams.set(tabId, stream);

  // Create streaming message placeholder
  createStreamingElement(stream);
  scrollToBottom();

  // Open port connection
  const port = browser.runtime.connect({ name: 'ai-chat' });
  stream.port = port;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'stream_thinking') {
      if (!stream.thinkingStartTime) stream.thinkingStartTime = Date.now();
      stream.streamedThinking += msg.token;
      updateStreamingDOM(stream);
    } else if (msg.type === 'stream_token') {
      stream.streamedText += msg.token;
      if (stream.streamedThinking && !stream.thinkingElapsed) {
        stream.thinkingElapsed = Date.now() - stream.thinkingStartTime;
      }
      updateStreamingDOM(stream);
    } else if (msg.type === 'context_mode') {
      stream.contextMode = msg.mode || '';
      updateStreamingDOM(stream);
    } else if (msg.type === 'heartbeat') {
      stream.lastHeartbeatAt = Date.now();
      stream.elapsedMs = Number(msg.elapsedMs) || stream.elapsedMs || 0;
      stream.statusText = buildStreamStatusText(msg.message, stream.elapsedMs);
      updateStreamingDOM(stream);
    } else if (msg.type === 'stream_end') {
      finishStream(tabId, msg.aborted);
    } else if (msg.type === 'error') {
      finishStream(tabId, !stream.streamedText);
      appendErrorMessage({
        title: msg.partial ? 'Answer may be incomplete' : 'Request failed',
        message: msg.userMessage || msg.error || 'The AI request failed.',
        technicalDetails: msg.technicalDetails || msg.error || '',
        retryable: !!msg.retryable,
        code: msg.code || '',
        status: msg.status || null,
        partial: !!msg.partial,
      }, { tabId });
    }
  });

  port.onDisconnect.addListener(() => {
    const disconnectedStream = activeStreams.get(tabId);
    if (!disconnectedStream) return;
    finishStream(tabId, true);
    if (!disconnectedStream.userAborted) {
      appendErrorMessage({
        title: 'Connection interrupted',
        message: 'The request stopped before the extension received a complete answer.',
        technicalDetails: [
          'The sidebar port disconnected while an AI request was still active.',
          `Provider: ${state.settings?.activeProvider || 'unknown'}`,
          `Received characters before disconnect: ${disconnectedStream.streamedText.length}`,
          `Last keepalive: ${disconnectedStream.lastHeartbeatAt ? new Date(disconnectedStream.lastHeartbeatAt).toISOString() : 'never'}`,
          `Elapsed before disconnect: ${formatStreamElapsed(disconnectedStream.elapsedMs || 0)}`,
        ].join('\n'),
        retryable: true,
      }, { tabId });
    }
  });

  // Build messages for the API
  const apiMessages = state.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const o = { role: m.role, content: m.content };
      if (m.thinking) o.thinking = m.thinking;
      if (m.role === 'user' && m.actionId) o.actionId = m.actionId;
      if (m.role === 'user' && m.actionLabel) o.actionLabel = m.actionLabel;
      return o;
    });

  port.postMessage({
    type: 'chat',
    messages: apiMessages,
    pageContext: state.pageContext,
    chatOptions: {
      technicalAnalysisMode: !!state.technicalAnalysisMode,
    },
  });
}

function finishStream(tabId, aborted) {
  const stream = activeStreams.get(tabId);
  if (!stream) return;
  activeStreams.delete(tabId);

  // Add the assistant message to the tab's saved state
  const tabState = tabStates.get(tabId);
  if (stream.streamedText && tabState) {
    const msg = { role: 'assistant', content: stream.streamedText };
    if (stream.streamedThinking) msg.thinking = stream.streamedThinking;
    if (stream.contextMode) msg.contextMode = stream.contextMode;
    tabState.messages.push(msg);
  }

  // If this tab is currently displayed, update the DOM
  if (state.currentTabId === tabId) {
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');

    const streamEl = document.getElementById('streamingMessage');
    if (streamEl) {
      const bubble = streamEl.querySelector('.message-bubble');
      bubble.classList.remove('streaming-cursor');

      if (stream.streamedText) {
        renderStreamingBubble._timing = { start: stream.thinkingStartTime, elapsed: stream.thinkingElapsed };
        renderStreamingBubble._contextMode = stream.contextMode || '';
        setAssistantBubbleHtml(bubble, renderStreamingBubble(stream.streamedText, stream.streamedThinking, { partial: false }));
        renderStreamingBubble._timing = null;
        renderStreamingBubble._contextMode = '';

        const msg = { role: 'assistant', content: stream.streamedText };
        if (stream.streamedThinking) msg.thinking = stream.streamedThinking;
        if (stream.contextMode) msg.contextMode = stream.contextMode;
        state.messages.push(msg);
      } else if (!aborted) {
        const msg = normalizeErrorMessage({
          title: 'No response received',
          message: 'The provider finished without returning visible text.',
          technicalDetails: [
            `Provider: ${state.settings?.activeProvider || 'unknown'}`,
            `Context mode: ${stream.contextMode || 'unknown'}`,
          ].join('\n'),
          retryable: true,
        });
        setSanitizedHtml(bubble, renderErrorMessage(msg));
        bindErrorBubbleActions(bubble);
        state.messages.push(msg);
      } else {
        streamEl.remove();
      }
      streamEl.removeAttribute('id');
    }

    saveTabState();
    updateScrollToBottomButton();
    updateHistoryDropdownUI();
    userInput.focus();
  }
}

function appendMessageForTab(tabId, message) {
  if (state.currentTabId === tabId) {
    appendMessage(message);
    return;
  }

  const tabState = tabStates.get(tabId);
  if (!tabState) return;
  tabState.messages.push(message);
  tabStates.set(tabId, tabState);
}

function appendErrorMessage(input, { tabId = state.currentTabId } = {}) {
  appendMessageForTab(tabId, normalizeErrorMessage(input));
}

function abortStreaming() {
  const stream = activeStreams.get(state.currentTabId);
  if (stream) stream.userAborted = true;
  stream?.port?.postMessage({ type: 'abort' });
}

// ========== Input Handling ==========
function autoResize() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
}

function getCurrentDraftText() {
  if (userInput && typeof userInput.value === 'string') {
    return userInput.value;
  }
  return typeof state.draftText === 'string' ? state.draftText : '';
}

// ========== Event Binding ==========
function bindEvents() {
  sendBtn.addEventListener('click', handleSend);
  stopBtn.addEventListener('click', abortStreaming);
  settingsBtn.addEventListener('click', () => browser.runtime.openOptionsPage());
  languageToggleBtn.addEventListener('click', () => {
    void toggleResponseLanguage();
  });
  welcomeTechToggleBtn?.addEventListener('click', () => {
    state.technicalAnalysisMode = !state.technicalAnalysisMode;
    updateTechnicalModeUI();
    if (state.mode === 'chat') renderActionBar();
    saveTabState();
  });
  historyToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHistoryMenu();
  });
  document.addEventListener('click', (e) => {
    if (!historyDropdownEl.contains(e.target)) closeHistoryMenu();
    const actionMenuWrap = $('#actionMenuWrap');
    const actionMenu = $('#actionMenu');
    const clickedInsideMenu = !!(actionMenuWrap && actionMenuWrap.contains(e.target));
    if (actionMenu && !clickedInsideMenu) {
      actionMenu.classList.add('hidden');
    }
    if (clearChatConfirmArmed && !clickedInsideMenu) {
      disarmClearChatConfirm();
    }
  });
  messagesEl.addEventListener('scroll', handleMessagesScroll);
  messagesEl.addEventListener('click', (e) => {
    const link = e.target?.closest?.('a[href^="source:"]');
    const groupLink = e.target?.closest?.('a[href^="source-group:"]');
    const targetLink = link || groupLink;
    if (targetLink) {
      e.preventDefault();
      const href = targetLink.getAttribute('href') || '';
      if (href.startsWith('source-group:')) {
        const groupLabel = href.replace(/^source-group:/i, '');
        void scrollToSourceGroupFromChat(groupLabel);
        return;
      }
      const sourceId = href.replace(/^source:/i, '');
      void scrollToSourceFromChat(sourceId);
      return;
    }

    const externalLink = e.target?.closest?.('a[href]');
    const timestampLink = parseYouTubeTimestampLink(externalLink?.getAttribute('href') || '');
    if (timestampLink) {
      e.preventDefault();
      void seekCurrentYouTubeTimestamp(timestampLink);
    }
  });
  scrollToBottomBtn.addEventListener('click', () => {
    shouldAutoScroll = true;
    scrollToBottom(true);
  });

  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  userInput.addEventListener('input', () => {
    state.draftText = userInput.value;
    autoResize();
  });
  window.addEventListener('resize', () => {
    if (state.mode === 'chat') scheduleActionButtonsCompactMode();
  });

  // Live settings updates
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      state.settings = changes.settings.newValue;
      updateLanguageToggleUI();
      if (state.mode === 'chat') renderActionBar();
    }
  });

  // Tab switch — save current state, restore new tab (streams keep running)
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (state.currentWindowId == null || windowId !== state.currentWindowId) return;
    void handleTabChange(tabId);
  });

  // In-tab navigation — switch to chat that belongs to the new page URL
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (state.currentWindowId != null && tab?.windowId !== state.currentWindowId) return;
    if (tabId === state.currentTabId && changeInfo.status === 'complete') {
      const nextPageKey = normalizePageUrl(tab?.url);
      if (nextPageKey !== state.currentPageKey) {
        disarmClearChatConfirm();
        saveTabState();
        state.currentPageKey = nextPageKey;
        void restoreTabState(tabId);
      } else {
        if (!pageContextMatchesCurrentPage()) {
          fetchPageContext();
        }
      }
    }
  });

  // Clean up when a tab is closed
  browser.tabs.onRemoved.addListener((tabId) => {
    const stream = activeStreams.get(tabId);
    if (stream) {
      stream.port?.postMessage({ type: 'abort' });
      activeStreams.delete(tabId);
    }
    tabStates.delete(tabId);
  });

}

// ========== Start ==========
init();

function normalizePageUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function cloneChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(msg => msg && (
      msg.role === 'user' ||
      msg.role === 'assistant' ||
      msg.role === 'notice' ||
      msg.role === 'error'
    ))
    .map(msg => {
      const cloned = { role: msg.role, content: typeof msg.content === 'string' ? msg.content : '' };
      if (typeof msg.thinking === 'string' && msg.thinking) cloned.thinking = msg.thinking;
      if (msg.role === 'user') {
        if (typeof msg.actionId === 'string' && msg.actionId) cloned.actionId = msg.actionId;
        if (typeof msg.actionLabel === 'string' && msg.actionLabel) cloned.actionLabel = msg.actionLabel;
        if (typeof msg.technicalModeUsed === 'boolean') cloned.technicalModeUsed = msg.technicalModeUsed;
      }
      if (msg.role === 'assistant') {
        if (typeof msg.contextMode === 'string' && msg.contextMode) cloned.contextMode = msg.contextMode;
      }
      if (msg.role === 'notice') {
        if (typeof msg.noticeKey === 'string') cloned.noticeKey = msg.noticeKey;
        if (typeof msg.signature === 'string') cloned.signature = msg.signature;
        if (Array.isArray(msg.details)) cloned.details = msg.details.map(x => String(x));
      }
      if (msg.role === 'error') {
        if (typeof msg.title === 'string') cloned.title = msg.title;
        if (typeof msg.message === 'string') cloned.message = msg.message;
        if (typeof msg.technicalDetails === 'string') cloned.technicalDetails = msg.technicalDetails;
        if (typeof msg.retryable === 'boolean') cloned.retryable = msg.retryable;
        if (typeof msg.action === 'string') cloned.action = msg.action;
        if (typeof msg.code === 'string') cloned.code = msg.code;
        if (msg.status != null) cloned.status = msg.status;
        if (typeof msg.partial === 'boolean') cloned.partial = msg.partial;
      }
      return cloned;
    });
}

async function getPageKeyForTabId(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    return normalizePageUrl(tab?.url);
  } catch {
    return null;
  }
}

async function loadPersistedChatsByPage() {
  const saved = await browser.storage.local.get(PAGE_CHATS_STORAGE_KEY);
  const chats = saved?.[PAGE_CHATS_STORAGE_KEY];
  if (!chats || typeof chats !== 'object' || Array.isArray(chats)) return {};
  return chats;
}

function trimPersistedChats(chatsByPage) {
  const entries = Object.entries(chatsByPage);
  entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_SAVED_PAGE_CHATS));
}

async function loadPersistedChatForPage(pageKey) {
  if (!pageKey) return null;
  const chats = await loadPersistedChatsByPage();
  const saved = chats[pageKey];
  if (!saved) return null;
  const messages = Array.isArray(saved.messages) ? saved.messages : [];
  const draftText = typeof saved.draftText === 'string' ? saved.draftText : '';
  if (messages.length === 0 && !draftText) return null;
  return {
    mode: saved.mode === 'chat' ? 'chat' : 'welcome',
    messages: cloneChatMessages(messages),
    draftText,
    pageContext: saved.pageContext || null,
    technicalAnalysisMode: !!saved.technicalAnalysisMode,
  };
}

async function persistCurrentPageChat() {
  const pageKey = state.currentPageKey;
  if (!pageKey) return;

  const chats = await loadPersistedChatsByPage();
  const hasConversation = state.mode === 'chat' && state.messages.length > 0;
  const draftText = getCurrentDraftText();

  if (!hasConversation) {
    delete chats[pageKey];
    await browser.storage.local.set({ [PAGE_CHATS_STORAGE_KEY]: chats });
    return;
  }

  chats[pageKey] = {
    mode: state.mode === 'chat' ? 'chat' : 'welcome',
    messages: cloneChatMessages(state.messages),
    draftText,
    pageContext: state.pageContext || null,
    technicalAnalysisMode: !!state.technicalAnalysisMode,
    updatedAt: Date.now(),
  };

  await browser.storage.local.set({ [PAGE_CHATS_STORAGE_KEY]: trimPersistedChats(chats) });
}

function queuePersistCurrentPageChat() {
  persistQueue = persistQueue
    .then(() => persistCurrentPageChat())
    .catch(() => {});
}
