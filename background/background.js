import {getProviderConfig, loadSettings} from '../shared/settings.js';
import {RESPONSE_LANGUAGES, SYSTEM_PROMPT} from '../shared/constants.js';
import {OpenAIProvider} from './providers/openai.js';
import {ClaudeProvider} from './providers/claude.js';
import {LMStudioProvider} from './providers/lmstudio.js';
import {ProviderError} from './providers/base.js';

const PAGE_CHATS_STORAGE_KEY = 'pageChatsByUrl';
const MAX_SAVED_PAGE_CHATS = 50;
const PORT_KEEPALIVE_INTERVAL_MS = 10000;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_RESOURCE_FETCH_TIMEOUT_MS = 4500;
const DEFAULT_RESOURCE_FETCH_LIMITS = {
  maxResources: 18,
  maxCharsPerResource: 70000,
  maxTotalChars: 320000,
};
const TEXT_RESOURCE_CONTENT_TYPE_RE = /^(?:text\/|image\/svg\+xml\b)|(?:javascript|ecmascript|json|manifest|xml)/i;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseIPv4(hostname) {
  const match = String(hostname || '').match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (!match) return null;
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function isLocalOrPrivateHostname(hostname) {
  const host = String(hostname || '').replace(/^\[(.*)]$/, '$1').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;

  const ipv4 = parseIPv4(host);
  if (!ipv4) return false;
  const [a, b] = ipv4;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function normalizeFetchableHttpUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function canFetchPageResource(resourceUrl, pageUrl) {
  const url = normalizeFetchableHttpUrl(resourceUrl);
  if (!url) return { ok: false, reason: 'unsupported URL scheme' };

  let page = null;
  try {
    page = pageUrl ? new URL(pageUrl) : null;
  } catch {}

  const resourceIsPrivate = isLocalOrPrivateHostname(url.hostname);
  const pageIsPrivate = page ? isLocalOrPrivateHostname(page.hostname) : false;
  if (resourceIsPrivate && !pageIsPrivate && url.origin !== page?.origin) {
    return { ok: false, reason: 'blocked private-network resource from public page' };
  }

  return { ok: true, url: url.toString() };
}

function isLikelyTextResourceUrl(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    return /\.(?:cjs|css|csv|html?|js|json|jsx|mjs|map|md|svg|text|ts|tsx|txt|xml)(?:$|[?#])/.test(pathname);
  } catch {
    return false;
  }
}

function isTextResourceCandidate(resource) {
  const kind = String(resource?.kind || '').toLowerCase();
  if (['script', 'stylesheet', 'manifest', 'fetch', 'xmlhttprequest', 'document', 'preload'].includes(kind)) return true;
  if (isLikelyTextResourceUrl(resource?.url || '')) return true;
  const type = String(resource?.type || '').toLowerCase();
  return type.startsWith('text/') ||
    type.includes('json') ||
    type.includes('javascript') ||
    type.includes('ecmascript') ||
    type.includes('xml') ||
    type.includes('svg');
}

async function readResponseTextWithLimit(response, charLimit) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const value = await response.text();
    return {
      text: value.slice(0, charLimit),
      truncated: value.length > charLimit,
      originalLength: value.length,
    };
  }

  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > charLimit) {
        text = text.slice(0, charLimit);
        truncated = true;
        try {
          await reader.cancel();
        } catch {}
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    try {
      reader.releaseLock?.();
    } catch {}
  }

  return {
    text,
    truncated,
    originalLength: text.length,
  };
}

