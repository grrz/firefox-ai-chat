import { loadSettings, saveSettings } from '../shared/settings.js';

const $ = (sel) => document.querySelector(sel);
const PAGE_CHATS_STORAGE_KEY = 'pageChatsByUrl';
let savedChatsFilterValue = '';

// DOM Elements
const activeProviderEl = $('#activeProvider');
const responseLanguageEl = $('#responseLanguage');
const claudeApiKeyEl = $('#claude-apiKey');
const claudeModelEl = $('#claude-model');
const openaiApiKeyEl = $('#openai-apiKey');
const openaiModelEl = $('#openai-model');
const grokApiKeyEl = $('#grok-apiKey');
const grokModelEl = $('#grok-model');
const lmstudioEndpointEl = $('#lmstudio-endpoint');
const lmstudioModelEl = $('#lmstudio-model');
const savedChatsListEl = $('#savedChatsList');
const savedChatsMetaEl = $('#savedChatsMeta');
const savedChatsFilterEl = $('#savedChatsFilter');
const saveBtnEl = $('#save');
const statusEl = $('#status');

function showProviderConfig(providerId) {
  document.querySelectorAll('.provider-config').forEach(el => {
    el.classList.toggle('active', el.dataset.provider === providerId);
  });
}

async function loadForm() {
  const settings = await loadSettings();

  activeProviderEl.value = settings.activeProvider;
  responseLanguageEl.value = settings.responseLanguage;
  showProviderConfig(settings.activeProvider);

  // Claude
  claudeApiKeyEl.value = settings.providers.claude.apiKey || '';
  claudeModelEl.value = settings.providers.claude.model || '';

  // OpenAI
  openaiApiKeyEl.value = settings.providers.openai.apiKey || '';
  openaiModelEl.value = settings.providers.openai.model || '';

  // Grok
  grokApiKeyEl.value = settings.providers.grok.apiKey || '';
  grokModelEl.value = settings.providers.grok.model || '';

  // LM Studio
  lmstudioEndpointEl.value = settings.providers.lmstudio.endpoint || '';
  lmstudioModelEl.value = settings.providers.lmstudio.model || '';

  await renderSavedChats();
}

function formatDate(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleString();
}

function getMessageCount(entry) {
  if (!entry || !Array.isArray(entry.messages)) return 0;
  return entry.messages.length;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function renderSavedChats() {
  const saved = await browser.storage.local.get(PAGE_CHATS_STORAGE_KEY);
  const chats = saved?.[PAGE_CHATS_STORAGE_KEY];
  const listEl = savedChatsListEl;
  const metaEl = savedChatsMetaEl;

  if (!chats || typeof chats !== 'object' || Array.isArray(chats) || Object.keys(chats).length === 0) {
    metaEl.textContent = 'Total: 0';
    listEl.innerHTML = '<div class="saved-chat-empty">No saved chats yet.</div>';
    return;
  }

  const entries = Object.entries(chats)
    .map(([url, entry]) => ({
      url,
      updatedAt: entry?.updatedAt || 0,
      messageCount: getMessageCount(entry),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const filteredEntries = savedChatsFilterValue
    ? entries.filter((entry) => entry.url.toLowerCase().includes(savedChatsFilterValue))
    : entries;

  metaEl.textContent = `Showing: ${filteredEntries.length} of ${entries.length}`;

  if (filteredEntries.length === 0) {
    listEl.innerHTML = '<div class="saved-chat-empty">No chats match this filter.</div>';
    return;
  }

  listEl.innerHTML = filteredEntries.map((entry) => `
    <div class="saved-chat-item">
      <div class="saved-chat-url"><a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.url)}</a></div>
      <div class="saved-chat-meta">${entry.messageCount} messages • Updated: ${escapeHtml(formatDate(entry.updatedAt))}</div>
    </div>
  `).join('');
}

async function saveForm() {
  const settings = {
    activeProvider: activeProviderEl.value,
    responseLanguage: responseLanguageEl.value,
    providers: {
      claude: {
        apiKey: claudeApiKeyEl.value.trim(),
        model: claudeModelEl.value.trim(),
      },
      openai: {
        apiKey: openaiApiKeyEl.value.trim(),
        model: openaiModelEl.value.trim(),
      },
      grok: {
        apiKey: grokApiKeyEl.value.trim(),
        model: grokModelEl.value.trim(),
      },
      lmstudio: {
        endpoint: lmstudioEndpointEl.value.trim(),
        model: lmstudioModelEl.value.trim(),
      },
    },
    ui: {},
  };

  await saveSettings(settings);
  await renderSavedChats();
  const status = statusEl;
  status.textContent = 'Settings saved!';
  setTimeout(() => { status.textContent = ''; }, 2000);
}

activeProviderEl.addEventListener('change', (e) => {
  showProviderConfig(e.target.value);
});

saveBtnEl.addEventListener('click', saveForm);
savedChatsFilterEl.addEventListener('input', (e) => {
  savedChatsFilterValue = e.target.value.trim().toLowerCase();
  void renderSavedChats();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PAGE_CHATS_STORAGE_KEY]) {
    void renderSavedChats();
  }
});

loadForm();
