import { OpenAIProvider } from './openai.js';
import { ProviderError } from './base.js';

export class LMStudioProvider extends OpenAIProvider {
  static toolSupportCache = new Map();

  validate() {
    // No API key needed for local LM Studio
    return { valid: true };
  }

  buildHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer lm-studio',
    };
  }

  getEndpoint() {
    const base = (this.config.endpoint || 'http://localhost:1234').replace(/\/+$/, '');
    return `${base}/v1/chat/completions`;
  }

  async supportsTools() {
    const cacheKey = `${this.getEndpoint()}::${this.getModel()}`;
    if (LMStudioProvider.toolSupportCache.has(cacheKey)) {
      return LMStudioProvider.toolSupportCache.get(cacheKey);
    }
    const body = {
      model: this.getModel(),
      stream: false,
      messages: [
        { role: 'system', content: 'You are a test assistant. Always call the ping tool when available.' },
        { role: 'user', content: 'Call ping now.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'ping',
            description: 'Probe tool availability',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        },
      ],
      tool_choice: 'auto',
      temperature: 0,
    };

    try {
      const resp = await fetch(this.getEndpoint(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        LMStudioProvider.toolSupportCache.set(cacheKey, false);
        return false;
      }
      const parsed = await resp.json().catch(() => ({}));
      const msg = parsed?.choices?.[0]?.message;
      const supported = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
      LMStudioProvider.toolSupportCache.set(cacheKey, supported);
      return supported;
    } catch {
      LMStudioProvider.toolSupportCache.set(cacheKey, false);
      return false;
    }
  }

  buildToolSpec() {
    return [
      {
        type: 'function',
        function: {
          name: 'search_page',
          description: 'Search page context and return matching excerpts.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              max_results: { type: 'integer', minimum: 1, maximum: 12 },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_page_chunk',
          description: 'Fetch a contiguous text chunk by offset and length.',
          parameters: {
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0 },
              length: { type: 'integer', minimum: 200, maximum: 10000 },
            },
            required: ['offset'],
          },
        },
      },
    ];
  }

  getPageText(pageContext) {
    return String(pageContext?.textContent || '');
  }

  runToolCall(name, args, pageContext) {
    const text = this.getPageText(pageContext);
    if (name === 'search_page') {
      const query = String(args?.query || '').trim();
      if (!query) return { query, matches: [] };
      const maxResults = Math.min(12, Math.max(1, Number(args?.max_results) || 5));
      const lines = text.split('\n');
      const lowered = query.toLowerCase();
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        const line = lines[i];
        if (!line) continue;
        if (!line.toLowerCase().includes(lowered)) continue;
        const excerpt = line.slice(0, 350);
        matches.push({ line: i + 1, excerpt });
      }
      return { query, matches };
    }
    if (name === 'get_page_chunk') {
      const offset = Math.max(0, Number(args?.offset) || 0);
      const length = Math.min(10000, Math.max(200, Number(args?.length) || 3000));
      const chunk = text.slice(offset, offset + length);
      return {
        offset,
        length,
        total_length: text.length,
        chunk,
      };
    }
    return { error: `Unknown tool: ${name}` };
  }

  async sendMessage(messages, { signal, onToken, onThinkingToken, pageContext, useToolMode } = {}) {
    if (!useToolMode || !pageContext?.textContent) {
      return super.sendMessage(messages, { signal, onToken, onThinkingToken });
    }

    const supportsTools = await this.supportsTools();
    if (!supportsTools) {
      return super.sendMessage(messages, { signal, onToken, onThinkingToken });
    }

    const toolMessages = [...messages];
    toolMessages.unshift({
      role: 'system',
      content: 'Use tools for page inspection instead of asking for full context dump. Call tools when details are missing.',
    });
    const tools = this.buildToolSpec();

    for (let step = 0; step < 6; step++) {
      const body = {
        model: this.getModel(),
        stream: false,
        messages: toolMessages,
        tools,
        tool_choice: 'auto',
      };
      const response = await fetch(this.getEndpoint(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal,
      }).catch(err => {
        if (err.name === 'AbortError') throw err;
        throw new ProviderError(`Network error: ${err.message}`, { retryable: true });
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ProviderError(`LM Studio API error (${response.status}): ${text}`, { status: response.status });
      }

      const parsed = await response.json().catch(() => ({}));
      const msg = parsed?.choices?.[0]?.message || {};
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (toolCalls.length === 0) {
        const finalText = String(msg?.content || '');
        if (finalText) onToken?.(finalText);
        return finalText;
      }

      toolMessages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const name = call?.function?.name || '';
        let args = {};
        try { args = JSON.parse(call?.function?.arguments || '{}'); } catch {}
        const result = this.runToolCall(name, args, pageContext);
        toolMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: JSON.stringify(result),
        });
      }
    }

    // Fall back if model keeps looping tools without final content.
    return super.sendMessage(messages, { signal, onToken, onThinkingToken });
  }
}