async function fetchPageResourceText(resource, pageUrl, limits) {
  const permission = canFetchPageResource(resource?.url, pageUrl);
  const base = {
    id: String(resource?.id || ''),
    url: String(resource?.url || ''),
    kind: String(resource?.kind || 'resource'),
    sources: Array.isArray(resource?.sources) ? resource.sources.slice(0, 6) : [],
  };
  if (!permission.ok) return { ...base, skipped: permission.reason };
  if (!isTextResourceCandidate(resource)) return { ...base, skipped: 'not a text resource candidate' };

  try {
    const resp = await fetchWithTimeout(
      permission.url,
      {
        credentials: 'include',
        referrer: pageUrl || undefined,
        referrerPolicy: 'strict-origin-when-cross-origin',
      },
      limits.timeoutMs
    );
    const contentType = resp.headers.get('content-type') || '';
    const contentLength = Number(resp.headers.get('content-length') || 0);
    const likelyText = TEXT_RESOURCE_CONTENT_TYPE_RE.test(contentType) || isLikelyTextResourceUrl(resp.url || permission.url);

    if (!resp.ok) {
      return {
        ...base,
        status: resp.status,
        contentType,
        error: `HTTP ${resp.status}`,
      };
    }
    if (!likelyText) {
      return {
        ...base,
        status: resp.status,
        contentType,
        contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
        skipped: contentType ? `non-text content-type: ${contentType}` : 'non-text resource',
      };
    }

    const read = await readResponseTextWithLimit(resp, limits.maxCharsPerResource);
    return {
      ...base,
      url: resp.url || permission.url,
      status: resp.status,
      contentType,
      contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
      text: read.text,
      truncated: read.truncated,
      originalLength: read.originalLength,
    };
  } catch (err) {
    return {
      ...base,
      error: err?.name === 'AbortError' ? 'fetch timed out or was aborted' : (err?.message || 'fetch failed'),
    };
  }
}

