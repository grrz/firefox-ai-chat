import { OpenAIProvider } from './openai.js';
import { ProviderError } from './base.js';

const QWEN_NO_THINK_PREFIX = '/no_think';
const QWEN_THINKING_BUDGET_TOKENS = 512;
const QWEN_STREAM_MAX_TOKENS = 4096;
const QWEN_TOOL_MAX_TOKENS = 2048;
const TOOL_PROBE_TIMEOUT_MS = 30000;
const TOOL_STEP_TIMEOUT_MS = 120000;

export class LMStudioProvider extends OpenAIProvider {
  static toolSupportCache = new Map();

  getToolSupportCacheKey() {
    return `${this.getEndpoint()}::${this.getModel()}`;
  }

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

  isQwenModel() {
    return /qwen/i.test(this.getModel() || '');
  }

  isThinkingOnlyModel() {
    return /(qwq|thinking)/i.test(this.getModel() || '');
  }

  withQwenNoThink(messages) {
    if (!this.isQwenModel() || !Array.isArray(messages)) return messages;

    const prepared = messages.map((message) => ({ ...message }));
    const lastUserIndex = prepared.map((m) => m.role).lastIndexOf('user');
    if (lastUserIndex === -1) return prepared;

    const content = String(prepared[lastUserIndex].content || '');
    if (/^\s*\/(?:no_?think|think)\b/i.test(content)) return prepared;

    prepared[lastUserIndex] = {
      ...prepared[lastUserIndex],
      content: `${QWEN_NO_THINK_PREFIX}\n${content}`,
    };
    return prepared;
  }

  applyQwenRequestControls(body, { maxTokens = QWEN_STREAM_MAX_TOKENS } = {}) {
    if (!this.isQwenModel()) return body;

    const controlled = {
      ...body,
      messages: this.withQwenNoThink(body.messages),
      max_tokens: body.max_tokens || maxTokens,
      temperature: body.temperature ?? 0.3,
    };

    if (this.isThinkingOnlyModel()) {
      controlled.thinking_budget = QWEN_THINKING_BUDGET_TOKENS;
    } else {
      controlled.enable_thinking = false;
    }

    return controlled;
  }

  buildBody(messages) {
    return this.applyQwenRequestControls(super.buildBody(messages), {
      maxTokens: QWEN_STREAM_MAX_TOKENS,
    });
  }

  buildToolRequestBody(messages, tools, extra = {}) {
    return this.applyQwenRequestControls({
      model: this.getModel(),
      stream: false,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: QWEN_TOOL_MAX_TOKENS,
      ...extra,
    }, {
      maxTokens: QWEN_TOOL_MAX_TOKENS,
    });
  }

