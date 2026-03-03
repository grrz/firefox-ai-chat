import {renderMarkdown, renderPartialMarkdown} from './lib/markdown.js';
import {ACTIONS} from '../shared/actions.js';
import {loadSettings} from '../shared/settings.js';
import {PROVIDERS} from '../shared/constants.js';

// ========== State ==========

// Display state for the currently visible tab
const state = {
  mode: 'welcome', // 'welcome' | 'chat'
  messages: [],     // {role: 'user'|'assistant', content: string}
  pageContext: null,
  settings: null,
  currentTabId: null,
};

// Per-tab conversation state (in-memory, lost when sidebar closes)
const tabStates = new Map();

// Active streams that keep running even when their tab isn't displayed.
// Keyed by tabId → { port, streamedText, streamedThinking, thinkingStartTime, thinkingElapsed, tabId }
const activeStreams = new Map();

// ========== DOM References ==========
const $ = (sel) => document.querySelector(sel);
const welcomeState = $('#welcomeState');
const chatState = $('#chatState');
const messagesEl = $('#messages');
const actionCardsEl = $('#actionCards');
const actionBarEl = $('#actionBar');
const userInput = $('#userInput');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');
const newChatBtn = $('#newChatBtn');
const settingsBtn = $('#settingsBtn');
const loadingOverlay = $('#loadingOverlay');
const pageTitleEl = $('#pageTitle');
const pageWordCountEl = $('#pageWordCount');

// ========== Initialization ==========
async function init() {
  state.settings = await loadSettings();
  renderActionCards();
  bindEvents();

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    state.currentTabId = tabs[0].id;
  }
  fetchPageContext();
}

// ========== Per-Tab State ==========
function saveTabState() {
  if (state.currentTabId == null) return;
  tabStates.set(state.currentTabId, {
    mode: state.mode,
    messages: [...state.messages],
    pageContext: state.pageContext,
  });
}

function restoreTabState(tabId) {
  const saved = tabStates.get(tabId);
  const stream = activeStreams.get(tabId);

  if (saved) {
    state.mode = saved.mode;
    state.messages = [...saved.messages];
    state.pageContext = saved.pageContext;
  } else {
    state.mode = 'welcome';
    state.messages = [];
    state.pageContext = null;
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
  } else if (!saved || saved.messages.length === 0) {
    fetchPageContext();
  }
}