async function fetchPageResources(message) {
  const rawLimits = message?.limits || {};
  const limits = {
    maxResources: clampNumber(rawLimits.maxResources, 1, 32, DEFAULT_RESOURCE_FETCH_LIMITS.maxResources),
    maxCharsPerResource: clampNumber(rawLimits.maxCharsPerResource, 1000, 150000, DEFAULT_RESOURCE_FETCH_LIMITS.maxCharsPerResource),
    maxTotalChars: clampNumber(rawLimits.maxTotalChars, 5000, 750000, DEFAULT_RESOURCE_FETCH_LIMITS.maxTotalChars),
    timeoutMs: clampNumber(rawLimits.timeoutMs, 1000, 10000, DEFAULT_RESOURCE_FETCH_TIMEOUT_MS),
  };
  const resources = Array.isArray(message?.resources) ? message.resources : [];
  const unique = [];
  const seen = new Set();
  for (const resource of resources) {
    const url = String(resource?.url || '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push(resource);
    if (unique.length >= limits.maxResources) break;
  }

  const fetchedRaw = await Promise.all(unique.map((resource) => (
    fetchPageResourceText(resource, message?.pageUrl || '', limits)
  )));

  const details = [];
  if (resources.length > unique.length) {
    details.push(`external resources: fetched candidates ${unique.length} of ${resources.length}`);
  }

  let totalChars = 0;
  const fetched = fetchedRaw.map((resource) => {
    if (!resource.text) return resource;
    if (totalChars >= limits.maxTotalChars) {
      details.push(`external resources: total text budget ${limits.maxTotalChars} chars reached`);
      return {
        ...resource,
        text: '',
        skipped: 'total text budget reached',
      };
    }
    const remaining = limits.maxTotalChars - totalChars;
    if (resource.text.length > remaining) {
      totalChars += remaining;
      details.push(`external resources: total text budget ${limits.maxTotalChars} chars reached`);
      return {
        ...resource,
        text: resource.text.slice(0, remaining),
        truncated: true,
        originalLength: resource.originalLength || resource.text.length,
      };
    }
    totalChars += resource.text.length;
    return resource;
  });

  const skipped = fetched.filter((resource) => resource.skipped || resource.error).length;
  if (skipped > 0) details.push(`external resources: ${skipped} fetches skipped or failed`);

  return {
    fetched,
    limits: {
      applied: details.length > 0,
      details,
    },
  };
}

function createProvider(settings) {
  const config = getProviderConfig(settings);
  switch (settings.activeProvider) {
    case 'claude':
      return new ClaudeProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'grok':
      return new OpenAIProvider(config);
    case 'lmstudio':
      return new LMStudioProvider(config);
    default:
      throw new Error(`Unknown provider: ${settings.activeProvider}`);
  }
}

function buildChatMessages(messages, pageContext, settings, options = {}) {
  const chatMessages = [];
  const useToolMode = !!options.useToolMode;

  let systemContent = SYSTEM_PROMPT;
  const selectedLanguage = RESPONSE_LANGUAGES[settings?.responseLanguage] || RESPONSE_LANGUAGES.en;
  systemContent += `\n\nCRITICAL OUTPUT RULE: Write your final answer only in ${selectedLanguage}.`;
  systemContent += `\nDo not switch to another language even if the user writes in another language.`;
  systemContent += `\nIf source content is in another language, translate or summarize it into ${selectedLanguage}.`;
  systemContent += '\nShort quotes may stay in the original language, but all explanations must remain in the required language.';
  if (pageContext?.sourceAnchors && Object.keys(pageContext.sourceAnchors).length > 0) {
    systemContent += '\n\nSource tags are provided in the page context as [sN].';
    systemContent += '\nFor each meaningful claim or list item, append one or more relevant tags like [s12] or [s12, s18].';
    systemContent += '\nOnly use source tags that exist in the context; never invent tags.';
  }
  if (Array.isArray(pageContext?.comments) && pageContext.comments.length > 0) {
    systemContent += `\n\nA separate user comments/discussion context is available with ${pageContext.comments.length} extracted comments.`;
    systemContent += '\nWhen the user asks about comments, discussion, replies, audience reaction, or commenter opinions, use the comments/discussion context specifically instead of the article body.';
  }
  if (isYouTubeWatchUrl(pageContext?.url)) {
    systemContent += '\n\nYouTube transcript lines may include compact timecodes, for example 1:23 (t=83s), plus a timestamp URL format line.';
    systemContent += '\nWhen answering about specific moments in the video, include the nearest relevant timecodes from the transcript. Prefer Markdown links using the provided timestamp URL format.';
    systemContent += '\nDo not invent timestamps that are not present in the page context.';
  }
  if (pageContext?.technicalContext) {
    systemContent += '\n\nTechnical DOM/CSS/JS analysis mode is enabled.';
    systemContent += '\nWhen the user asks implementation/debugging questions, use the TECHNICAL CONTEXT section.';
    systemContent += '\nIf a requested technical detail is not present there, say that explicitly instead of guessing.';
    const fetchedResources = pageContext.technicalContext?.resources?.fetched || [];
    const fetchedResourceCount = Array.isArray(fetchedResources)
      ? fetchedResources.filter((resource) => resource?.text).length
      : 0;
    if (fetchedResourceCount > 0) {
      systemContent += useToolMode
        ? `\nExternal page resource snapshots are available to tools for ${fetchedResourceCount} text resources, such as JS/CSS/JSON/HTML files. Use resource and JS symbol tools for exact source.`
        : `\nThe prompt includes compact resource and JS symbol indexes for ${fetchedResourceCount} fetched text resources. Large raw resource bodies are intentionally omitted from the prompt.`;
    }
  }
  systemContent += `\n\nFinal reminder: reply only in ${selectedLanguage}.`;
  if (pageContext?.textContent && !useToolMode) {
    systemContent += `\n\n--- PAGE CONTEXT ---\n${pageContext.textContent}\n--- END PAGE CONTEXT ---`;
  } else if (pageContext?.title || pageContext?.url) {
    systemContent += '\n\n--- PAGE SUMMARY ---';
    if (pageContext?.title) systemContent += `\nTitle: ${pageContext.title}`;
    if (pageContext?.url) systemContent += `\nURL: ${pageContext.url}`;
    if (pageContext?.wordCount) systemContent += `\nWord count: ${pageContext.wordCount}`;
    systemContent += '\n--- END PAGE SUMMARY ---';
  }
  chatMessages.push({ role: 'system', content: systemContent });

  for (const msg of messages) {
    const m = { role: msg.role, content: msg.content };
    if (msg.thinking) m.thinking = msg.thinking;
    chatMessages.push(m);
  }

  return chatMessages;
}

function isYouTubeWatchUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '');
    return (host === 'youtube.com' || host === 'm.youtube.com') && url.pathname === '/watch';
  } catch {
    return false;
  }
}