  async fetchWithTimeout(url, options, timeoutMs, { code, message } = {}) {
    const externalSignal = options?.signal;
    if (externalSignal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromExternal = () => controller.abort();
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } catch (err) {
      if (externalSignal?.aborted) throw err;
      if (timedOut) {
        throw new ProviderError(message || 'LM Studio request timed out.', {
          retryable: true,
          code: code || 'timeout',
          details: {
            timeoutMs,
            model: this.getModel(),
          },
        });
      }
      if (err.name === 'AbortError') throw err;
      throw new ProviderError(`Network error: ${err.message}`, { retryable: true });
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  }

  async supportsTools() {
    const cacheKey = this.getToolSupportCacheKey();
    if (LMStudioProvider.toolSupportCache.has(cacheKey)) {
      return LMStudioProvider.toolSupportCache.get(cacheKey);
    }
    const body = this.buildToolRequestBody([
      { role: 'system', content: 'You are a test assistant. Always call the ping tool when available.' },
      { role: 'user', content: 'Call ping now.' },
    ], [
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
    ], {
      model: this.getModel(),
      stream: false,
      tool_choice: 'required',
      temperature: 0,
      max_tokens: 256,
    });

    try {
      console.log('[tools-debug] probing tool support:', cacheKey);
      const resp = await this.fetchWithTimeout(this.getEndpoint(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      }, TOOL_PROBE_TIMEOUT_MS, {
        code: 'tool_probe_timeout',
        message: 'LM Studio tool support probe timed out.',
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.warn('[tools-debug] probe failed:', resp.status, errText.slice(0, 300));
        LMStudioProvider.toolSupportCache.set(cacheKey, false);
        return false;
      }
      console.log('[tools-debug] probe OK — tools supported');
      LMStudioProvider.toolSupportCache.set(cacheKey, true);
      return true;
    } catch (err) {
      console.warn('[tools-debug] probe exception:', err);
      LMStudioProvider.toolSupportCache.set(cacheKey, false);
      return false;
    }
  }

  markToolsUnsupported() {
    LMStudioProvider.toolSupportCache.set(this.getToolSupportCacheKey(), false);
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
      {
        type: 'function',
        function: {
          name: 'search_resources',
          description: 'Search fetched external page resources such as JS, CSS, JSON, HTML, and manifests.',
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
          name: 'get_resource_chunk',
          description: 'Fetch a contiguous text chunk from a fetched external page resource by id or URL.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Resource id such as r3.' },
              url: { type: 'string', description: 'Resource URL, used when id is unknown.' },
              offset: { type: 'integer', minimum: 0 },
              length: { type: 'integer', minimum: 200, maximum: 12000 },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'list_js_symbols',
          description: 'List indexed JavaScript symbols from fetched page resources. Use this before requesting a specific function, class, method, or constant body.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Optional search over symbol name, signature, URL, and kind.' },
              kind: { type: 'string', description: 'Optional kind filter: function, class, method, const, let, or var.' },
              resource_id: { type: 'string', description: 'Optional resource id such as r3.' },
              exported_only: { type: 'boolean' },
              offset: { type: 'integer', minimum: 0 },
              count: { type: 'integer', minimum: 1, maximum: 100 },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_js_symbol',
          description: 'Return the source slice for a specific JavaScript symbol: a full function, class, method, or variable declaration when available.',
          parameters: {
            type: 'object',
            properties: {
              symbol_id: { type: 'string', description: 'Exact symbol id from list_js_symbols, for example r2:sym17.' },
              name: { type: 'string', description: 'Symbol name if symbol_id is unknown.' },
              resource_id: { type: 'string', description: 'Resource id such as r3, recommended when searching by name.' },
              kind: { type: 'string', description: 'Optional kind filter.' },
              max_chars: { type: 'integer', minimum: 1000, maximum: 120000 },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_comments',
          description: 'Search extracted user comments/discussion and return matching comment excerpts.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              max_results: { type: 'integer', minimum: 1, maximum: 20 },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_comments',
          description: 'Fetch extracted user comments/discussion items, optionally ordered by page order.',
          parameters: {
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0 },
              count: { type: 'integer', minimum: 1, maximum: 60 },
            },
          },
        },
      },
    ];
  }

  getPageText(pageContext) {
    return String(pageContext?.textContent || '');
  }

  getPageComments(pageContext) {
    if (!Array.isArray(pageContext?.comments)) return [];
    return pageContext.comments
      .map((comment, index) => {
        if (typeof comment === 'string') {
          return { id: `c${index + 1}`, text: comment };
        }
        return {
          id: comment?.id || `c${index + 1}`,
          author: comment?.author || '',
          time: comment?.time || '',
          score: comment?.score || '',
          text: String(comment?.text || ''),
        };
      })
      .filter((comment) => comment.text.trim());
  }

  getPageResources(pageContext) {
    const resources = pageContext?.technicalContext?.resources;
    const inventory = Array.isArray(resources?.inventory) ? resources.inventory : [];
    const fetched = Array.isArray(resources?.fetched) ? resources.fetched : [];
    const byUrl = new Map();
    const byId = new Map();

    for (const resource of inventory) {
      const item = {
        id: String(resource?.id || ''),
        url: String(resource?.url || ''),
        kind: String(resource?.kind || 'resource'),
        sources: Array.isArray(resource?.sources) ? resource.sources : [],
        contentType: String(resource?.contentType || resource?.type || ''),
        text: '',
        truncated: false,
        jsSymbols: [],
        jsSymbolCount: 0,
        jsSymbolsTruncated: false,
      };
      if (item.url) byUrl.set(item.url, item);
      if (item.id) byId.set(item.id, item);
    }

    for (const resource of fetched) {
      const url = String(resource?.url || '');
      const id = String(resource?.id || '');
      const item = (url && byUrl.get(url)) || (id && byId.get(id)) || {
        id,
        url,
        kind: String(resource?.kind || 'resource'),
        sources: Array.isArray(resource?.sources) ? resource.sources : [],
        contentType: '',
        text: '',
        truncated: false,
      };
      item.id = item.id || id;
      item.url = item.url || url;
      item.kind = String(resource?.kind || item.kind || 'resource');
      item.contentType = String(resource?.contentType || item.contentType || '');
      item.text = String(resource?.text || '');
      item.truncated = !!resource?.truncated;
      item.jsSymbols = Array.isArray(resource?.jsSymbols) ? resource.jsSymbols : (item.jsSymbols || []);
      item.jsSymbolCount = Number(resource?.jsSymbolCount) || item.jsSymbols.length || 0;
      item.jsSymbolsTruncated = !!resource?.jsSymbolsTruncated;
      if (item.url) byUrl.set(item.url, item);
      if (item.id) byId.set(item.id, item);
    }

    return Array.from(byUrl.values()).filter((resource) => resource.url);
  }

  getJsSymbols(pageContext) {
    return this.getPageResources(pageContext).flatMap((resource) => {
      const symbols = Array.isArray(resource.jsSymbols) ? resource.jsSymbols : [];
      return symbols.map((symbol) => ({
        ...symbol,
        resourceId: symbol.resourceId || resource.id,
        resourceUrl: symbol.resourceUrl || resource.url,
      }));
    });
  }

  findJsSymbol(args, pageContext) {
    const symbols = this.getJsSymbols(pageContext);
    const symbolId = String(args?.symbol_id || '').trim();
    const name = String(args?.name || '').trim();
    const resourceId = String(args?.resource_id || '').trim();
    const kind = String(args?.kind || '').trim().toLowerCase();

    if (symbolId) {
      const exact = symbols.find((symbol) => symbol.id === symbolId);
      return exact ? { symbol: exact, candidates: [] } : { symbol: null, candidates: [] };
    }

    const candidates = symbols.filter((symbol) => {
      if (resourceId && symbol.resourceId !== resourceId) return false;
      if (kind && String(symbol.kind || '').toLowerCase() !== kind) return false;
      if (!name) return true;
      return String(symbol.name || '').toLowerCase() === name.toLowerCase();
    });
    return {
      symbol: candidates.length === 1 ? candidates[0] : null,
      candidates,
    };
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
    if (name === 'search_resources') {
      const query = String(args?.query || '').trim();
      const resources = this.getPageResources(pageContext);
      if (!query) return { query, total_resources: resources.length, matches: [] };
      const maxResults = Math.min(12, Math.max(1, Number(args?.max_results) || 6));
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [];
      for (const resource of resources) {
        if (matches.length >= maxResults) break;
        const haystack = [
          resource.id,
          resource.url,
          resource.kind,
          resource.contentType,
          ...(resource.sources || []),
          resource.text,
        ].join(' ').toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) continue;
        const lowerText = resource.text.toLowerCase();
        const firstTermIndex = terms
          .map((term) => lowerText.indexOf(term))
          .filter((idx) => idx >= 0)
          .sort((a, b) => a - b)[0];
        const offset = Math.max(0, Number(firstTermIndex) || 0);
        const excerptStart = Math.max(0, offset - 160);
        const excerpt = resource.text
          ? resource.text.slice(excerptStart, excerptStart + 900)
          : '';
        matches.push({
          id: resource.id,
          url: resource.url,
          kind: resource.kind,
          contentType: resource.contentType,
          truncated: resource.truncated,
          textLength: resource.text.length,
          offset,
          excerpt,
        });
      }
      return { query, total_resources: resources.length, matches };
    }
    if (name === 'get_resource_chunk') {
      const id = String(args?.id || '').trim();
      const url = String(args?.url || '').trim();
      const resources = this.getPageResources(pageContext);
      const resource = resources.find((item) => (
        (id && item.id === id) ||
        (url && item.url === url)
      ));
      if (!resource) {
        return {
          id,
          url,
          total_resources: resources.length,
          error: 'Resource not found or was not fetched as text.',
        };
      }
      const offset = Math.max(0, Number(args?.offset) || 0);
      const length = Math.min(12000, Math.max(200, Number(args?.length) || 4000));
      return {
        id: resource.id,
        url: resource.url,
        kind: resource.kind,
        contentType: resource.contentType,
        offset,
        length,
        total_length: resource.text.length,
        truncated: resource.truncated,
        chunk: resource.text.slice(offset, offset + length),
      };
    }
    if (name === 'list_js_symbols') {
      const query = String(args?.query || '').trim().toLowerCase();
      const kind = String(args?.kind || '').trim().toLowerCase();
      const resourceId = String(args?.resource_id || '').trim();
      const exportedOnly = !!args?.exported_only;
      const offset = Math.max(0, Number(args?.offset) || 0);
      const count = Math.min(100, Math.max(1, Number(args?.count) || 40));
      const symbols = this.getJsSymbols(pageContext).filter((symbol) => {
        if (resourceId && symbol.resourceId !== resourceId) return false;
        if (kind && String(symbol.kind || '').toLowerCase() !== kind) return false;
        if (exportedOnly && !symbol.exported) return false;
        if (!query) return true;
        const haystack = [
          symbol.id,
          symbol.name,
          symbol.kind,
          symbol.declarationKind,
          symbol.signature,
          symbol.resourceId,
          symbol.resourceUrl,
        ].join(' ').toLowerCase();
        return haystack.includes(query);
      });
      return {
        query,
        kind: kind || '',
        resource_id: resourceId || '',
        exported_only: exportedOnly,
        offset,
        count,
        total_symbols: symbols.length,
        symbols: symbols.slice(offset, offset + count).map((symbol) => ({
          id: symbol.id,
          name: symbol.name,
          kind: symbol.kind,
          exported: !!symbol.exported,
          declarationKind: symbol.declarationKind || '',
          resourceId: symbol.resourceId,
          resourceUrl: symbol.resourceUrl,
          lineStart: symbol.lineStart,
          lineEnd: symbol.lineEnd,
          signature: symbol.signature,
        })),
      };
    }
    if (name === 'get_js_symbol') {
      const resources = this.getPageResources(pageContext);
      const { symbol, candidates } = this.findJsSymbol(args, pageContext);
      if (!symbol) {
        return {
          error: candidates.length > 1
            ? 'Multiple matching symbols; call again with symbol_id.'
            : 'Symbol not found.',
          candidates: candidates.slice(0, 20).map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            kind: candidate.kind,
            resourceId: candidate.resourceId,
            lineStart: candidate.lineStart,
            lineEnd: candidate.lineEnd,
            signature: candidate.signature,
          })),
        };
      }
      const resource = resources.find((item) => item.id === symbol.resourceId || item.url === symbol.resourceUrl);
      if (!resource?.text) {
        return {
          id: symbol.id,
          error: 'Symbol resource text is not available.',
        };
      }
      const start = Math.max(0, Number(symbol.start) || 0);
      const end = Math.min(resource.text.length, Math.max(start, Number(symbol.end) || start));
      const maxChars = Math.min(120000, Math.max(1000, Number(args?.max_chars) || 60000));
      const source = resource.text.slice(start, Math.min(end, start + maxChars));
      return {
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        exported: !!symbol.exported,
        declarationKind: symbol.declarationKind || '',
        resourceId: symbol.resourceId,
        resourceUrl: symbol.resourceUrl,
        lineStart: symbol.lineStart,
        lineEnd: symbol.lineEnd,
        start,
        end,
        total_chars: end - start,
        returned_chars: source.length,
        truncated: source.length < (end - start),
        source,
      };
    }
    if (name === 'search_comments') {
      const query = String(args?.query || '').trim();
      const comments = this.getPageComments(pageContext);
      if (!query) return { query, total_comments: comments.length, matches: [] };
      const maxResults = Math.min(20, Math.max(1, Number(args?.max_results) || 8));
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [];
      for (const comment of comments) {
        if (matches.length >= maxResults) break;
        const haystack = [
          comment.id,
          comment.author,
          comment.time,
          comment.score,
          comment.text,
        ].join(' ').toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) continue;
        matches.push({
          id: comment.id,
          author: comment.author,
          time: comment.time,
          score: comment.score,
          excerpt: comment.text.slice(0, 700),
        });
      }
      return { query, total_comments: comments.length, matches };
    }
    if (name === 'get_comments') {
      const comments = this.getPageComments(pageContext);
      const offset = Math.max(0, Number(args?.offset) || 0);
      const count = Math.min(60, Math.max(1, Number(args?.count) || 20));
      return {
        offset,
        count,
        total_comments: comments.length,
        comments: comments.slice(offset, offset + count).map((comment) => ({
          ...comment,
          text: comment.text.slice(0, 1200),
        })),
      };
    }
    return { error: `Unknown tool: ${name}` };
  }

  async sendMessage(messages, { signal, onToken, onThinkingToken, pageContext, useToolMode } = {}) {
    if (!useToolMode || !pageContext?.textContent) {
      console.log('[tools-debug] sendMessage: skipping tools (useToolMode=%s, hasText=%s)', useToolMode, !!pageContext?.textContent);
      return super.sendMessage(messages, { signal, onToken, onThinkingToken });
    }

    const supportsTools = await this.supportsTools();
    if (!supportsTools) {
      console.log('[tools-debug] sendMessage: supportsTools=false, using streaming fallback');
      return super.sendMessage(messages, { signal, onToken, onThinkingToken });
    }

    console.log('[tools-debug] sendMessage: entering tool loop');
    const toolMessages = [...messages];
    // Merge tool instructions into the first system message instead of adding
    // a second system message — many jinja templates break on multiple system messages.
    const toolInstruction = [
      'Use tools for page inspection instead of asking for full context dump.',
      'For questions about comments, discussion, replies, audience reaction, or commenter opinions, use search_comments or get_comments first.',
      'For questions about external JavaScript, CSS, manifests, API payloads, or page resource implementation details, use search_resources or get_resource_chunk first.',
      'For questions about a JavaScript function, class, method, or constant, use list_js_symbols first, then get_js_symbol for the exact source slice.',
      'Do not spend time on long internal planning.',
      'If details are missing, call one useful tool immediately; after tool results, answer the user directly.',
    ].join(' ');
    const sysIdx = toolMessages.findIndex((m) => m.role === 'system');
    if (sysIdx !== -1) {
      toolMessages[sysIdx] = {
        ...toolMessages[sysIdx],
        content: `${toolMessages[sysIdx].content}\n\n${toolInstruction}`,
      };
    } else {
      toolMessages.unshift({
        role: 'system',
        content: toolInstruction,
      });
    }
    const tools = this.buildToolSpec();

    for (let step = 0; step < 6; step++) {
      const body = this.buildToolRequestBody(toolMessages, tools);
      console.log('[tools-debug] tool step %d: sending request', step);
      let response;
      try {
        response = await this.fetchWithTimeout(this.getEndpoint(), {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal,
        }, TOOL_STEP_TIMEOUT_MS, {
          code: 'tool_timeout',
          message: 'LM Studio spent too long thinking about tool use.',
        });
      } catch (err) {
        if (err?.code === 'tool_timeout') this.markToolsUnsupported();
        throw err;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.warn('[tools-debug] tool step %d: API error %d: %s', step, response.status, text.slice(0, 300));
        if (response.status === 400 && /No user query found in messages|jinja template/i.test(text)) {
          this.markToolsUnsupported();
        }
        throw new ProviderError(`LM Studio API error (${response.status}): ${text}`, { status: response.status });
      }

      const rawText = await response.text().catch(() => '');
      let parsed = {};
      try {
        parsed = rawText ? JSON.parse(rawText) : {};
      } catch {
        throw new ProviderError('LM Studio returned invalid JSON.', {
          retryable: true,
          code: 'invalid_response',
          details: rawText.slice(0, 2000),
        });
      }
      const msg = parsed?.choices?.[0]?.message || {};
      const finishReason = parsed?.choices?.[0]?.finish_reason || null;
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      console.log('[tools-debug] tool step %d: toolCalls=%d, hasContent=%s', step, toolCalls.length, !!msg.content);
      if (toolCalls.length === 0) {
        const finalText = String(msg?.content || msg?.reasoning_content || msg?.reasoning || '');
        if (finalText) onToken?.(finalText);
        if (finishReason === 'length') {
          throw new ProviderError('LM Studio stopped because the model reached its output limit.', {
            retryable: true,
            code: 'incomplete_response',
            details: {
              finishReason,
              receivedCharacters: finalText.length,
            },
            partialText: finalText,
          });
        }
        if (finishReason === 'content_filter') {
          throw new ProviderError('LM Studio blocked the response with a content filter.', {
            code: 'content_filter',
            details: { finishReason },
          });
        }
        if (!finalText) {
          throw new ProviderError('LM Studio returned an empty response.', {
            retryable: true,
            code: 'empty_response',
            details: {
              finishReason,
              responseId: parsed?.id || null,
              model: parsed?.model || this.getModel(),
            },
          });
        }
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