function rebuildUI() {
  userInput.value = '';
  autoResize();
  messagesEl.innerHTML = '';
  actionBarEl.innerHTML = '';

  // Reset button state (streaming tabs override this after rebuildUI)
  sendBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');

  if (state.mode === 'chat' && state.messages.length > 0) {
    welcomeState.classList.add('hidden');
    chatState.classList.remove('hidden');
    for (let i = 0; i < state.messages.length; i++) {
      const msg = state.messages[i];
      if (msg.role === 'user' || msg.role === 'assistant') {
        const el = renderMessage(msg, i);
        if (msg.role === 'assistant') {
          const bubble = el.querySelector('.message-bubble');
          bubble.innerHTML = renderStreamingBubble(msg.content, msg.thinking || '', { partial: false });
        }
        messagesEl.appendChild(el);
      }
    }
    renderActionBar();
    scrollToBottom();
  } else {
    welcomeState.classList.remove('hidden');
    chatState.classList.add('hidden');
    updatePageInfo();
  }
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

async function handleTabChange(tabId) {
  if (tabId === state.currentTabId) return;

  // Save current tab's conversation (don't abort its stream)
  saveTabState();

  // Switch to new tab
  state.currentTabId = tabId;
  restoreTabState(tabId);
}

// ========== Page Context ==========
async function fetchPageContext(retries = 2) {
  try {
    loadingOverlay.classList.remove('hidden');
    state.pageContext = await Promise.race([
      browser.runtime.sendMessage({type: 'getDistilledContent'}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
  } catch {
    if (retries > 0) {
      // Content script may not be injected yet — retry after a short delay
      await new Promise(r => setTimeout(r, 500));
      return fetchPageContext(retries - 1);
    }
    state.pageContext = { title: '', url: '', textContent: '', wordCount: 0, error: 'Could not access page' };
  } finally {
    loadingOverlay.classList.add('hidden');
    updatePageInfo();
  }
}

// ========== UI State Switching ==========
function switchToChat() {
  state.mode = 'chat';
  welcomeState.classList.add('hidden');
  chatState.classList.remove('hidden');
  renderActionBar();
}

function switchToWelcome() {
  // Abort stream for current tab if any
  const stream = activeStreams.get(state.currentTabId);
  if (stream) {
    stream.port?.postMessage({ type: 'abort' });
  }

  state.mode = 'welcome';
  state.messages = [];
  welcomeState.classList.remove('hidden');
  chatState.classList.add('hidden');
  messagesEl.innerHTML = '';
  actionBarEl.innerHTML = '';
  userInput.value = '';
  autoResize();
  sendBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  updatePageInfo();
  if (state.currentTabId != null) {
    tabStates.delete(state.currentTabId);
  }
}

// ========== Actions ==========
function renderActionCards() {
  actionCardsEl.innerHTML = ACTIONS.map(action => `
    <div class="action-card" data-action="${action.id}">
      <div class="action-card-icon">${action.icon}</div>
      <div class="action-card-label">${action.label}</div>
    </div>
  `).join('');

  actionCardsEl.querySelectorAll('.action-card').forEach(card => {
    card.addEventListener('click', () => executeAction(card.dataset.action));
  });
}

function renderActionBar() {
  actionBarEl.innerHTML = ACTIONS.map(action => `
    <button class="action-btn" data-action="${action.id}">
      ${action.icon}
      ${action.label}
    </button>
  `).join('');

  actionBarEl.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (activeStreams.has(state.currentTabId)) return;
      executeAction(btn.dataset.action);
    });
  });
}

function executeAction(actionId) {
  const action = ACTIONS.find(a => a.id === actionId);
  if (!action) return;
  userInput.value = action.prompt;
  handleSend();
}

// ========== Message Rendering ==========
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderMessage(message, index) {
  const el = document.createElement('div');
  el.className = `message message-${message.role}`;
  el.dataset.index = index;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  if (message.role === 'user') {
    bubble.textContent = message.content;
  } else if (message.role === 'assistant') {
    bubble.innerHTML = renderMarkdown(message.content);
  } else if (message.role === 'error') {
    bubble.innerHTML = message.content;
  }

  el.appendChild(bubble);
  return el;
}