const YOUTUBE_TOOL_MODE_THRESHOLD = 30000;

function shouldUseToolMode(providerId, provider, pageContext) {
  if (providerId !== 'lmstudio' || typeof provider?.supportsTools !== 'function') return false;
  if (!pageContext?.textContent) return false;
  if (isYouTubeWatchUrl(pageContext?.url)) {
    return pageContext.textContent.length >= YOUTUBE_TOOL_MODE_THRESHOLD;
  }
  return true;
}

function mergeContextLimits(allLimitEntries) {
  const details = [];
  for (const entry of allLimitEntries) {
    if (!entry || !Array.isArray(entry.details)) continue;
    for (const detail of entry.details) {
      if (!details.includes(detail)) details.push(detail);
    }
  }
  return {
    applied: details.length > 0,
    details,
  };
}

function shouldRetryLMStudioWithoutTools(err, providerId, attemptedToolMode, streamedText = '') {
  if (!attemptedToolMode || providerId !== 'lmstudio' || !err) return false;
  if (String(streamedText || '').trim()) return false;
  const message = String(err?.message || '');
  return (
    /No user query found in messages|jinja template/i.test(message) ||
    err?.code === 'empty_response' ||
    err?.code === 'invalid_response' ||
    err?.code === 'tool_timeout'
  );
}

function shouldContinueIncompleteResponse(err, streamedText) {
  if (!err || err.code !== 'incomplete_response') return false;
  return !!String(streamedText || err.partialText || '').trim();
}

function buildContinuationMessages(baseMessages, partialText) {
  return [
    ...baseMessages,
    { role: 'assistant', content: String(partialText || '') },
    {
      role: 'user',
      content: 'Continue the previous answer from exactly where it stopped. Do not repeat completed text, do not restart, and keep the same language and formatting.',
    },
  ];
}

function stringifyErrorDetails(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getProviderModel(settings) {
  try {
    return getProviderConfig(settings)?.model || '';
  } catch {
    return '';
  }
}

function getFriendlyErrorMessage(err, streamedText = '') {
  const hasPartial = !!String(streamedText || err?.partialText || '').trim();
  if (err?.userMessage) return err.userMessage;
  if (err?.code === 'incomplete_response') {
    return hasPartial
      ? 'The model stopped before finishing. I kept the partial answer above.'
      : 'The model stopped before finishing and did not return visible text.';
  }
  if (err?.code === 'empty_response') {
    return 'The model finished without returning visible text. Your request was not lost; you can try again.';
  }
  if (err?.code === 'invalid_response') {
    return 'The model returned a response the extension could not read.';
  }
  if (err?.code === 'tool_timeout') {
    return 'The local model spent too long deciding how to use page tools. I stopped that attempt so it would not run forever.';
  }
  if (err?.code === 'content_filter') {
    return 'The provider blocked this response.';
  }
  if (/Network error/i.test(String(err?.message || ''))) {
    return 'The extension could not reach the selected AI provider.';
  }
  return 'The AI request failed before a complete answer was received.';
}

function buildTechnicalErrorDetails(err, settings, streamedText = '') {
  const lines = [
    `Provider: ${settings?.activeProvider || 'unknown'}`,
    `Model: ${getProviderModel(settings) || 'unknown'}`,
    `Error name: ${err?.name || 'Error'}`,
    `Message: ${err?.message || 'Unknown error'}`,
  ];

  if (err?.code) lines.push(`Code: ${err.code}`);
  if (err?.status) lines.push(`HTTP status: ${err.status}`);
  lines.push(`Retryable: ${err?.retryable ? 'yes' : 'no'}`);
  lines.push(`Partial response characters: ${String(streamedText || err?.partialText || '').length}`);

  const details = stringifyErrorDetails(err?.details);
  if (details) {
    lines.push('', 'Details:', details);
  }

  return lines.join('\n');
}

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

function clonePersistableMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((msg) => msg && (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string')
    .map((msg) => {
      const cloned = { role: msg.role, content: msg.content };
      if (typeof msg.thinking === 'string' && msg.thinking) cloned.thinking = msg.thinking;
      if (msg.role === 'assistant' && typeof msg.contextMode === 'string' && msg.contextMode) {
        cloned.contextMode = msg.contextMode;
      }
      if (msg.role === 'user') {
        if (typeof msg.actionId === 'string' && msg.actionId) cloned.actionId = msg.actionId;
        if (typeof msg.actionLabel === 'string' && msg.actionLabel) cloned.actionLabel = msg.actionLabel;
        if (typeof msg.technicalModeUsed === 'boolean') cloned.technicalModeUsed = msg.technicalModeUsed;
      }
      return cloned;
    });
}

function trimPersistedChats(chatsByPage) {
  const entries = Object.entries(chatsByPage);
  entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_SAVED_PAGE_CHATS));
}

