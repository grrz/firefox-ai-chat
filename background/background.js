import {getProviderConfig, loadSettings} from '../shared/settings.js';
import {SYSTEM_PROMPT} from '../shared/constants.js';
import {OpenAIProvider} from './providers/openai.js';
import {ClaudeProvider} from './providers/claude.js';
import {LMStudioProvider} from './providers/lmstudio.js';

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

function buildChatMessages(messages, pageContext) {
  const chatMessages = [];

  let systemContent = SYSTEM_PROMPT;
  if (pageContext?.textContent) {
    systemContent += `\n\n--- PAGE CONTEXT ---\n${pageContext.textContent}\n--- END PAGE CONTEXT ---`;
  }
  chatMessages.push({ role: 'system', content: systemContent });

  for (const msg of messages) {
    const m = { role: msg.role, content: msg.content };
    if (msg.thinking) m.thinking = msg.thinking;
    chatMessages.push(m);
  }

  return chatMessages;
}

// Port-based streaming communication
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-chat') return;

  let abortController = null;

  port.onMessage.addListener(async (message) => {
    if (message.type === 'abort') {
      abortController?.abort();
      return;
    }

    if (message.type === 'chat') {
      abortController = new AbortController();
      const { messages, pageContext } = message;

      try {
        const settings = await loadSettings();
        const provider = createProvider(settings);

        const validation = provider.validate();
        if (!validation.valid) {
          port.postMessage({ type: 'error', error: validation.error, retryable: false });
          return;
        }

        const chatMessages = buildChatMessages(messages, pageContext);

        port.postMessage({ type: 'stream_start' });

        await provider.sendMessage(chatMessages, {
          signal: abortController.signal,
          onThinkingToken: (token) => {
            try {
              port.postMessage({ type: 'stream_thinking', token });
            } catch {
              abortController?.abort();
            }
          },
          onToken: (token) => {
            try {
              port.postMessage({ type: 'stream_token', token });
            } catch {
              // Port disconnected
              abortController?.abort();
            }
          },
        });

        port.postMessage({ type: 'stream_end' });
      } catch (err) {
        if (err.name === 'AbortError') {
          try { port.postMessage({ type: 'stream_end', aborted: true }); } catch {}
          return;
        }
        try {
          port.postMessage({
            type: 'error',
            error: err.message || 'An unexpected error occurred',
            retryable: err.retryable || false,
          });
        } catch {}
      } finally {
        abortController = null;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    abortController?.abort();
  });
});

// One-shot message handling
browser.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'getDistilledContent') {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) return { error: 'No active tab' };

      return await browser.tabs.sendMessage(tabs[0].id, {type: 'distill'});
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

  // Proxy fetch for content scripts (background has host_permissions)
  if (message.type === 'fetchText') {
    try {
      const resp = await fetch(message.url, { credentials: 'include' });
      if (!resp.ok) return { text: '', status: resp.status };
      return { text: await resp.text(), status: resp.status };
    } catch (err) {
      return { text: '', error: err.message };
    }
  }

  // Fetch YouTube transcript via innertube get_transcript endpoint
  if (message.type === 'fetchYouTubeTranscript') {
    try {
      const { videoId, clientVersion, clientName, apiKey } = message;
      if (!videoId) return { error: 'Missing videoId' };

      // Build protobuf params: { field1: { field2: videoId } }
      const idBytes = new TextEncoder().encode(videoId);
      const inner = new Uint8Array([0x12, idBytes.length, ...idBytes]);
      const outer = new Uint8Array([0x0a, inner.length, ...inner]);
      const params = btoa(String.fromCharCode(...outer))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const ytClientVersion = clientVersion || '2.20250101.00.00';
      const ytClientName = typeof clientName === 'string' && clientName ? clientName : 'WEB';
      const endpoint = apiKey
        ? `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}`
        : 'https://www.youtube.com/youtubei/v1/get_transcript';

      const resp = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Version': ytClientVersion,
          // WEB maps to client id 1 in request headers.
          'X-YouTube-Client-Name': ytClientName === 'WEB' ? '1' : ytClientName,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: ytClientName,
              clientVersion: ytClientVersion,
              hl: 'en',
            },
          },
          params,
        }),
      });
      console.log('[bg fetchYouTubeTranscript] status:', resp.status);
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      const data = await resp.json();
      console.log('[bg fetchYouTubeTranscript] keys:', Object.keys(data));
      return { data };
    } catch (err) {
      console.log('[bg fetchYouTubeTranscript] error:', err.message);
      return { error: err.message };
    }
  }
});