function appendMessage(message) {
  state.messages.push(message);
  const el = renderMessage(message, state.messages.length - 1);
  messagesEl.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ========== Pre-flight Checks ==========
function checkApiKey() {
  const providerId = state.settings.activeProvider;
  const providerDef = PROVIDERS[providerId];
  const providerSettings = state.settings.providers[providerId];

  if (providerDef.requiresKey && !providerSettings?.apiKey) {
    return {
      valid: false,
      error: `No API key configured for ${providerDef.name}. <span class="error-link" id="openSettings">Open Settings</span> to add one.`,
    };
  }
  return { valid: true };
}

// ========== Send & Stream ==========
function handleSend() {
  const text = userInput.value.trim();
  if (!text || activeStreams.has(state.currentTabId)) return;

  const keyCheck = checkApiKey();
  if (!keyCheck.valid) {
    if (state.mode === 'welcome') switchToChat();
    appendMessage({ role: 'user', content: text });
    appendErrorMessage(keyCheck.error);
    userInput.value = '';
    autoResize();
    return;
  }

  if (state.mode === 'welcome') switchToChat();

  appendMessage({ role: 'user', content: text });
  userInput.value = '';
  autoResize();

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
  if (thinkingText) {
    html += isThinking
      ? buildThinkingHtml('', { streaming: true })
      : buildThinkingHtml(thinkingText, { streaming: false, elapsed: timing.elapsed || 0 });
  }
  if (contentText) {
    html += render(contentText);
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
    bubble.innerHTML = renderStreamingBubble(stream.streamedText, stream.streamedThinking);
    renderStreamingBubble._timing = null;
  }

  streamEl.appendChild(bubble);
  messagesEl.appendChild(streamEl);
}

/**
 * Update the streaming DOM if the given stream's tab is currently displayed.
 */
function updateStreamingDOM(stream) {
  if (state.currentTabId !== stream.tabId) return;
  const bubble = document.querySelector('#streamingMessage .message-bubble');
  if (!bubble) return;

  renderStreamingBubble._timing = { start: stream.thinkingStartTime, elapsed: stream.thinkingElapsed };
  bubble.innerHTML = renderStreamingBubble(stream.streamedText, stream.streamedThinking);
  renderStreamingBubble._timing = null;

  bubble.classList.add('streaming-cursor');
  scrollToBottom();
}

async function startStreaming() {
  const tabId = state.currentTabId;
  sendBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');

  // Re-distill the page so the AI sees the current DOM state
  try {
    const freshContext = await browser.runtime.sendMessage({ type: 'getDistilledContent' });
    if (freshContext && !freshContext.error) {
      state.pageContext = freshContext;
      updatePageInfo();
    }
  } catch {
    // Keep existing context
  }

  const stream = {
    tabId,
    port: null,
    streamedText: '',
    streamedThinking: '',
    thinkingStartTime: 0,
    thinkingElapsed: 0,
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
    } else if (msg.type === 'stream_end') {
      finishStream(tabId, msg.aborted);
    } else if (msg.type === 'error') {
      finishStream(tabId, false);
      if (state.currentTabId === tabId) {
        let errorHtml = escapeHtml(msg.error);
        if (msg.error.includes('API key')) {
          errorHtml += ` <span class="error-link" id="openSettings">Open Settings</span>`;
        }
        if (msg.retryable) {
          errorHtml += ' (you can try again)';
        }
        appendErrorMessage(errorHtml);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (activeStreams.has(tabId)) finishStream(tabId, true);
  });

  // Build messages for the API
  const apiMessages = state.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const o = { role: m.role, content: m.content };
      if (m.thinking) o.thinking = m.thinking;
      return o;
    });

  port.postMessage({
    type: 'chat',
    messages: apiMessages,
    pageContext: state.pageContext,
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
        bubble.innerHTML = renderStreamingBubble(stream.streamedText, stream.streamedThinking, { partial: false });
        renderStreamingBubble._timing = null;

        const msg = { role: 'assistant', content: stream.streamedText };
        if (stream.streamedThinking) msg.thinking = stream.streamedThinking;
        state.messages.push(msg);
      } else if (!aborted) {
        bubble.innerHTML = '<em>No response received.</em>';
      } else {
        streamEl.remove();
      }
      streamEl.removeAttribute('id');
    }

    saveTabState();
    userInput.focus();
  }
}

function appendErrorMessage(html) {
  const el = document.createElement('div');
  el.className = 'message message-error';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = html;

  const settingsLink = bubble.querySelector('#openSettings');
  if (settingsLink) {
    settingsLink.addEventListener('click', () => browser.runtime.openOptionsPage());
  }

  el.appendChild(bubble);
  messagesEl.appendChild(el);
  scrollToBottom();
}

function abortStreaming() {
  const stream = activeStreams.get(state.currentTabId);
  stream?.port?.postMessage({ type: 'abort' });
}

// ========== Input Handling ==========
function autoResize() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
}

// ========== Event Binding ==========
function bindEvents() {
  sendBtn.addEventListener('click', handleSend);
  stopBtn.addEventListener('click', abortStreaming);
  newChatBtn.addEventListener('click', switchToWelcome);
  settingsBtn.addEventListener('click', () => browser.runtime.openOptionsPage());

  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  userInput.addEventListener('input', autoResize);

  // Live settings updates
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      state.settings = changes.settings.newValue;
    }
  });

  // Tab switch — save current state, restore new tab (streams keep running)
  browser.tabs.onActivated.addListener(({ tabId }) => {
    handleTabChange(tabId);
  });

  // In-tab navigation — refresh page context but keep conversation
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.currentTabId && changeInfo.status === 'complete') {
      fetchPageContext();
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