async function persistChatForPage(pageKey, messages, pageContext, chatOptions = {}) {
  if (!pageKey) return;
  const saved = await browser.storage.local.get(PAGE_CHATS_STORAGE_KEY);
  const chatsByPage = (saved?.[PAGE_CHATS_STORAGE_KEY] && typeof saved[PAGE_CHATS_STORAGE_KEY] === 'object')
    ? saved[PAGE_CHATS_STORAGE_KEY]
    : {};

  chatsByPage[pageKey] = {
    mode: 'chat',
    messages: clonePersistableMessages(messages),
    pageContext: pageContext || null,
    technicalAnalysisMode: !!chatOptions.technicalAnalysisMode,
    updatedAt: Date.now(),
  };

  await browser.storage.local.set({ [PAGE_CHATS_STORAGE_KEY]: trimPersistedChats(chatsByPage) });
}

async function getDistilledContentForTab(tabId, options = {}) {
  const includeTechnicalContext = !!options.includeTechnicalContext;
  if (tabId == null) return { error: 'No tab specified' };
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return { error: 'Tab not found' };
  }

  if (isYouTubeWatchUrl(tab.url)) {
    return browser.tabs.sendMessage(
      tabId,
      {
        type: 'distill',
        options: {
          includeIframes: false,
          includeTechnicalContext,
        },
      },
      { frameId: 0 }
    );
  }

  const frameResponses = [];
  let frames;

  try {
    frames = await browser.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = [];
  }

  // Fallback to top frame if frame enumeration is unavailable.
  if (!Array.isArray(frames) || frames.length === 0) {
    return browser.tabs.sendMessage(
      tabId,
      {
        type: 'distill',
        options: {
          includeIframes: true,
          includeTechnicalContext,
        },
      },
      { frameId: 0 }
    );
  }

  for (const frame of frames) {
    try {
      const data = await browser.tabs.sendMessage(
        tabId,
        {
          type: 'distill',
          options: {
            includeIframes: false,
            includeTechnicalContext: includeTechnicalContext && frame.frameId === 0,
          },
        },
        { frameId: frame.frameId }
      );
      if (data && !data.error) {
        frameResponses.push({
          frameId: frame.frameId,
          url: frame.url || data.url || '',
          data,
        });
      }
    } catch {
      // Some frames are inaccessible (restricted/internal/cross-browser boundary).
    }
  }

  if (frameResponses.length === 0) {
    return {
      title: '',
      url: tab.url || '',
      textContent: '',
      wordCount: 0,
      error: 'Could not access page content. The page may not be fully loaded.',
    };
  }

  const topFrame = frameResponses.find((f) => f.frameId === 0) || frameResponses[0];
  const childFrames = frameResponses.filter((f) => f !== topFrame);

  const MAX_CHILD_FRAMES = 8;
  const includedChildFrames = childFrames.slice(0, MAX_CHILD_FRAMES);

  const parts = [topFrame.data.textContent || ''];
  for (const frame of includedChildFrames) {
    if (!frame.data.textContent) continue;
    const sectionTitle = frame.data.title || frame.url || `Frame ${frame.frameId}`;
    parts.push(`## Embedded frame: ${sectionTitle}\n\n${frame.data.textContent}`);
  }

  const limits = [];
  if (childFrames.length > MAX_CHILD_FRAMES) {
    limits.push(`embedded frames: included ${MAX_CHILD_FRAMES} of ${childFrames.length}`);
  }
  if (frames.length > frameResponses.length) {
    limits.push(`inaccessible frames skipped: ${frames.length - frameResponses.length}`);
  }

  const contextLimits = mergeContextLimits([
    topFrame.data.contextLimits,
    ...includedChildFrames.map((f) => f.data.contextLimits),
    { details: limits },
  ]);

  const textContent = parts.join('\n\n---\n\n');
  const wordCount = textContent.split(/\s+/).filter(Boolean).length;
  const comments = [
    ...(Array.isArray(topFrame.data.comments) ? topFrame.data.comments : []),
    ...includedChildFrames.flatMap((f) => Array.isArray(f.data.comments) ? f.data.comments : []),
  ].slice(0, 120);

  return {
    title: topFrame.data.title || tab.title || '',
    // Keep chat persistence key stable per browser tab URL, not iframe URL.
    url: tab.url || topFrame.data.url || '',
    description: topFrame.data.description || '',
    textContent,
    wordCount,
    sourceAnchors: topFrame.data.sourceAnchors || {},
    comments,
    technicalContext: topFrame.data.technicalContext || null,
    contextLimits,
  };
}

