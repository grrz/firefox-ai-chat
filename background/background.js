import { loadSettings, getProviderConfig } from '../shared/settings.js';
import { SYSTEM_PROMPT } from '../shared/constants.js';
import { OpenAIProvider } from './providers/openai.js';
import { ClaudeProvider } from './providers/claude.js';
import { LMStudioProvider } from './providers/lmstudio.js';

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
browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.type === 'getDistilledContent') {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) return { error: 'No active tab' };

      const result = await browser.tabs.sendMessage(tabs[0].id, { type: 'distill' });
      return result;
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
});