// Port-based streaming communication
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-chat') return;

  let abortController = null;
  let requestMessages = [];
  let requestPageContext = null;
  let requestChatOptions = {};
  let streamedText = '';
  let streamedThinking = '';
  let heartbeatTimer = null;
  let heartbeatStatus = 'Preparing request...';
  let heartbeatStartedAt = 0;

  const postToPort = (payload) => {
    try {
      port.postMessage(payload);
      return true;
    } catch {
      return false;
    }
  };

  const sendHeartbeat = () => {
    if (!heartbeatStartedAt) return;
    const ok = postToPort({
      type: 'heartbeat',
      message: heartbeatStatus,
      elapsedMs: Date.now() - heartbeatStartedAt,
    });
    if (!ok) abortController?.abort();
  };

  const startHeartbeat = () => {
    clearHeartbeat();
    heartbeatStartedAt = Date.now();
    heartbeatTimer = setInterval(sendHeartbeat, PORT_KEEPALIVE_INTERVAL_MS);
    sendHeartbeat();
  };

  const clearHeartbeat = () => {
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    heartbeatStartedAt = 0;
  };

  const updateHeartbeatStatus = (message) => {
    heartbeatStatus = message || 'Still working...';
    sendHeartbeat();
  };

  port.onMessage.addListener(async (message) => {
    if (message.type === 'abort') {
      abortController?.abort();
      return;
    }

    if (message.type === 'chat') {
      abortController = new AbortController();
      const { messages, pageContext, chatOptions } = message;
      requestMessages = Array.isArray(messages) ? messages : [];
      requestPageContext = pageContext || null;
      requestChatOptions = chatOptions && typeof chatOptions === 'object' ? chatOptions : {};
      streamedText = '';
      streamedThinking = '';
      heartbeatStatus = 'Preparing request...';
      startHeartbeat();
      let settings = null;

      try {
        settings = await loadSettings();
        const provider = createProvider(settings);

        const validation = provider.validate();
        if (!validation.valid) {
          const err = new ProviderError(validation.error, {
            code: 'invalid_settings',
            details: { provider: settings.activeProvider },
          });
          postToPort({
            type: 'error',
            error: validation.error,
            userMessage: validation.error,
            technicalDetails: buildTechnicalErrorDetails(err, settings, streamedText),
            retryable: false,
            status: null,
            code: err.code,
            partial: false,
          });
          return;
        }

        let useToolMode = false;
        const shouldTool = shouldUseToolMode(settings.activeProvider, provider, pageContext);
        if (shouldTool) {
          updateHeartbeatStatus('Checking LM Studio tool support...');
          useToolMode = await provider.supportsTools();
        }

        const toolModeMessages = buildChatMessages(messages, pageContext, settings, { useToolMode: true });
        const fullContextMessages = buildChatMessages(messages, pageContext, settings, { useToolMode: false });
        const chatMessages = useToolMode ? toolModeMessages : fullContextMessages;
        const contextMode = useToolMode ? 'tools' : 'full_context';
        postToPort({ type: 'context_mode', mode: contextMode });

        postToPort({ type: 'stream_start' });
        updateHeartbeatStatus(useToolMode ? 'Waiting for LM Studio tool response...' : 'Waiting for model response...');

        const buildSendOptions = (toolMode) => ({
          signal: abortController.signal,
          pageContext,
          useToolMode: toolMode,
          onThinkingToken: (token) => {
            streamedThinking += token;
            heartbeatStatus = 'Model is thinking...';
            if (!postToPort({ type: 'stream_thinking', token })) abortController?.abort();
          },
          onToken: (token) => {
            streamedText += token;
            heartbeatStatus = 'Receiving answer...';
            if (!postToPort({ type: 'stream_token', token })) abortController?.abort();
          },
        });

        const sendProviderMessage = (outgoingMessages, toolMode) => (
          provider.sendMessage(outgoingMessages, buildSendOptions(toolMode))
        );

        try {
          await sendProviderMessage(chatMessages, useToolMode);
        } catch (err) {
          if (shouldRetryLMStudioWithoutTools(err, settings.activeProvider, useToolMode, streamedText)) {
            streamedText = '';
            streamedThinking = '';
            postToPort({ type: 'context_mode', mode: 'full_context' });
            updateHeartbeatStatus('Tool mode did not return text. Retrying with full page context...');

            await sendProviderMessage(fullContextMessages, false);
          } else if (shouldContinueIncompleteResponse(err, streamedText)) {
            try {
              updateHeartbeatStatus('The answer hit an output limit. Asking the model to continue...');
              const continuationMessages = buildContinuationMessages(chatMessages, streamedText);
              await sendProviderMessage(continuationMessages, false);
            } catch (continueErr) {
              continueErr.details = {
                previousError: {
                  message: err?.message || '',
                  code: err?.code || null,
                  details: err?.details || null,
                },
                continuationError: {
                  message: continueErr?.message || '',
                  code: continueErr?.code || null,
                  details: continueErr?.details || null,
                },
              };
              throw continueErr;
            }
          } else {
            throw err;
          }
        }

        if (!String(streamedText || '').trim()) {
          throw new ProviderError('The provider returned an empty response.', {
            retryable: true,
            code: 'empty_response',
            details: {
              provider: settings.activeProvider,
              contextMode,
            },
          });
        }

        if (streamedText) {
          const pageKey = normalizePageUrl(requestPageContext?.url);
          const assistantMessage = { role: 'assistant', content: streamedText };
          if (streamedThinking) assistantMessage.thinking = streamedThinking;
          const fullMessages = [...requestMessages, assistantMessage];
          await persistChatForPage(pageKey, fullMessages, requestPageContext, requestChatOptions);
        }

        postToPort({ type: 'stream_end' });
      } catch (err) {
        if (err.name === 'AbortError') {
          postToPort({ type: 'stream_end', aborted: true });
          return;
        }
        postToPort({
          type: 'error',
          error: err.message || 'An unexpected error occurred',
          userMessage: getFriendlyErrorMessage(err, streamedText),
          technicalDetails: buildTechnicalErrorDetails(err, settings, streamedText),
          retryable: err.retryable || false,
          status: err.status || null,
          code: err.code || null,
          partial: !!String(streamedText || '').trim(),
        });
      } finally {
        clearHeartbeat();
        abortController = null;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    clearHeartbeat();
    abortController?.abort();
  });
});

// One-shot message handling
browser.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'getDistilledContent') {
    try {
      return await getDistilledContentForTab(message.tabId, {
        includeTechnicalContext: !!message?.options?.includeTechnicalContext,
      });
    } catch (err) {
      return {
        title: '',
        url: '',
        textContent: '',
        wordCount: 0,
        error: 'Could not access page content. The page may not be fully loaded.',
      };
    }
  }

  if (message.type === 'getSettings') {
    return loadSettings();
  }

  if (message.type === 'scrollToSource') {
    try {
      const tabId = message.tabId;
      if (tabId == null) return { ok: false, error: 'No tab specified' };
      return await browser.tabs.sendMessage(
        tabId,
        {
          type: 'scrollToSource',
          selector: message.selector,
          snippet: message.snippet || '',
          occurrence: Number(message.occurrence) || 1,
        },
        { frameId: 0 }
      );
    } catch (err) {
      return { ok: false, error: err?.message || 'Scroll message failed' };
    }
  }

  if (message.type === 'seekYouTubeVideo') {
    const tabId = message.tabId;
    if (tabId == null) return { ok: false, error: 'No tab specified' };
    const payload = {
      type: 'seekYouTubeVideo',
      seconds: message.seconds,
      url: message.url || '',
    };
    try {
      const response = await browser.tabs.sendMessage(tabId, payload, { frameId: 0 });
      if (response?.ok) return response;
    } catch {}
    try {
      return await browser.tabs.sendMessage(tabId, payload);
    } catch (err) {
      return { ok: false, error: err?.message || 'Seek message failed' };
    }
  }

  // Proxy fetch for content scripts (background has host_permissions)
  if (message.type === 'fetchText') {
    try {
      const resp = await fetchWithTimeout(
        message.url,
        { credentials: 'include' },
        Math.max(1000, Number(message.timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS)
      );
      if (!resp.ok) return { text: '', status: resp.status };
      return { text: await resp.text(), status: resp.status };
    } catch (err) {
      return { text: '', error: err.message };
    }
  }

  if (message.type === 'fetchPageResources') {
    return fetchPageResources(message);
  }

  // Fetch YouTube transcript via innertube get_transcript endpoint
  if (message.type === 'fetchYouTubeTranscript') {
    try {
      const { videoId, clientVersion, clientName, apiKey, visitorData, transcriptParams, watchUrl } = message;
      if (!videoId) return { error: 'Missing videoId' };

      let params;
      if (typeof transcriptParams === 'string' && transcriptParams.trim()) {
        params = transcriptParams.trim();
      } else {
        // Legacy fallback params: { field1: { field2: videoId } }
        const idBytes = new TextEncoder().encode(videoId);
        const inner = new Uint8Array([0x12, idBytes.length, ...idBytes]);
        const outer = new Uint8Array([0x0a, inner.length, ...inner]);
        params = btoa(String.fromCharCode(...outer))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      }

      const ytClientVersion = clientVersion || '2.20250101.00.00';
      const ytClientName = typeof clientName === 'string' && clientName ? clientName : 'WEB';
      const endpoint = apiKey
        ? `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}`
        : 'https://www.youtube.com/youtubei/v1/get_transcript';

      const resp = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          credentials: 'include',
          referrer: watchUrl || `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
          referrerPolicy: 'origin-when-cross-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Version': ytClientVersion,
            // WEB maps to client id 1 in request headers.
            'X-YouTube-Client-Name': ytClientName === 'WEB' ? '1' : ytClientName,
            ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: ytClientName,
                clientVersion: ytClientVersion,
                hl: 'en',
                ...(visitorData ? { visitorData } : {}),
                ...(watchUrl ? { originalUrl: watchUrl } : {}),
              },
            },
            params,
          }),
        },
        Math.max(1000, Number(message.timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS)
      );
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      const data = await resp.json();
      return { data };
    } catch (err) {
      return { error: err.message };
    }
  }
});
