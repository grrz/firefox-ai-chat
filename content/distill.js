(function () {
  'use strict';

  const NOISE_SELECTORS = [
    // Ads
    '[class*="ad-"]', '[class*="ad_"]', '[id*="ad-"]', '[id*="ad_"]',
    '.adsbygoogle', '.ad-container', '.ad-wrapper', '.advertisement',
    'ins.adsbygoogle', '[data-ad]', '[data-ad-slot]',
    // Cookie banners
    '[class*="cookie"]', '[id*="cookie"]', '[class*="consent"]', '[id*="consent"]',
    '[class*="gdpr"]', '[id*="gdpr"]', '.cc-banner', '#onetrust-banner-sdk',
    // Social
    '[class*="social-share"]', '[class*="share-button"]', '[class*="sharing"]',
    '.social-links', '.share-bar', '.social-bar',
    // Nav/header/footer (be conservative — only clear patterns)
    'nav', 'header', 'footer', '[role="navigation"]', '[role="banner"]',
    '[role="contentinfo"]',
    // Hidden elements
    '[aria-hidden="true"]', '[hidden]', '.visually-hidden', '.sr-only',
    // Misc noise
    '.sidebar', 'aside', '[role="complementary"]',
    '.related-posts', '.recommended',
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
  ];

  const MAIN_CONTENT_SELECTORS = [
    'main', '[role="main"]', 'article', '.article',
    '.post-content', '.entry-content', '.article-content',
    '.page-content', '.content', '#content', '#main-content',
    '.story-body', '.article-body',
  ];

  function removeNoise(clone) {
    for (const sel of NOISE_SELECTORS) {
      try {
        const els = clone.querySelectorAll(sel);
        for (const el of els) {
          el.remove();
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }
    // Remove elements with display:none
    const all = clone.querySelectorAll('*');
    for (const el of all) {
      const style = el.getAttribute('style') || '';
      if (style.includes('display:none') || style.includes('display: none') ||
          style.includes('visibility:hidden') || style.includes('visibility: hidden')) {
        el.remove();
      }
    }
  }

  function findMainContent(clone) {
    for (const sel of MAIN_CONTENT_SELECTORS) {
      const el = clone.querySelector(sel);
      if (el && el.textContent.trim().length > 100) {
        return el;
      }
    }
    return clone;
  }

  function extractHeadings(root) {
    const headings = [];
    const els = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const el of els) {
      const text = el.textContent.trim();
      if (text.length > 0) {
        const level = parseInt(el.tagName[1], 10);
        headings.push({ level, text });
      }
    }
    return headings;
  }

  function extractParagraphs(root) {
    const paragraphs = [];
    const els = root.querySelectorAll('p, blockquote');
    for (const el of els) {
      const text = el.textContent.trim();
      if (text.length > 20) {
        paragraphs.push(text);
      }
    }
    return paragraphs;
  }

  function extractImages(root) {
    const images = [];
    const els = root.querySelectorAll('img[alt]');
    for (const el of els) {
      const alt = (el.getAttribute('alt') || '').trim();
      if (!alt) continue;
      const src = el.getAttribute('src') || '';
      // Look for figcaption
      let caption = '';
      const figure = el.closest('figure');
      if (figure) {
        const figcap = figure.querySelector('figcaption');
        if (figcap) caption = figcap.textContent.trim();
      }
      images.push({ src, alt, caption });
    }
    return images;
  }

  function extractLinks(root) {
    const contentLinks = [];
    const els = root.querySelectorAll('a[href]');
    for (const el of els) {
      const text = el.textContent.trim();
      const href = el.getAttribute('href') || '';
      if (!text || text.length < 2 || !href || href.startsWith('#') || href.startsWith('javascript:')) continue;

      // Skip nav-like links: if parent is a list with many links
      const parentList = el.closest('ul, ol');
      if (parentList) {
        const linkCount = parentList.querySelectorAll('a').length;
        if (linkCount > 10) continue; // likely navigation
      }

      contentLinks.push({ text, href });
    }
    // Deduplicate
    const seen = new Set();
    return contentLinks.filter(l => {
      const key = l.href;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function extractLists(root) {
    const lists = [];
    const els = root.querySelectorAll('ul, ol');
    for (const el of els) {
      // Skip nav lists
      if (el.closest('nav, header, footer, [role="navigation"]')) continue;
      const items = [];
      const lis = el.querySelectorAll(':scope > li');
      for (const li of lis) {
        const text = li.textContent.trim();
        if (text.length > 5) items.push(text);
      }
      if (items.length > 0) {
        lists.push({ type: el.tagName.toLowerCase(), items });
      }
    }
    return lists;
  }

  function extractTables(root) {
    const tables = [];
    const els = root.querySelectorAll('table');
    for (const el of els) {
      const rows = [];
      const trs = el.querySelectorAll('tr');
      for (const tr of trs) {
        const cells = [];
        const tds = tr.querySelectorAll('th, td');
        for (const td of tds) {
          cells.push(td.textContent.trim());
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length > 0) tables.push(rows);
    }
    return tables;
  }

  function extractCodeBlocks(root) {
    const blocks = [];
    const els = root.querySelectorAll('pre, code');
    for (const el of els) {
      // Skip inline code inside pre
      if (el.tagName === 'CODE' && el.closest('pre')) continue;
      const text = el.textContent.trim();
      if (text.length > 10) {
        blocks.push(text);
      }
    }
    return blocks;
  }

  function normalizeExtractedText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isElementVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return true;
    }
  }

  function getControlLabel(el) {
    const id = el.id && el.id.trim();
    if (id) {
      const escapedId = window.CSS?.escape ? window.CSS.escape(id) : id.replace(/[^a-zA-Z0-9\-_:.]/g, '\\$&');
      const label = document.querySelector(`label[for="${escapedId}"]`);
      const labelText = (label?.textContent || '').replace(/\s+/g, ' ').trim();
      if (labelText) return labelText;
    }
    const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (aria) return aria;
    const placeholder = (el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
    if (placeholder) return placeholder;
    const name = (el.getAttribute('name') || '').trim();
    if (name) return name;
    return el.tagName.toLowerCase();
  }

  function extractFormState(root) {
    const MAX_FIELDS = 120;
    const out = [];
    const controls = Array.from(root.querySelectorAll('input, select, textarea, button'));
    for (const el of controls) {
      if (out.length >= MAX_FIELDS) break;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && type === 'hidden') continue;

      const label = getControlLabel(el);
      let value = '';
      if (tag === 'button' || type === 'submit' || type === 'button') {
        value = (el.textContent || '').replace(/\s+/g, ' ').trim();
      } else if (type === 'checkbox' || type === 'radio') {
        value = el.checked ? 'checked' : 'not checked';
      } else if (tag === 'select') {
        const selected = Array.from(el.selectedOptions || [])
          .map((o) => (o.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 3);
        value = selected.join(', ');
      } else if (type === 'password') {
        value = '<hidden>';
      } else {
        value = String(el.value || '').replace(/\s+/g, ' ').trim();
      }

      const meta = [];
      if (tag === 'input' && type) meta.push(type);
      const role = (el.getAttribute('role') || '').trim();
      if (role) meta.push(`role=${role}`);
      const ariaExpanded = (el.getAttribute('aria-expanded') || '').trim();
      if (ariaExpanded) meta.push(`aria-expanded=${ariaExpanded}`);
      const ariaAutocomplete = (el.getAttribute('aria-autocomplete') || '').trim();
      if (ariaAutocomplete) meta.push(`aria-autocomplete=${ariaAutocomplete}`);
      if (el.required) meta.push('required');
      if (el.disabled) meta.push('disabled');
      const summary = `${label}: ${value || '(empty)'}${meta.length ? ` [${meta.join(', ')}]` : ''}`;
      out.push({
        summary: summary.slice(0, 240),
        selector: toSelector(el),
      });
    }
    return out;
  }

  function uniqueBy(items, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const key = keyFn(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  function limitArray(items, max, label, limits) {
    if (!Array.isArray(items)) return [];
    if (items.length <= max) return items;
    limits.push(`${label}: kept ${max} of ${items.length}`);
    return items.slice(0, max);
  }

  function summarizeDomTree(root) {
    const MAX_NODES = 120;
    const MAX_DEPTH = 4;
    const MAX_CHILDREN_PER_NODE = 10;
    const lines = [];
    const stack = [{ el: root, depth: 0 }];
    let visited = 0;

    while (stack.length > 0 && visited < MAX_NODES) {
      const { el, depth } = stack.pop();
      if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;

      const id = el.id ? `#${el.id}` : '';
      const classList = Array.from(el.classList || []).slice(0, 2);
      const classes = classList.length ? `.${classList.join('.')}` : '';
      const role = (el.getAttribute('role') || '').trim();
      const roleSuffix = role ? ` [role=${role}]` : '';
      const prefix = '  '.repeat(depth);
      lines.push(`${prefix}- ${tag}${id}${classes}${roleSuffix}`);
      visited += 1;

      if (depth >= MAX_DEPTH) continue;
      const children = Array.from(el.children || [])
        .filter((c) => c && c.nodeType === Node.ELEMENT_NODE)
        .slice(0, MAX_CHILDREN_PER_NODE);
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ el: children[i], depth: depth + 1 });
      }
    }

    return {
      lines,
      truncated: visited >= MAX_NODES,
    };
  }

  function summarizeStyles() {
    const styleTags = document.querySelectorAll('style').length;
    const stylesheetLinks = document.querySelectorAll('link[rel="stylesheet"]').length;
    const inlineStyleAttrs = document.querySelectorAll('[style]').length;
    const cssVariables = document.querySelectorAll('[style*="--"]').length;
    let stylesheetCount = 0;
    try {
      stylesheetCount = document.styleSheets?.length || 0;
    } catch {}

    const bodyStyle = window.getComputedStyle(document.body);
    return {
      stylesheetCount,
      styleTags,
      stylesheetLinks,
      inlineStyleAttrs,
      cssVariables,
      body: {
        fontFamily: bodyStyle.fontFamily,
        fontSize: bodyStyle.fontSize,
        color: bodyStyle.color,
        backgroundColor: bodyStyle.backgroundColor,
      },
    };
  }

  function summarizeScripts() {
    const scripts = Array.from(document.scripts || []);
    const external = [];
    let inlineCount = 0;
    for (const s of scripts) {
      const src = normalizeResourceUrl(s.getAttribute('src') || '');
      if (!src) {
        inlineCount += 1;
        continue;
      }
      external.push(src);
    }

    const libs = [];
    const srcJoined = external.join(' ').toLowerCase();
    const has = (name, fn) => {
      try { return !!fn(); } catch { return false; }
    };
    if (has('React', () => !!window.React || srcJoined.includes('react'))) libs.push('React');
    if (has('Vue', () => !!window.Vue || srcJoined.includes('vue'))) libs.push('Vue');
    if (has('Angular', () => !!window.ng || srcJoined.includes('angular'))) libs.push('Angular');
    if (has('Svelte', () => srcJoined.includes('svelte'))) libs.push('Svelte');
    if (has('jQuery', () => !!window.jQuery || srcJoined.includes('jquery'))) libs.push('jQuery');
    if (has('Next.js', () => !!window.__NEXT_DATA__ || srcJoined.includes('next'))) libs.push('Next.js');
    if (has('Nuxt', () => !!window.__NUXT__ || srcJoined.includes('nuxt'))) libs.push('Nuxt');
    if (has('Webpack', () => srcJoined.includes('webpack') || !!window.webpackChunk)) libs.push('Webpack');

    return {
      totalScripts: scripts.length,
      inlineCount,
      externalCount: external.length,
      externalExamples: external.slice(0, 15),
      detectedLibraries: libs,
    };
  }

  const RESOURCE_FETCH_LIMITS = {
    maxResources: 18,
    maxCharsPerResource: 70000,
    maxTotalChars: 320000,
    timeoutMs: 4500,
  };
  const MAX_RESOURCE_INVENTORY_ITEMS = 250;
  const MAX_JS_SYMBOLS_PER_RESOURCE = 600;
  const MAX_JS_SYMBOLS_IN_PROMPT = 120;

  function normalizeResourceUrl(rawUrl, baseUrl = location.href) {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    try {
      const url = new URL(value, baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.toString();
    } catch {
      return '';
    }
  }

  function splitSrcsetUrls(srcset) {
    return String(srcset || '')
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function getLinkResourceKind(linkEl) {
    const rel = String(linkEl.getAttribute('rel') || '').toLowerCase();
    const as = String(linkEl.getAttribute('as') || '').toLowerCase();
    const type = String(linkEl.getAttribute('type') || '').toLowerCase();
    if (rel.includes('stylesheet')) return 'stylesheet';
    if (rel.includes('modulepreload')) return 'script';
    if (as === 'script' || type.includes('javascript') || type.includes('ecmascript')) return 'script';
    if (as === 'style' || type === 'text/css') return 'stylesheet';
    if (rel.includes('manifest')) return 'manifest';
    if (rel.includes('icon') || as === 'image') return 'image';
    if (as === 'font') return 'font';
    if (as === 'fetch') return 'fetch';
    if (as === 'document') return 'document';
    if (rel.includes('preload') || rel.includes('prefetch')) return as || 'preload';
    return rel || as || 'link';
  }

  function mapPerformanceInitiatorType(type) {
    const value = String(type || '').toLowerCase();
    if (value === 'css') return 'stylesheet';
    if (value === 'img' || value === 'image') return 'image';
    if (value === 'xmlhttprequest') return 'xmlhttprequest';
    if (value === 'iframe') return 'document';
    return value || 'resource';
  }

  function looksLikeTextResourceUrl(rawUrl) {
    try {
      const pathname = new URL(rawUrl).pathname.toLowerCase();
      return /\.(?:cjs|css|csv|html?|js|json|jsx|mjs|map|md|svg|text|ts|tsx|txt|wasm\.map|xml)(?:$|[?#])/.test(pathname);
    } catch {
      return false;
    }
  }

  function isTextResourceCandidate(resource) {
    const kind = String(resource?.kind || '').toLowerCase();
    if (['script', 'stylesheet', 'manifest', 'fetch', 'xmlhttprequest', 'document', 'preload'].includes(kind)) return true;
    if (looksLikeTextResourceUrl(resource?.url || '')) return true;
    const type = String(resource?.type || '').toLowerCase();
    return type.startsWith('text/') ||
      type.includes('json') ||
      type.includes('javascript') ||
      type.includes('ecmascript') ||
      type.includes('xml') ||
      type.includes('svg');
  }

  function addResource(out, byUrl, rawUrl, meta = {}) {
    const url = normalizeResourceUrl(rawUrl);
    if (!url) return null;
    let resource = byUrl.get(url);
    if (!resource) {
      resource = {
        id: '',
        url,
        kind: meta.kind || 'resource',
        sources: [],
        rel: '',
        as: '',
        type: '',
        media: '',
        initiatorType: '',
        transferSize: null,
        decodedBodySize: null,
        durationMs: null,
      };
      byUrl.set(url, resource);
      out.push(resource);
    }

    if (meta.kind && resource.kind === 'resource') resource.kind = meta.kind;
    if (meta.source && !resource.sources.includes(meta.source)) resource.sources.push(meta.source);
    for (const key of ['rel', 'as', 'type', 'media', 'initiatorType']) {
      if (!resource[key] && meta[key]) resource[key] = String(meta[key]);
    }
    for (const key of ['transferSize', 'decodedBodySize', 'durationMs']) {
      if (resource[key] == null && Number.isFinite(meta[key])) resource[key] = meta[key];
    }
    resource.fetchCandidate = isTextResourceCandidate(resource);
    return resource;
  }

  function collectPageResourceInventory() {
    const resources = [];
    const byUrl = new Map();

    for (const el of Array.from(document.querySelectorAll('script[src]'))) {
      addResource(resources, byUrl, el.getAttribute('src'), {
        kind: 'script',
        source: 'script[src]',
        type: el.getAttribute('type') || '',
      });
    }

    for (const el of Array.from(document.querySelectorAll('link[href]'))) {
      addResource(resources, byUrl, el.getAttribute('href'), {
        kind: getLinkResourceKind(el),
        source: 'link[href]',
        rel: el.getAttribute('rel') || '',
        as: el.getAttribute('as') || '',
        type: el.getAttribute('type') || '',
        media: el.getAttribute('media') || '',
      });
    }

    for (const el of Array.from(document.querySelectorAll('img[src], source[src], video[src], audio[src], track[src], iframe[src], embed[src]'))) {
      addResource(resources, byUrl, el.getAttribute('src'), {
        kind: el.tagName.toLowerCase() === 'iframe' ? 'document' : el.tagName.toLowerCase(),
        source: `${el.tagName.toLowerCase()}[src]`,
        type: el.getAttribute('type') || '',
      });
    }

    for (const el of Array.from(document.querySelectorAll('img[srcset], source[srcset]'))) {
      for (const src of splitSrcsetUrls(el.getAttribute('srcset'))) {
        addResource(resources, byUrl, src, {
          kind: 'image',
          source: `${el.tagName.toLowerCase()}[srcset]`,
          type: el.getAttribute('type') || '',
        });
      }
    }

    for (const el of Array.from(document.querySelectorAll('video[poster]'))) {
      addResource(resources, byUrl, el.getAttribute('poster'), {
        kind: 'image',
        source: 'video[poster]',
      });
    }

    for (const el of Array.from(document.querySelectorAll('object[data]'))) {
      addResource(resources, byUrl, el.getAttribute('data'), {
        kind: 'object',
        source: 'object[data]',
        type: el.getAttribute('type') || '',
      });
    }

    try {
      for (const entry of performance.getEntriesByType('resource') || []) {
        addResource(resources, byUrl, entry.name, {
          kind: mapPerformanceInitiatorType(entry.initiatorType),
          source: `performance:${entry.initiatorType || 'resource'}`,
          initiatorType: entry.initiatorType || '',
          transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
          decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
          durationMs: Number.isFinite(entry.duration) ? Math.round(entry.duration) : null,
        });
      }
    } catch {}

    return resources.map((resource, index) => ({
      ...resource,
      id: `r${index + 1}`,
      sources: resource.sources.slice(0, 6),
      fetchCandidate: isTextResourceCandidate(resource),
    }));
  }

  async function fetchResourceSnapshots(resources) {
    const candidates = resources.filter((resource) => resource.fetchCandidate);
    if (candidates.length === 0) {
      return {
        fetched: [],
        limits: { applied: false, details: [] },
      };
    }

    try {
      const result = await browser.runtime.sendMessage({
        type: 'fetchPageResources',
        pageUrl: location.href,
        resources: candidates.slice(0, RESOURCE_FETCH_LIMITS.maxResources).map((resource) => ({
          id: resource.id,
          url: resource.url,
          kind: resource.kind,
          sources: resource.sources,
          rel: resource.rel,
          as: resource.as,
          type: resource.type,
        })),
        limits: RESOURCE_FETCH_LIMITS,
      });
      return result && typeof result === 'object'
        ? result
        : { fetched: [], limits: { applied: false, details: [] } };
    } catch (err) {
      return {
        fetched: [],
        limits: {
          applied: true,
          details: [`resource fetch failed: ${err?.message || 'unknown error'}`],
        },
      };
    }
  }

  function languageForResource(resource) {
    const url = String(resource?.url || '').toLowerCase();
    const type = String(resource?.contentType || resource?.type || '').toLowerCase();
    const kind = String(resource?.kind || '').toLowerCase();
    if (kind === 'stylesheet' || type.includes('css') || /\.css(?:$|[?#])/.test(url)) return 'css';
    if (type.includes('json') || /\.(?:json|map)(?:$|[?#])/.test(url)) return 'json';
    if (type.includes('html') || /\.html?(?:$|[?#])/.test(url)) return 'html';
    if (type.includes('xml') || /\.xml(?:$|[?#])/.test(url)) return 'xml';
    if (type.includes('svg') || /\.svg(?:$|[?#])/.test(url)) return 'svg';
    if (kind === 'script' || type.includes('javascript') || type.includes('ecmascript') || /\.(?:cjs|js|jsx|mjs|ts|tsx)(?:$|[?#])/.test(url)) return 'js';
    return 'text';
  }

  function isJavaScriptResource(resource) {
    return languageForResource(resource) === 'js';
  }

  function isIdentifierStart(ch) {
    return /[A-Za-z_$]/.test(ch || '');
  }

  function isIdentifierPart(ch) {
    return /[A-Za-z0-9_$]/.test(ch || '');
  }

  function getLineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
  }

  function lineColForOffset(lineStarts, offset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (lineStarts[mid] <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    const lineIndex = Math.max(0, hi);
    return {
      line: lineIndex + 1,
      column: Math.max(0, offset - lineStarts[lineIndex]) + 1,
    };
  }

  function readQuotedString(text, start) {
    const quote = text[start];
    let i = start + 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) return i + 1;
      i += 1;
    }
    return text.length;
  }

  function readTemplateString(text, start) {
    let i = start + 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') return i + 1;
      i += 1;
    }
    return text.length;
  }

  function tokenAllowsRegex(prev) {
    if (!prev) return true;
    if (prev.type === 'id') {
      return ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await'].includes(prev.value);
    }
    return ['(', '[', '{', ',', ';', ':', '=', '=>', '!', '?', '+', '-', '*', '/', '%', '&', '|', '^', '~'].includes(prev.value);
  }

  function readRegexLiteral(text, start) {
    let i = start + 1;
    let inClass = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        i += 1;
        while (/[A-Za-z]/.test(text[i] || '')) i += 1;
        return i;
      } else if (ch === '\n') {
        return start + 1;
      }
      i += 1;
    }
    return text.length;
  }

  function tokenizeJavaScript(text) {
    const tokens = [];
    const curlyStack = [];
    const parenStack = [];
    const bracketStack = [];
    const matching = new Map();
    let curlyDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let i = 0;

    function pushToken(token) {
      tokens.push({
        ...token,
        index: tokens.length,
        curlyDepth,
        parenDepth,
        bracketDepth,
      });
      const idx = tokens.length - 1;
      const value = token.value;
      if (value === '{') {
        curlyStack.push(idx);
        curlyDepth += 1;
      } else if (value === '}') {
        const open = curlyStack.pop();
        if (open != null) {
          matching.set(open, idx);
          matching.set(idx, open);
        }
      } else if (value === '(') {
        parenStack.push(idx);
        parenDepth += 1;
      } else if (value === ')') {
        const open = parenStack.pop();
        if (open != null) {
          matching.set(open, idx);
          matching.set(idx, open);
        }
      } else if (value === '[') {
        bracketStack.push(idx);
        bracketDepth += 1;
      } else if (value === ']') {
        const open = bracketStack.pop();
        if (open != null) {
          matching.set(open, idx);
          matching.set(idx, open);
        }
      }
    }

    while (i < text.length) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === '/' && text[i + 1] === '/') {
        i = text.indexOf('\n', i + 2);
        if (i === -1) break;
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = readQuotedString(text, i);
        continue;
      }
      if (ch === '`') {
        i = readTemplateString(text, i);
        continue;
      }
      if (ch === '/' && tokenAllowsRegex(tokens[tokens.length - 1])) {
        i = readRegexLiteral(text, i);
        continue;
      }
      if (isIdentifierStart(ch)) {
        const start = i;
        i += 1;
        while (isIdentifierPart(text[i])) i += 1;
        pushToken({ type: 'id', value: text.slice(start, i), start, end: i });
        continue;
      }
      if (ch === '=' && text[i + 1] === '>') {
        pushToken({ type: 'punct', value: '=>', start: i, end: i + 2 });
        i += 2;
        continue;
      }
      if (ch === '}' && curlyDepth > 0) curlyDepth -= 1;
      if (ch === ')' && parenDepth > 0) parenDepth -= 1;
      if (ch === ']' && bracketDepth > 0) bracketDepth -= 1;
      pushToken({ type: 'punct', value: ch, start: i, end: i + 1 });
      i += 1;
    }

    return { tokens, matching };
  }

  function previousSignificantToken(tokens, idx) {
    return idx > 0 ? tokens[idx - 1] : null;
  }

  function symbolStartWithPrefixes(tokens, idx) {
    let startIdx = idx;
    for (let i = idx - 1; i >= 0; i--) {
      const value = tokens[i]?.value;
      if (['export', 'default', 'async', 'static', 'get', 'set'].includes(value)) {
        startIdx = i;
        continue;
      }
      break;
    }
    return tokens[startIdx]?.start ?? tokens[idx].start;
  }

  function findNextToken(tokens, idx, value, maxDistance = 80) {
    const end = Math.min(tokens.length, idx + maxDistance);
    for (let i = idx + 1; i < end; i++) {
      if (tokens[i].value === value) return i;
    }
    return -1;
  }

  function normalizeSignature(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  }

  function addJsSymbol(symbols, seen, source, lineStarts, resource, rawSymbol) {
    if (!rawSymbol?.name || rawSymbol.start == null || rawSymbol.end == null) return;
    if (rawSymbol.end <= rawSymbol.start) return;
    const key = `${rawSymbol.kind}|${rawSymbol.name}|${rawSymbol.start}|${rawSymbol.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const startLoc = lineColForOffset(lineStarts, rawSymbol.start);
    const endLoc = lineColForOffset(lineStarts, Math.max(rawSymbol.start, rawSymbol.end - 1));
    const signatureEnd = Math.min(rawSymbol.end, rawSymbol.bodyStart || rawSymbol.start + 220);
    const symbol = {
      id: `${resource.id}:sym${symbols.length + 1}`,
      resourceId: resource.id,
      resourceUrl: resource.url,
      kind: rawSymbol.kind,
      name: rawSymbol.name,
      exported: !!rawSymbol.exported,
      declarationKind: rawSymbol.declarationKind || '',
      start: rawSymbol.start,
      end: rawSymbol.end,
      lineStart: startLoc.line,
      lineEnd: endLoc.line,
      columnStart: startLoc.column,
      columnEnd: endLoc.column,
      signature: normalizeSignature(source.slice(rawSymbol.start, signatureEnd)),
    };
    symbols.push(symbol);
  }

  function parseFunctionSymbol(tokens, matching, idx) {
    let cursor = idx + 1;
    if (tokens[cursor]?.value === '*') cursor += 1;
    const nameToken = tokens[cursor]?.type === 'id' ? tokens[cursor] : null;
    let name = nameToken?.value || '';
    if (!name) {
      const prev = previousSignificantToken(tokens, idx);
      if (prev?.type === 'id') name = prev.value;
    }
    if (!name) name = '(anonymous)';
    const parenIdx = findNextToken(tokens, idx, '(', 20);
    const bodyIdx = parenIdx === -1 ? findNextToken(tokens, idx, '{', 40) : findNextToken(tokens, parenIdx, '{', 80);
    const closeIdx = bodyIdx === -1 ? -1 : matching.get(bodyIdx);
    if (bodyIdx === -1 || closeIdx == null) return null;
    const start = symbolStartWithPrefixes(tokens, idx);
    const exported = tokens.slice(Math.max(0, idx - 3), idx).some((token) => token.value === 'export');
    return {
      kind: 'function',
      name,
      exported,
      start,
      bodyStart: tokens[bodyIdx].start,
      end: tokens[closeIdx].end,
    };
  }

  function parseClassSymbol(tokens, matching, idx) {
    const nameToken = tokens[idx + 1]?.type === 'id' ? tokens[idx + 1] : null;
    const name = nameToken?.value || '(anonymous)';
    const bodyIdx = findNextToken(tokens, idx, '{', 80);
    const closeIdx = bodyIdx === -1 ? -1 : matching.get(bodyIdx);
    if (bodyIdx === -1 || closeIdx == null) return null;
    const start = symbolStartWithPrefixes(tokens, idx);
    const exported = tokens.slice(Math.max(0, idx - 3), idx).some((token) => token.value === 'export');
    return {
      kind: 'class',
      name,
      exported,
      start,
      bodyStart: tokens[bodyIdx].start,
      end: tokens[closeIdx].end,
      bodyTokenIndex: bodyIdx,
      closeTokenIndex: closeIdx,
    };
  }

  function findStatementEnd(tokens, idx) {
    const baseCurly = tokens[idx].curlyDepth;
    const baseParen = tokens[idx].parenDepth;
    const baseBracket = tokens[idx].bracketDepth;
    for (let i = idx + 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (
        token.value === ';' &&
        token.curlyDepth === baseCurly &&
        token.parenDepth === baseParen &&
        token.bracketDepth === baseBracket
      ) {
        return i;
      }
      if (token.value === '}' && token.curlyDepth < baseCurly) return i - 1;
    }
    return Math.min(tokens.length - 1, idx + 120);
  }

  function variableInitializerKind(tokens, startIdx, endIdx) {
    for (let i = startIdx; i <= endIdx; i++) {
      if (tokens[i]?.value === '=>') return 'function';
      if (tokens[i]?.value === 'function') return 'function';
      if (tokens[i]?.value === 'class') return 'class';
    }
    return '';
  }

  function parseVariableSymbols(tokens, idx) {
    const declarationKind = tokens[idx].value;
    const start = symbolStartWithPrefixes(tokens, idx);
    const endIdx = findStatementEnd(tokens, idx);
    const exported = tokens.slice(Math.max(0, idx - 3), idx).some((token) => token.value === 'export');
    const symbols = [];
    const baseCurly = tokens[idx].curlyDepth;
    const baseParen = tokens[idx].parenDepth;
    const baseBracket = tokens[idx].bracketDepth;
    let expectName = true;
    let currentName = null;
    let declaratorStartIdx = idx + 1;

    for (let i = idx + 1; i <= endIdx; i++) {
      const token = tokens[i];
      const atBase =
        token.curlyDepth === baseCurly &&
        token.parenDepth === baseParen &&
        token.bracketDepth === baseBracket;
      if (expectName && token.type === 'id') {
        currentName = token.value;
        declaratorStartIdx = i;
        expectName = false;
        continue;
      }
      if (atBase && (token.value === ',' || token.value === ';' || i === endIdx)) {
        if (currentName) {
          const declaratorEndIdx = token.value === ',' || token.value === ';' ? i - 1 : i;
          const initializerKind = variableInitializerKind(tokens, declaratorStartIdx, declaratorEndIdx);
          symbols.push({
            kind: initializerKind || declarationKind,
            name: currentName,
            exported,
            declarationKind,
            start,
            bodyStart: tokens[declaratorStartIdx]?.start,
            end: tokens[endIdx]?.end || tokens[declaratorEndIdx]?.end,
          });
        }
        currentName = null;
        expectName = true;
      }
    }

    return symbols;
  }

  function parseClassMethods(tokens, matching, classSymbol) {
    const methods = [];
    const startIdx = classSymbol.bodyTokenIndex + 1;
    const endIdx = classSymbol.closeTokenIndex;
    for (let i = startIdx; i < endIdx; i++) {
      const token = tokens[i];
      if (token.type !== 'id') continue;
      if (token.curlyDepth !== tokens[classSymbol.bodyTokenIndex].curlyDepth + 1) continue;

      let cursor = i;
      const methodStartIdx = i;
      while (
        ['static', 'async', 'get', 'set'].includes(tokens[cursor]?.value) &&
        tokens[cursor + 1]?.type === 'id' &&
        (tokens[cursor + 2]?.value === '(' || ['async', 'get', 'set'].includes(tokens[cursor + 1]?.value))
      ) {
        cursor += 1;
      }

      const nameToken = tokens[cursor];
      const parenIdx = tokens[cursor + 1]?.value === '(' ? cursor + 1 : -1;
      if (!nameToken || parenIdx === -1) continue;
      const closeParenIdx = matching.get(parenIdx);
      const bodyIdx = closeParenIdx == null ? -1 : closeParenIdx + 1;
      if (tokens[bodyIdx]?.value !== '{') continue;
      const closeBodyIdx = matching.get(bodyIdx);
      if (closeBodyIdx == null) continue;
      methods.push({
        kind: 'method',
        name: `${classSymbol.name}.${nameToken.value}`,
        exported: classSymbol.exported,
        declarationKind: 'class method',
        start: symbolStartWithPrefixes(tokens, methodStartIdx),
        bodyStart: tokens[bodyIdx].start,
        end: tokens[closeBodyIdx].end,
      });
    }
    return methods;
  }

  function buildJsSymbolIndexForResource(resource) {
    const source = String(resource?.text || '');
    if (!source || !isJavaScriptResource(resource)) {
      return { symbols: [], totalSymbols: 0, truncated: false };
    }

    const lineStarts = getLineStarts(source);
    const { tokens, matching } = tokenizeJavaScript(source);
    const symbols = [];
    const seen = new Set();
    const classSymbols = [];

    for (let i = 0; i < tokens.length && symbols.length < MAX_JS_SYMBOLS_PER_RESOURCE; i++) {
      const token = tokens[i];
      if (token.type !== 'id') continue;
      if (token.value === 'function') {
        addJsSymbol(symbols, seen, source, lineStarts, resource, parseFunctionSymbol(tokens, matching, i));
      } else if (token.value === 'class') {
        const symbol = parseClassSymbol(tokens, matching, i);
        addJsSymbol(symbols, seen, source, lineStarts, resource, symbol);
        if (symbol) classSymbols.push(symbol);
      } else if (['const', 'let', 'var'].includes(token.value)) {
        for (const symbol of parseVariableSymbols(tokens, i)) {
          addJsSymbol(symbols, seen, source, lineStarts, resource, symbol);
          if (symbols.length >= MAX_JS_SYMBOLS_PER_RESOURCE) break;
        }
      }
    }

    for (const classSymbol of classSymbols) {
      if (symbols.length >= MAX_JS_SYMBOLS_PER_RESOURCE) break;
      for (const method of parseClassMethods(tokens, matching, classSymbol)) {
        addJsSymbol(symbols, seen, source, lineStarts, resource, method);
        if (symbols.length >= MAX_JS_SYMBOLS_PER_RESOURCE) break;
      }
    }

    return {
      symbols,
      totalSymbols: symbols.length,
      truncated: symbols.length >= MAX_JS_SYMBOLS_PER_RESOURCE,
    };
  }

  function addJsSymbolIndexes(resources) {
    return resources.map((resource) => {
      if (!resource?.text || !isJavaScriptResource(resource)) return resource;
      const index = buildJsSymbolIndexForResource(resource);
      return {
        ...resource,
        jsSymbols: index.symbols,
        jsSymbolCount: index.totalSymbols,
        jsSymbolsTruncated: index.truncated,
      };
    });
  }

  async function buildResourceSnapshot() {
    const inventory = collectPageResourceInventory();
    const limitedInventory = inventory.slice(0, MAX_RESOURCE_INVENTORY_ITEMS);
    const limits = [];
    if (inventory.length > limitedInventory.length) {
      limits.push(`resource inventory: kept ${limitedInventory.length} of ${inventory.length}`);
    }

    const fetchedResult = await fetchResourceSnapshots(limitedInventory);
    if (Array.isArray(fetchedResult?.limits?.details)) {
      limits.push(...fetchedResult.limits.details);
    }

    return {
      totalDiscovered: inventory.length,
      inventory: limitedInventory,
      fetched: addJsSymbolIndexes(Array.isArray(fetchedResult?.fetched) ? fetchedResult.fetched : []),
      limits: {
        applied: limits.length > 0,
        details: limits,
      },
    };
  }

  function truncateTextWithNotice(text, limit, label) {
    const value = String(text || '');
    if (value.length <= limit) return { text: value, truncated: false };
    return {
      text: `${value.slice(0, limit)}\n\n... [${label} truncated: ${value.length - limit} chars omitted]`,
      truncated: true,
    };
  }

  function buildDeepSnapshot(root) {
    const DOM_CHAR_LIMIT = 180000;
    const STYLES_CHAR_LIMIT = 120000;
    const INLINE_JS_CHAR_LIMIT = 120000;

    const domHtml = truncateTextWithNotice(root?.outerHTML || '', DOM_CHAR_LIMIT, 'DOM snapshot');

    const styleTags = Array.from(document.querySelectorAll('style'))
      .map((el, idx) => {
        const content = (el.textContent || '').trim();
        return `/* <style #${idx + 1}> */\n${content}`;
      })
      .filter(Boolean)
      .join('\n\n');
    const stylesRaw = truncateTextWithNotice(styleTags, STYLES_CHAR_LIMIT, 'inline styles');

    const externalScripts = Array.from(document.querySelectorAll('script[src]'))
      .map((el) => normalizeResourceUrl(el.getAttribute('src') || ''))
      .filter(Boolean);
    const inlineScriptsRaw = Array.from(document.querySelectorAll('script:not([src])'))
      .map((el, idx) => {
        const content = (el.textContent || '').trim();
        if (!content) return '';
        return `/* <script inline #${idx + 1}> */\n${content}`;
      })
      .filter(Boolean)
      .join('\n\n');
    const inlineScripts = truncateTextWithNotice(inlineScriptsRaw, INLINE_JS_CHAR_LIMIT, 'inline scripts');

    return {
      domHtml: domHtml.text,
      domTruncated: domHtml.truncated,
      stylesRaw: stylesRaw.text,
      stylesTruncated: stylesRaw.truncated,
      externalScripts,
      inlineScriptsRaw: inlineScripts.text,
      inlineScriptsTruncated: inlineScripts.truncated,
    };
  }

  async function buildTechnicalContextSection() {
    const root = findMainContent(document.body);
    const dom = summarizeDomTree(root);
    const styles = summarizeStyles();
    const scripts = summarizeScripts();
    const formControls = extractFormState(root).slice(0, 80);
    const deep = buildDeepSnapshot(root);
    const resources = await buildResourceSnapshot();
    const fetchedByUrl = new Map((resources.fetched || []).map((resource) => [resource.url, resource]));

    const lines = [];
    lines.push('## TECHNICAL CONTEXT (DOM/CSS/JS)');
    lines.push('');
    lines.push('### Form Controls (live DOM)');
    if (formControls.length === 0) {
      lines.push('- none detected');
    } else {
      for (const field of formControls) lines.push(`- ${field.summary}`);
      if (formControls.length >= 80) lines.push('- ... truncated for size');
    }
    lines.push('');
    lines.push('### DOM Tree (main content excerpt)');
    for (const line of dom.lines) lines.push(line);
    if (dom.truncated) lines.push('- ... truncated for size');
    lines.push('');
    lines.push('### CSS Summary');
    lines.push(`- stylesheets (document.styleSheets): ${styles.stylesheetCount}`);
    lines.push(`- <style> tags: ${styles.styleTags}`);
    lines.push(`- stylesheet <link> tags: ${styles.stylesheetLinks}`);
    lines.push(`- elements with inline style attr: ${styles.inlineStyleAttrs}`);
    lines.push(`- elements with CSS variables in style attr: ${styles.cssVariables}`);
    lines.push(`- body font: ${styles.body.fontFamily} (${styles.body.fontSize})`);
    lines.push(`- body text color: ${styles.body.color}`);
    lines.push(`- body background color: ${styles.body.backgroundColor}`);
    lines.push('');
    lines.push('### Script Summary');
    lines.push(`- total scripts: ${scripts.totalScripts}`);
    lines.push(`- external scripts: ${scripts.externalCount}`);
    lines.push(`- inline scripts: ${scripts.inlineCount}`);
    lines.push(`- detected libraries/frameworks: ${scripts.detectedLibraries.join(', ') || 'none detected'}`);
    if (scripts.externalExamples.length > 0) {
      lines.push('- external script examples:');
      for (const src of scripts.externalExamples) lines.push(`  - ${src}`);
    }
    lines.push('');

    lines.push('### Page Resource Inventory');
    lines.push(`- discovered resources: ${resources.totalDiscovered}`);
    lines.push(`- inventory entries shown: ${resources.inventory.length}`);
    lines.push(`- fetched text snapshots: ${resources.fetched.filter((resource) => resource.text).length}`);
    lines.push('- large raw DOM/CSS/JS snapshots are intentionally omitted from this prompt; fetched resource bodies are available through resource/JS symbol tools when tool mode is active');
    lines.push('- resources:');
    if (resources.inventory.length === 0) {
      lines.push('  - none detected');
    } else {
      for (const resource of resources.inventory.slice(0, 120)) {
        const fetched = fetchedByUrl.get(resource.url);
        const fetchedNote = fetched?.text
          ? `; fetched ${fetched.text.length} chars${fetched.truncated ? ' (truncated)' : ''}`
          : fetched?.error
            ? `; fetch error: ${fetched.error}`
            : fetched?.skipped
              ? `; skipped: ${fetched.skipped}`
              : '';
        const sources = resource.sources?.length ? `; sources: ${resource.sources.join(', ')}` : '';
        lines.push(`  - [${resource.id}] ${resource.kind}: ${resource.url}${sources}${fetchedNote}`);
      }
      if (resources.inventory.length > 120) lines.push(`  - ... ${resources.inventory.length - 120} more resources omitted from text inventory`);
    }
    lines.push('');

    const jsResources = resources.fetched.filter((resource) => Array.isArray(resource.jsSymbols) && resource.jsSymbols.length > 0);
    const allJsSymbols = jsResources.flatMap((resource) => resource.jsSymbols || []);
    lines.push('### JS Symbol Index');
    lines.push(`- indexed JS resources: ${jsResources.length}`);
    lines.push(`- indexed JS symbols: ${allJsSymbols.length}`);
    if (jsResources.some((resource) => resource.jsSymbolsTruncated)) {
      lines.push('- one or more JS symbol lists were truncated for size');
    }
    if (allJsSymbols.length === 0) {
      lines.push('- none indexed');
    } else {
      for (const symbol of allJsSymbols.slice(0, MAX_JS_SYMBOLS_IN_PROMPT)) {
        const exported = symbol.exported ? ' exported' : '';
        const declaration = symbol.declarationKind ? ` via ${symbol.declarationKind}` : '';
        lines.push(`- ${symbol.id}: ${symbol.kind}${exported}${declaration} ${symbol.name} (${symbol.resourceId}:${symbol.lineStart}-${symbol.lineEnd}) ${symbol.signature}`);
      }
      if (allJsSymbols.length > MAX_JS_SYMBOLS_IN_PROMPT) {
        lines.push(`- ... ${allJsSymbols.length - MAX_JS_SYMBOLS_IN_PROMPT} more symbols omitted; use JS symbol tools`);
      }
    }
    lines.push('');

    return {
      sectionText: lines.join('\n'),
      data: { dom, styles, scripts, deep, resources },
      limits: resources.limits,
    };
  }

  function looksLikeVisibleContentFrame(iframeEl) {
    try {
      const rect = iframeEl.getBoundingClientRect();
      if (rect.width < 250 || rect.height < 150) return false;
      const style = window.getComputedStyle(iframeEl);
      return !(style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0');

    } catch {
      return false;
    }
  }

  function extractMainContentFromDocument(doc) {
    if (!doc?.body) {
      return {
        headings: [],
        paragraphs: [],
        images: [],
        links: [],
        lists: [],
        tables: [],
        codeBlocks: [],
      };
    }

    const clone = doc.body.cloneNode(true);
    removeNoise(clone);
    const mainContent = findMainContent(clone);

    return {
      headings: extractHeadings(mainContent),
      paragraphs: extractParagraphs(mainContent),
      images: extractImages(mainContent),
      links: extractLinks(mainContent),
      lists: extractLists(mainContent),
      tables: extractTables(mainContent),
      codeBlocks: extractCodeBlocks(mainContent),
    };
  }

  function extractAccessibleIframeContent() {
    const MAX_VISIBLE_IFRAMES = 5;
    const allFrames = Array.from(document.querySelectorAll('iframe'));
    const visibleFrames = allFrames.filter(looksLikeVisibleContentFrame);
    const merge = {
      headings: [],
      paragraphs: [],
      images: [],
      links: [],
      lists: [],
      tables: [],
      codeBlocks: [],
    };
    const limits = [];

    let processed = 0;
    let crossOriginSkipped = 0;
    let dueToCountSkipped = 0;
    for (const iframe of visibleFrames) {
      if (processed >= MAX_VISIBLE_IFRAMES) {
        dueToCountSkipped += 1;
        continue;
      }

      try {
        const doc = iframe.contentDocument;
        if (!doc?.body) continue;
        const frameData = extractMainContentFromDocument(doc);
        merge.headings.push(...frameData.headings);
        merge.paragraphs.push(...frameData.paragraphs);
        merge.images.push(...frameData.images);
        merge.links.push(...frameData.links);
        merge.lists.push(...frameData.lists);
        merge.tables.push(...frameData.tables);
        merge.codeBlocks.push(...frameData.codeBlocks);
        processed += 1;
      } catch {
        // Cross-origin iframes are not readable in content scripts.
        crossOriginSkipped += 1;
      }
    }

    if (dueToCountSkipped > 0) {
      limits.push(`visible iframes: processed ${MAX_VISIBLE_IFRAMES} of ${visibleFrames.length}`);
    }
    if (crossOriginSkipped > 0) {
      limits.push(`cross-origin iframes skipped: ${crossOriginSkipped}`);
    }

    merge.headings = uniqueBy(merge.headings, (h) => `${h.level}|${h.text}`);
    merge.paragraphs = uniqueBy(merge.paragraphs, (p) => p);
    merge.images = uniqueBy(merge.images, (img) => `${img.src}|${img.alt}|${img.caption}`);
    merge.links = uniqueBy(merge.links, (l) => l.href);
    merge.lists = uniqueBy(merge.lists, (l) => `${l.type}|${l.items.join('|')}`);
    merge.tables = uniqueBy(merge.tables, (t) => JSON.stringify(t));
    merge.codeBlocks = uniqueBy(merge.codeBlocks, (b) => b);

    return { content: merge, limits };
  }

  const DISCUSSION_HINT_RE = /(comment|discussion|discuss|thread|reply|replies|response|conversation|forum|message|answer|feedback|review|kommentar|komment|comentario|commentaire|comentario|coment|comentario|komentar|\u043a\u043e\u043c\u043c\u0435\u043d\u0442|\u043e\u0431\u0441\u0443\u0436\u0434\u0435\u043d|\u043e\u0442\u0432\u0435\u0442)/i;
  const COMMENT_ITEM_HINT_RE = /(comment|reply|message|post|answer|response|thread|forum|review|\u043a\u043e\u043c\u043c\u0435\u043d\u0442|\u043e\u0442\u0432\u0435\u0442)/i;

  function elementHintText(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const attrs = [
      el.id,
      el.className,
      el.getAttribute('role'),
      el.getAttribute('aria-label'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-test'),
      el.getAttribute('itemtype'),
      el.getAttribute('itemprop'),
    ];
    return attrs.map((x) => String(x || '')).join(' ');
  }

  function looksLikeDiscussionElement(el) {
    const hint = elementHintText(el);
    if (DISCUSSION_HINT_RE.test(hint)) return true;
    const href = el.getAttribute?.('href') || '';
    if (DISCUSSION_HINT_RE.test(href)) return true;
    const text = normalizeExtractedText(el.textContent || '').slice(0, 120);
    return DISCUSSION_HINT_RE.test(text) && /\d/.test(text);
  }

  function findDiscussionSignals() {
    const signals = [];
    const selectors = 'a[href], button, [role="button"], h2, h3, h4, [aria-label]';
    for (const el of Array.from(document.querySelectorAll(selectors))) {
      if (signals.length >= 8) break;
      if (!isElementVisible(el)) continue;
      const text = normalizeExtractedText(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`);
      const href = el.getAttribute('href') || '';
      if (!DISCUSSION_HINT_RE.test(`${text} ${href}`)) continue;
      if (!/\d/.test(text) && !/#/.test(href)) continue;
      const signal = text.slice(0, 140) || href.slice(0, 140);
      if (signal && !signals.includes(signal)) signals.push(signal);
    }
    return signals;
  }

  function findDiscussionRoots(root) {
    const candidates = [];
    const selector = [
      'section', 'div', 'article', 'ol', 'ul',
      '[role="feed"]', '[role="list"]',
      '[itemtype*="Comment" i]', '[itemprop*="comment" i]',
    ].join(',');
    for (const el of Array.from(root.querySelectorAll(selector))) {
      if (!isElementVisible(el)) continue;
      const textLength = normalizeExtractedText(el.textContent || '').length;
      if (textLength < 40) continue;
      if (!looksLikeDiscussionElement(el)) continue;
      candidates.push(el);
    }

    candidates.sort((a, b) => {
      const aText = normalizeExtractedText(a.textContent || '').length;
      const bText = normalizeExtractedText(b.textContent || '').length;
      return bText - aText;
    });

    const roots = [];
    for (const el of candidates) {
      if (roots.some((rootEl) => rootEl.contains(el))) continue;
      roots.push(el);
      if (roots.length >= 6) break;
    }
    return roots;
  }

  function pickFirstShortText(root, selectors) {
    for (const selector of selectors) {
      let els = [];
      try {
        els = Array.from(root.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (const el of els) {
        const text = normalizeExtractedText(el.getAttribute('datetime') || el.textContent || '');
        if (text.length >= 2 && text.length <= 80) return text;
      }
    }
    return '';
  }

  function extractCommentText(el) {
    const selectors = [
      '[itemprop="text"]',
      '.comment-body', '.comment-content', '.comment-text', '.comment__message', '.comment-message',
      '.message-body .bbWrapper', '.message-body', '.post-body', '.reply-body',
      '[class*="comment"][class*="body"]', '[class*="comment"][class*="content"]',
      '[class*="comment"][class*="text"]', '[class*="reply"][class*="body"]',
      'p',
    ];
    const pieces = [];
    for (const selector of selectors) {
      let matches = [];
      try {
        matches = Array.from(el.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (const match of matches) {
        if (!isElementVisible(match)) continue;
        const text = normalizeExtractedText(match.textContent || '');
        if (text.length >= 20 && text.length <= 5000) pieces.push(text);
      }
      if (pieces.length > 0) break;
    }

    const text = pieces.length > 0
      ? pieces.join('\n\n')
      : normalizeExtractedText(el.textContent || '');
    return text
      .replace(/\b(reply|like|dislike|share|report|edit|delete|permalink)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractCommentFromElement(el, indexBase = 0) {
    const text = extractCommentText(el);
    if (text.length < 20) return null;
    if (text.length > 5000) return null;

    const author = pickFirstShortText(el, [
      '[itemprop="author"]', '[rel="author"]',
      '[class*="author"]', '[class*="user"]', '[class*="username"]', '[class*="login"]',
      'a[href*="/users/"]', 'a[href*="/user/"]', 'a[href*="/profile/"]',
    ]);
    const time = pickFirstShortText(el, [
      'time[datetime]', '[datetime]',
      '[class*="time"]', '[class*="date"]', '[class*="created"]',
    ]);
    const score = pickFirstShortText(el, [
      '[class*="score"]', '[class*="rating"]', '[class*="vote"]', '[aria-label*="score" i]',
    ]);

    return {
      id: `c${indexBase + 1}`,
      author,
      time,
      score,
      text: text.slice(0, 1800),
      selector: toSelector(el),
    };
  }

  function collectCommentItems(root, indexBase = 0) {
    const selector = [
      '[itemtype*="Comment" i]', '[itemprop*="comment" i]',
      '[role="article"]', '[role="listitem"]',
      'article', 'li',
      '[class*="comment" i]', '[id*="comment" i]',
      '[class*="reply" i]', '[id*="reply" i]',
      '[class*="message" i]', '[class*="post" i]',
      '[data-testid*="comment" i]', '[data-test*="comment" i]',
    ].join(',');

    let candidates = [];
    try {
      candidates = Array.from(root.querySelectorAll(selector));
    } catch {
      candidates = [];
    }

    if (candidates.length === 0) {
      candidates = Array.from(root.children || []);
    }

    const filtered = [];
    for (const el of candidates) {
      if (!isElementVisible(el)) continue;
      const text = normalizeExtractedText(el.textContent || '');
      if (text.length < 20 || text.length > 7000) continue;
      const hint = elementHintText(el);
      const role = el.getAttribute('role') || '';
      if (
        !COMMENT_ITEM_HINT_RE.test(hint) &&
        role !== 'article' &&
        role !== 'listitem' &&
        el.tagName.toLowerCase() !== 'li' &&
        !/Comment/i.test(el.getAttribute('itemtype') || '')
      ) {
        continue;
      }
      filtered.push(el);
    }

    const leaves = filtered.filter((el) => {
      const childCount = filtered.filter((other) => other !== el && el.contains(other)).length;
      return childCount === 0 || normalizeExtractedText(el.textContent || '').length < 1200;
    });

    const comments = [];
    const seen = new Set();
    for (const el of leaves) {
      const comment = extractCommentFromElement(el, indexBase + comments.length);
      if (!comment) continue;
      const key = normalizeTextForMatch(comment.text).slice(0, 300);
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push(comment);
      if (comments.length >= 200) break;
    }
    return comments;
  }

  /**
   * Extract comments/discussion from the live document.
   * Keeps the result separate from article text so models can query it directly.
   */
  function extractComments() {
    const limits = [];
    const comments = [];
    const seen = new Set();

    const addComments = (items) => {
      for (const item of items) {
        const key = normalizeTextForMatch(item.text).slice(0, 300);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        item.id = `c${comments.length + 1}`;
        comments.push(item);
        if (comments.length >= 200) return;
      }
    };

    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        const src = iframe.src || '';
        const containerHint = `${src} ${elementHintText(iframe)} ${elementHintText(iframe.parentElement)}`;
        if (!DISCUSSION_HINT_RE.test(containerHint)) continue;
        try {
          const doc = iframe.contentDocument;
          if (!doc?.body) continue;
          addComments(collectCommentItems(doc.body, comments.length).map((comment) => ({
            ...comment,
            selector: '',
          })));
        } catch {
          limits.push('comments: cross-origin discussion iframe could not be read');
        }
      }
    } catch {}

    const roots = findDiscussionRoots(document.body);
    for (const root of roots) {
      addComments(collectCommentItems(root, comments.length));
      if (comments.length >= 200) break;
    }

    if (comments.length === 0) {
      const signals = findDiscussionSignals();
      if (signals.length > 0) {
        limits.push(`comments: found discussion controls (${signals.join(' | ')}), but no readable comment bodies in the current DOM`);
      }
    }

    return {
      comments: comments.slice(0, 120),
      totalDetected: comments.length,
      limits,
    };
  }

  function normalizeTextForMatch(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function toSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
      const tag = node.tagName.toLowerCase();
      if (node.id) {
        const escapedId = window.CSS?.escape ? window.CSS.escape(node.id) : node.id.replace(/[^a-zA-Z0-9\-_:.]/g, '\\$&');
        parts.unshift(`${tag}#${escapedId}`);
        break;
      }
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) idx += 1;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      node = node.parentElement;
    }
    if (parts.length === 0) return 'body';
    return `body > ${parts.join(' > ')}`;
  }

  function createMatcher(root, selector, pickText) {
    const elements = Array.from(root.querySelectorAll(selector));
    const exact = new Map();
    const exactCursors = new Map();
    const used = new WeakSet();
    for (const el of elements) {
      const key = normalizeTextForMatch(pickText(el));
      if (!key) continue;
      if (!exact.has(key)) exact.set(key, []);
      exact.get(key).push(el);
    }
    return (targetText) => {
      const normalized = normalizeTextForMatch(targetText);
      if (!normalized) return { el: null, occurrence: 1 };
      const bucket = exact.get(normalized);
      if (bucket && bucket.length > 0) {
        let idx = exactCursors.get(normalized) || 0;
        while (idx < bucket.length && used.has(bucket[idx])) idx += 1;
        if (idx >= bucket.length) idx = Math.min((exactCursors.get(normalized) || 0), bucket.length - 1);
        const chosen = bucket[idx] || bucket[bucket.length - 1];
        exactCursors.set(normalized, Math.min(idx + 1, bucket.length));
        if (chosen) used.add(chosen);
        return { el: chosen || null, occurrence: idx + 1 };
      }

      let best = null;
      let bestScore = -1;
      let occurrence = 1;
      for (const el of elements) {
        const text = normalizeTextForMatch(pickText(el));
        if (!text) continue;
        if (!(text.includes(normalized) || normalized.includes(text))) continue;
        let score = Math.min(text.length, normalized.length);
        if (used.has(el)) score -= 1000;
        if (score > bestScore) {
          bestScore = score;
          best = el;
          occurrence = 1;
        }
      }
      if (best) used.add(best);
      return { el: best, occurrence };
    };
  }

  function buildTextContentWithSources(data, options = {}) {
    const lines = [];
    const sourceAnchors = {};
    const liveRoot = options.liveRoot && options.liveRoot.querySelectorAll ? options.liveRoot : document.body;
    const matchers = {
      heading: createMatcher(liveRoot, 'h1, h2, h3, h4, h5, h6', (el) => el.textContent || ''),
      paragraph: createMatcher(liveRoot, 'p, blockquote', (el) => el.textContent || ''),
      listItem: createMatcher(liveRoot, 'li', (el) => el.textContent || ''),
      tableRow: createMatcher(liveRoot, 'tr', (el) => Array.from(el.querySelectorAll('th,td')).map((td) => td.textContent.trim()).join(' | ')),
      code: createMatcher(liveRoot, 'pre, code', (el) => el.textContent || ''),
      image: createMatcher(liveRoot, 'img[alt]', (el) => el.getAttribute('alt') || ''),
      link: createMatcher(liveRoot, 'a[href]', (el) => `${el.textContent || ''} ${el.getAttribute('href') || ''}`),
    };
    let sourceSeq = 0;

    function sourceTag(type, text, fallback = '') {
      const finder = matchers[type];
      if (!finder || !text) return '';
      let found = finder(text);
      if ((!found || !found.el) && fallback) found = finder(fallback);
      const el = found?.el;
      if (!el) return '';
      const selector = toSelector(el);
      if (!selector) return '';
      sourceSeq += 1;
      const sourceId = `s${sourceSeq}`;
      sourceAnchors[sourceId] = {
        selector,
        snippet: String(text).replace(/\s+/g, ' ').trim().slice(0, 220),
        occurrence: Number(found?.occurrence) || 1,
      };
      return ` [${sourceId}]`;
    }

    function sourceTagForSelector(selector, text) {
      if (!selector) return '';
      sourceSeq += 1;
      const sourceId = `s${sourceSeq}`;
      sourceAnchors[sourceId] = {
        selector,
        snippet: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        occurrence: 1,
      };
      return ` [${sourceId}]`;
    }

    lines.push(`# ${data.title}`);
    lines.push(`URL: ${data.url}`);
    if (data.description) lines.push(`Description: ${data.description}`);
    lines.push('');

    for (const h of data.headings) {
      lines.push(`${'#'.repeat(h.level)} ${h.text}${sourceTag('heading', h.text)}`);
    }
    if (data.headings.length > 0) lines.push('');

    for (const p of data.paragraphs) {
      lines.push(`${p}${sourceTag('paragraph', p)}`);
      lines.push('');
    }

    if (data.lists.length > 0) {
      for (const list of data.lists) {
        for (const item of list.items) {
          lines.push(`- ${item}${sourceTag('listItem', item)}`);
        }
        lines.push('');
      }
    }

    if (data.tables.length > 0) {
      for (const table of data.tables) {
        for (const row of table) {
          const rowText = row.join(' | ');
          lines.push(`| ${rowText} |${sourceTag('tableRow', rowText)}`);
        }
        lines.push('');
      }
    }

    if (data.codeBlocks.length > 0) {
      for (const block of data.codeBlocks) {
        const tag = sourceTag('code', block);
        if (tag) lines.push(`Source${tag}`);
        lines.push('```');
        lines.push(block);
        lines.push('```');
        lines.push('');
      }
    }

    if (data.images.length > 0) {
      lines.push('Images:');
      for (const img of data.images) {
        const cap = img.caption ? ` (${img.caption})` : '';
        lines.push(`- [${img.alt}]${cap}${sourceTag('image', img.alt)}`);
      }
      lines.push('');
    }

    if (data.links.length > 0) {
      lines.push('Links:');
      for (const link of data.links.slice(0, 30)) {
        lines.push(`- [${link.text}](${link.href})${sourceTag('link', `${link.text} ${link.href}`)}`);
      }
    }

    if (data.comments && data.comments.length > 0) {
      lines.push('');
      lines.push(`## User Comments (${data.comments.length} extracted)`);
      lines.push('');
      for (const comment of data.comments) {
        const body = typeof comment === 'string' ? comment : comment.text;
        const meta = [];
        if (comment && typeof comment === 'object') {
          if (comment.id) meta.push(comment.id);
          if (comment.author) meta.push(`by ${comment.author}`);
          if (comment.time) meta.push(comment.time);
          if (comment.score) meta.push(`score ${comment.score}`);
        }
        const prefix = meta.length ? `- ${meta.join(' | ')}: ` : '- ';
        const tag = comment && typeof comment === 'object'
          ? sourceTagForSelector(comment.selector, body)
          : '';
        lines.push(`${prefix}${body}${tag}`);
        lines.push('');
      }
    }

    if (Array.isArray(data.forms) && data.forms.length > 0) {
      lines.push('');
      lines.push('## Form Fields (current state)');
      lines.push('');
      for (const field of data.forms) {
        lines.push(`- ${field.summary}${sourceTagForSelector(field.selector, field.summary)}`);
      }
      lines.push('');
    }

    return {
      textContent: lines.join('\n'),
      sourceAnchors,
    };
  }

  // ── YouTube-specific extraction ──────────────────────────────────────

  function isYouTubeWatchPage() {
    const h = location.hostname;
    return (h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com') &&
      location.pathname === '/watch' &&
      new URLSearchParams(location.search).has('v');
  }

  const YOUTUBE_TRANSCRIPT_PRIMARY_TIMEOUT_MS = 5000;
  const YOUTUBE_TRANSCRIPT_CAPTION_TIMEOUT_MS = 5000;
  const YOUTUBE_TRANSCRIPT_DOM_TIMEOUT_MS = 4500;
  const YOUTUBE_TRANSCRIPT_DOM_POLL_MS = 2500;

  function withTimeout(promise, timeoutMs, fallbackValue = null) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(fallbackValue), timeoutMs)),
    ]);
  }

  function parseTimestampToSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }

    const normalized = normalizeTranscriptText(value).toLowerCase();
    if (!normalized) return null;

    const colonMatch = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (colonMatch) {
      const first = Number(colonMatch[1]);
      const second = Number(colonMatch[2]);
      const third = colonMatch[3] == null ? null : Number(colonMatch[3]);
      if (third == null) return first * 60 + second;
      return first * 3600 + second * 60 + third;
    }

    let total = 0;
    let matched = false;
    const unitRe = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
    for (const match of normalized.matchAll(unitRe)) {
      const amount = Number(match[1]);
      if (!Number.isFinite(amount)) continue;
      const unit = match[2][0];
      if (unit === 'h') total += amount * 3600;
      else if (unit === 'm') total += amount * 60;
      else total += amount;
      matched = true;
    }

    return matched ? Math.max(0, Math.floor(total)) : null;
  }

  function formatTimecode(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function buildYouTubeTimestampUrl(videoId, startSeconds) {
    if (!videoId) return '';
    const seconds = Math.max(0, Math.floor(Number(startSeconds) || 0));
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${seconds}s`;
  }

  function normalizeTranscriptLine(line) {
    if (typeof line === 'string') {
      return { text: line, startSeconds: null, timestamp: '' };
    }
    if (!line || typeof line !== 'object') {
      return { text: '', startSeconds: null, timestamp: '' };
    }
    const text = String(line.text || '').trim();
    const parsedSeconds = parseTimestampToSeconds(line.startSeconds ?? line.timestamp);
    return {
      text,
      startSeconds: parsedSeconds,
      timestamp: line.timestamp || (parsedSeconds != null ? formatTimecode(parsedSeconds) : ''),
    };
  }

  function formatTranscriptContextLine(line) {
    const normalized = normalizeTranscriptLine(line);
    if (!normalized.text) return '';
    if (normalized.startSeconds == null) return normalized.text;
    const timecode = normalized.timestamp || formatTimecode(normalized.startSeconds);
    return `- ${timecode} (t=${normalized.startSeconds}s) ${normalized.text}`;
  }

  function getTextFromRenderer(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs)) return value.runs.map(run => run?.text || '').join('');
    return '';
  }

  function parseYouTubeTimestampFromUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl);
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
      return parseTimestampToSeconds(
        url.searchParams.get('t') ||
        url.searchParams.get('start') ||
        url.searchParams.get('time_continue') ||
        hashParams.get('t') ||
        hashParams.get('start')
      );
    } catch {
      return null;
    }
  }

  function seekCurrentYouTubeVideo(seconds, rawUrl = '') {
    const startSeconds = parseTimestampToSeconds(seconds) ?? parseYouTubeTimestampFromUrl(rawUrl);
    if (startSeconds == null) return { ok: false, error: 'invalid timestamp' };

    const video = document.querySelector('video');
    if (!isYouTubeWatchPage() && !video) return { ok: false, error: 'not a YouTube watch page' };

    let seeked = false;
    const player = document.getElementById('movie_player') || document.querySelector('#movie_player');
    const unwrappedPlayer = player?.wrappedJSObject || player;

    try {
      if (typeof unwrappedPlayer?.seekTo === 'function') {
        unwrappedPlayer.seekTo(startSeconds, true);
        seeked = true;
      }
    } catch {}

    try {
      if (video) {
        if (typeof video.fastSeek === 'function') video.fastSeek(startSeconds);
        else video.currentTime = startSeconds;
        video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
        seeked = true;
      }
    } catch (err) {
      if (!seeked) return { ok: false, error: err?.message || 'seek failed' };
    }

    if (!seeked) return { ok: false, error: 'video element not found' };

    return { ok: true, seconds: startSeconds };
  }

  function parseJSONFromText(text, startIdx) {
    // String-aware brace counting — handles {} inside JSON string values
    let depth = 0;
    let endIdx = -1;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth === 0) { endIdx = i; break; }
    }
    if (endIdx > startIdx) {
      return JSON.parse(text.substring(startIdx, endIdx + 1));
    }
    return null;
  }

  /**
   * Fetch the watch page HTML and extract the embedded ytInitialPlayerResponse.
   * Always returns fresh data with valid caption URLs.
   */
  async function fetchFreshPlayerResponse(videoId) {
    const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { credentials: 'include' });
    if (!pageResp.ok) return null;
    const html = await pageResp.text();

    for (const marker of ['var ytInitialPlayerResponse = ', 'ytInitialPlayerResponse = ']) {
      const start = html.indexOf(marker);
      if (start === -1) continue;
      const jsonStart = start + marker.length;
      if (html[jsonStart] !== '{') continue;
      const parsed = parseJSONFromText(html, jsonStart);
      if (parsed?.videoDetails?.videoId === videoId) return parsed;
    }
    return null;
  }

  async function getYTInitialPlayerResponse() {
    const currentVideoId = new URLSearchParams(location.search).get('v');

    // 1. Read the live page global via Firefox's wrappedJSObject.
    try {
      const raw = window.wrappedJSObject.ytInitialPlayerResponse;
      if (raw?.videoDetails?.videoId === currentVideoId) {
        return JSON.parse(window.wrappedJSObject.JSON.stringify(raw));
      }
    } catch {}

    // 2. Parse from <script> tags in the live DOM.
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        if (!text || !text.includes('ytInitialPlayerResponse')) continue;
        const startMatch = text.match(/ytInitialPlayerResponse\s*=\s*\{/);
        if (!startMatch) continue;
        const parsed = parseJSONFromText(text, startMatch.index + startMatch[0].length - 1);
        if (parsed?.videoDetails?.videoId === currentVideoId) return parsed;
      }
    } catch {}

    // 3. Fetch the watch page HTML (always has fresh data).
    try {
      return await fetchFreshPlayerResponse(currentVideoId);
    } catch {}

    return null;
  }

  async function getYTInitialData() {
    // 1. Read the live page global via Firefox's wrappedJSObject.
    try {
      const raw = window.wrappedJSObject?.ytInitialData;
      if (raw) {
        return JSON.parse(window.wrappedJSObject.JSON.stringify(raw));
      }
    } catch {}

    // 2. Parse from <script> tags in the live DOM.
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        if (!text || !text.includes('ytInitialData')) continue;
        const startMatch = text.match(/ytInitialData\s*=\s*\{/);
        if (!startMatch) continue;
        const parsed = parseJSONFromText(text, startMatch.index + startMatch[0].length - 1);
        if (parsed) return parsed;
      }
    } catch {}

    // 3. Fetch the watch page HTML.
    try {
      const videoId = new URLSearchParams(location.search).get('v');
      const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { credentials: 'include' });
      if (!pageResp.ok) return null;
      const html = await pageResp.text();
      for (const marker of ['var ytInitialData = ', 'ytInitialData = ']) {
        const start = html.indexOf(marker);
        if (start === -1) continue;
        const jsonStart = start + marker.length;
        if (html[jsonStart] !== '{') continue;
        const parsed = parseJSONFromText(html, jsonStart);
        if (parsed) return parsed;
      }
    } catch {}

    return null;
  }

  function extractTranscriptParams(root) {
    const seen = new WeakSet();

    function visit(node) {
      if (!node || typeof node !== 'object') return null;
      if (seen.has(node)) return null;
      seen.add(node);

      const direct = node?.getTranscriptEndpoint?.params;
      if (typeof direct === 'string' && direct) {
        try { return decodeURIComponent(direct); } catch { return direct; }
      }

      for (const value of Object.values(node)) {
        const found = visit(value);
        if (found) return found;
      }
      return null;
    }

    return visit(root);
  }

  function extractYouTubeMetadata(playerResponse) {
    const meta = { title: '', channel: '', viewCount: '', videoId: '', publishDate: '' };

    try {
      const vd = playerResponse?.videoDetails;
      if (vd) {
        meta.title = vd.title || '';
        meta.channel = vd.author || '';
        meta.viewCount = vd.viewCount || '';
        meta.videoId = vd.videoId || '';
      }
      const mf = playerResponse?.microformat?.playerMicroformatRenderer;
      if (mf) {
        meta.publishDate = mf.publishDate || '';
      }
    } catch {}

    // DOM fallbacks
    if (!meta.title) {
      meta.title = document.querySelector('h1[class*="watch-metadata"] [id="title"]')?.textContent?.trim() ||
        document.querySelector('h1[class*="watch-metadata"] [class*="formatted-string"]')?.textContent?.trim() ||
        document.title.replace(/ - YouTube$/, '') || '';
    }
    if (!meta.channel) {
      meta.channel = document.querySelector('[class*="channel-name"] [id="text"] a')?.textContent?.trim() ||
        document.querySelector('[class*="channel-name"] [class*="formatted-string"] a')?.textContent?.trim() || '';
    }
    if (!meta.videoId) {
      meta.videoId = new URLSearchParams(location.search).get('v') || '';
    }

    return meta;
  }

  function extractYouTubeDescription(playerResponse) {
    try {
      const desc = playerResponse?.videoDetails?.shortDescription;
      if (desc) return desc;
    } catch {}

    // DOM fallback
    try {
      const expander = document.querySelector('[id="plain-snippet-text"]') ||
        document.querySelector('.snippet-text') ||
        document.querySelector('#description-inline-expander [id="description-text"]') ||
        document.querySelector('[class*="text-inline-expander"] #plain-snippet-text') ||
        document.querySelector('[class*="text-inline-expander"] .snippet-text') ||
        document.querySelector('#description-inline-expander [class*="attributed-string"]');
      if (expander) return expander.textContent.trim();
    } catch {}

    return '';
  }

  function chooseCaptionTrack(tracks) {
    return tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
      tracks.find(t => t.languageCode === 'en') ||
      tracks.find(t => t.languageCode?.startsWith('en')) ||
      tracks[0];
  }

  function parseTranscriptXML(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const textEls = doc.querySelectorAll('text');
    const events = [];
    for (const el of textEls) {
      const start = parseFloat(el.getAttribute('start') || '0') * 1000;
      const text = el.textContent || '';
      if (text.trim()) {
        events.push({ tStartMs: start, segs: [{ utf8: text }] });
      }
    }
    return events;
  }

  function readTranscriptTimestampFromSegment(seg) {
    if (!seg) return '';

    const explicitSelectors = [
      'yt-formatted-string#timestamp',
      '#timestamp',
      '.segment-timestamp',
      '[class*="timestamp"]',
      '[class*="start-offset"]',
      '[id*="timestamp"]',
    ];

    for (const selector of explicitSelectors) {
      const candidates = Array.from(seg.querySelectorAll(selector));
      for (const el of candidates) {
        const text = normalizeTranscriptText(el.innerText || el.textContent);
        if (isTranscriptTimestampLike(text)) return text;
      }
    }

    const rawLines = (seg.innerText ?? seg.textContent ?? '')
      .split('\n')
      .map(normalizeTranscriptText)
      .filter(Boolean);
    return rawLines.find(isTranscriptTimestampLike) || '';
  }

  /**
   * Fetch a URL via the background script as fallback.
   */
  async function bgFetchText(url) {
    try {
      const result = await withTimeout(
        browser.runtime.sendMessage({ type: 'fetchText', url, timeoutMs: YOUTUBE_TRANSCRIPT_CAPTION_TIMEOUT_MS }),
        YOUTUBE_TRANSCRIPT_CAPTION_TIMEOUT_MS + 500,
        null
      );
      return result?.text || '';
    } catch {
      return '';
    }
  }

  async function contentFetchText(url, { credentials = 'include', timeoutMs = YOUTUBE_TRANSCRIPT_CAPTION_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { credentials, cache: 'no-store', signal: controller.signal });
      const text = await resp.text();
      return { text: text || '', status: resp.status || 0 };
    } catch {
      return { text: '', status: 0 };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getElementLabel(el) {
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.getAttribute('title') || '').trim();
    return { text, aria, title };
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return el.getClientRects().length > 0;
  }

  function resolveClickable(el) {
    if (!el) return null;
    if (el.matches('button, [role="button"], [class*="paper-item"]')) return el;
    const child = el.querySelector?.('button, [role="button"], [class*="paper-item"], [class*="button-shape"] button');
    if (child) return child;
    const parent = el.closest?.('button, [role="button"], [class*="paper-item"]');
    return parent || el;
  }

  function clickElement(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch {
      try { el.click(); } catch {}
    }
  }

  function findVisibleShowMoreButton() {
    const candidates = Array.from(document.querySelectorAll('button, [class*="paper-button"], [class*="button-renderer"]'));
    return candidates.find((el) => {
      if (!isVisible(el)) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const title = (el.getAttribute('title') || '').trim().toLowerCase();
      // Expanders in the watch details/description area.
      if (text !== 'show more' && aria !== 'show more' && title !== 'show more') return false;
      return !!el.closest('[id="description"], [id="watch-metadata"], [class*="expander-renderer"]');
    });
  }

  function getTranscriptPanelElement({ visibleOnly = false } = {}) {
    const selectors = [
      '[target-id="engagement-panel-timeline-view-consolidated"]',
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-timeline-view-consolidated"]',
      '[target-id="PAmodern_transcript_view"]',
      '[target-id*="transcript"]',
      'ytd-transcript-renderer',
      '[class*="transcript-search-panel-renderer"]',
      '[class*="transcript-renderer"]',
    ];
    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      for (const el of candidates) {
        if (visibleOnly && !isVisible(el)) continue;
        return el;
      }
    }
    return null;
  }

  function hasTranscriptPanelVisible() {
    const panel = getTranscriptPanelElement({ visibleOnly: true });
    const hasVisibleSegments = Array.from(
      document.querySelectorAll('ytd-transcript-segment-renderer, [class*="transcript-segment-renderer"]')
    ).some(isVisible);
    return !!panel || hasVisibleSegments;
  }

  function findDedicatedTranscriptButton() {
    const selectors = [
      'ytd-video-description-transcript-section-renderer button',
      'ytd-video-description-transcript-section-renderer [role="button"]',
      '[class*="transcript-section-renderer"] button',
      '[class*="transcript-section-renderer"] [role="button"]',
      '#description button',
      '#description [role="button"]',
    ];
    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const label = getElementLabel(el);
        const joined = `${label.text} ${label.aria} ${label.title}`.toLowerCase();
        if (joined.includes('show transcript') || joined === 'transcript') return el;
      }
    }
    return null;
  }

  function findTranscriptChipButton() {
    const panel = getTranscriptPanelElement({ visibleOnly: true });
    const roots = [panel, document].filter(Boolean);
    const selectors = [
      'button',
      '[role="button"]',
      '[role="tab"]',
      'yt-chip-cloud-chip-renderer',
      '[class*="chip"]',
    ];
    for (const root of roots) {
      const candidates = Array.from(root.querySelectorAll(selectors.join(',')));
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const label = getElementLabel(el);
        const joined = `${label.text} ${label.aria} ${label.title}`.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!joined) continue;
        if (joined.includes('show transcript') || joined.includes('close transcript')) continue;
        if (joined === 'transcript' || joined.startsWith('transcript,')) return el;
      }
    }
    return null;
  }

  function isTranscriptChipSelected(el) {
    if (!el) return false;
    const ariaPressed = (el.getAttribute('aria-pressed') || '').toLowerCase();
    const ariaSelected = (el.getAttribute('aria-selected') || '').toLowerCase();
    const classes = (el.className || '').toString().toLowerCase();
    const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    return ariaPressed === 'true' ||
      ariaSelected === 'true' ||
      classes.includes('selected') ||
      label.includes('selected');
  }

  async function activateTranscriptChipIfPresent() {
    const chip = findTranscriptChipButton();
    if (!chip || isTranscriptChipSelected(chip)) return false;
    clickElement(resolveClickable(chip));
    await sleep(500);
    return true;
  }

  function normalizeTranscriptText(text) {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function isTranscriptTimestampLike(text) {
    const normalized = normalizeTranscriptText(text).toLowerCase();
    if (!normalized) return false;
    return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(normalized) ||
      /^\d+\s+seconds?$/.test(normalized) ||
      /^\d+\s+minutes?(?:\s+\d+\s+seconds?)?$/.test(normalized) ||
      /^\d+\s+hours?(?:\s+\d+\s+minutes?)?(?:\s+\d+\s+seconds?)?$/.test(normalized);
  }

  function extractTranscriptTextFromSegment(seg) {
    if (!seg) return '';

    const explicitSelectors = [
      'yt-formatted-string#segment-text',
      '.segment-text',
      '#segment-text',
      '[class*="segment-text"]',
    ];
    for (const selector of explicitSelectors) {
      const candidates = Array.from(seg.querySelectorAll(selector));
      for (const el of candidates) {
        const text = normalizeTranscriptText(el.innerText || el.textContent);
        if (!text || isTranscriptTimestampLike(text)) continue;
        return text;
      }
    }

    const genericCandidates = Array.from(
      seg.querySelectorAll('yt-formatted-string, [id="text"], [class*="formatted-string"], span, div')
    )
      .map((el) => {
        const text = normalizeTranscriptText(el.innerText || el.textContent);
        if (!text || isTranscriptTimestampLike(text)) return null;
        const cls = (el.className || '').toString().toLowerCase();
        const id = (el.id || '').toLowerCase();
        const penalty =
          (cls.includes('timestamp') ? 100 : 0) +
          (cls.includes('start-offset') ? 100 : 0) +
          (id.includes('timestamp') ? 100 : 0);
        return {
          text,
          score: Math.max(0, text.length - penalty),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (genericCandidates.length > 0) {
      return genericCandidates[0].text;
    }

    const rawLines = (seg.innerText ?? seg.textContent ?? '')
      .split('\n')
      .map(normalizeTranscriptText)
      .filter(Boolean);
    const contentLines = rawLines.filter((line) => !isTranscriptTimestampLike(line));
    if (contentLines.length > 0) {
      return contentLines.join(' ');
    }

    return '';
  }

  function parseTranscriptFromDOM() {
    const lines = [];
    let wordCount = 0;
    const WORD_LIMIT = 10000;

    // Variant A: segment renderer rows — match by tag name only.
    // [class*="transcript-segment-renderer"] is avoided because Shady DOM adds
    // "style-scope ytd-transcript-segment-renderer" to CHILDREN of the segment,
    // causing the selector to match timestamp spans and other sub-elements too.
    const segmentNodes = document.querySelectorAll('ytd-transcript-segment-renderer');
    for (const seg of segmentNodes) {
      const text = extractTranscriptTextFromSegment(seg);
      if (!text) continue;

      const timestamp = readTranscriptTimestampFromSegment(seg);
      const startSeconds = parseTimestampToSeconds(timestamp);
      lines.push({
        text,
        startSeconds,
        timestamp: startSeconds != null ? formatTimecode(startSeconds) : timestamp,
      });
      wordCount += text.split(/\s+/).length;
      if (wordCount >= WORD_LIMIT) break;
    }

    // Variant B: parse transcript panel rendered text as timestamp/text pairs.
    // innerText (not textContent) pierces shadow DOM via layout rendering.
    if (!lines.length) {
      const panel = getTranscriptPanelElement({ visibleOnly: true });

      const panelText = (panel?.innerText ?? panel?.textContent ?? '').replace(/\u00a0/g, ' ').trim();
      if (panelText) {
        const rawLines = panelText
          .split('\n')
          .map(normalizeTranscriptText)
          .filter(Boolean);
        for (let i = 0; i < rawLines.length; i++) {
          if (!isTranscriptTimestampLike(rawLines[i])) continue;
          const text = rawLines[i + 1] || '';
          if (!text || isTranscriptTimestampLike(text)) continue;
          const startSeconds = parseTimestampToSeconds(rawLines[i]);
          lines.push({
            text,
            startSeconds,
            timestamp: startSeconds != null ? formatTimecode(startSeconds) : rawLines[i],
          });
          wordCount += text.split(/\s+/).length;
          if (wordCount >= WORD_LIMIT) break;
        }
      }
    }

    if (!lines.length) return null;

    const lang =
      document.querySelector('[class*="transcript-header-renderer"] #language-menu .yt-core-attributed-string') ||
      document.querySelector('[class*="transcript-header-renderer"] #title');

    return { language: lang?.textContent?.trim() || 'YouTube transcript', lines };
  }

  async function tryOpenTranscriptPanel() {
    if (parseTranscriptFromDOM()) return;

    if (hasTranscriptPanelVisible()) {
      await activateTranscriptChipIfPresent();
      if (parseTranscriptFromDOM()) return;
    }

    const directButton = findDedicatedTranscriptButton();
    if (directButton) {
      clickElement(resolveClickable(directButton));
      await sleep(700);
      await activateTranscriptChipIfPresent();
      if (parseTranscriptFromDOM()) return;
    }

    // Score transcript-related controls and try a few best candidates.
    const candidates = Array.from(
      document.querySelectorAll('button, [class*="paper-button"], [class*="button-renderer"], [class*="paper-item"], [class*="menu-service-item-renderer"]')
    )
      .map((el) => {
        const label = getElementLabel(el);
        const text = label.text.toLowerCase();
        const aria = label.aria.toLowerCase();
        const title = label.title.toLowerCase();
        const joined = `${text} ${aria} ${title}`;

        let score = -1;
        if (joined.includes('close transcript')) score = -1;
        else if (text === 'show transcript' || aria === 'show transcript' || title === 'show transcript') score = 100;
        else if (joined.includes('show transcript')) score = 80;
        else if (text === 'transcript' || aria === 'transcript' || title === 'transcript') score = 60;
        else if (joined.includes('transcript')) score = 40;

        if (score >= 0 && isVisible(el)) score += 10;
        return { el, label, score };
      })
      .filter((c) => c.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    if (!candidates.length) {
      // No transcript control found in the current view.
    } else {
      for (const c of candidates) {
        const target = resolveClickable(c.el);
        clickElement(target);
        await sleep(600);
        await activateTranscriptChipIfPresent();
        if (parseTranscriptFromDOM()) return;
      }
    }

    // Second pass: expand description/details, then re-try transcript controls.
    const showMore = findVisibleShowMoreButton();
    if (showMore) {
      clickElement(resolveClickable(showMore));
      await sleep(600);

      const retryCandidates = Array.from(
        document.querySelectorAll('button, [class*="paper-button"], [class*="button-renderer"], [class*="paper-item"], [class*="menu-service-item-renderer"]')
      )
        .map((el) => {
          const label = getElementLabel(el);
          const text = label.text.toLowerCase();
          const aria = label.aria.toLowerCase();
          const title = label.title.toLowerCase();
          const joined = `${text} ${aria} ${title}`;
          let score = -1;
          if (joined.includes('close transcript')) score = -1;
          else if (text === 'show transcript' || aria === 'show transcript' || title === 'show transcript') score = 100;
          else if (joined.includes('show transcript')) score = 80;
          else if (text === 'transcript' || aria === 'transcript' || title === 'transcript') score = 60;
          else if (joined.includes('transcript')) score = 40;
          if (score >= 0 && isVisible(el)) score += 10;
          return { el, label, score };
        })
        .filter((c) => c.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);

      for (const c of retryCandidates) {
        const target = resolveClickable(c.el);
        clickElement(target);
        await sleep(600);
        await activateTranscriptChipIfPresent();
        if (parseTranscriptFromDOM()) return;
      }
    }
  }

  async function fetchTranscriptFromDOMPanel() {
    let parsed = parseTranscriptFromDOM();
    if (parsed) return parsed;
    try {
      await tryOpenTranscriptPanel();
      // Panel may be visible but segments not yet rendered — poll until they appear.
      const deadline = Date.now() + YOUTUBE_TRANSCRIPT_DOM_POLL_MS;
      while (Date.now() < deadline) {
        await activateTranscriptChipIfPresent();
        parsed = parseTranscriptFromDOM();
        if (parsed) return parsed;
        await sleep(200);
      }
    } catch {}
    return null;
  }

  async function fetchCaptionEvents(baseUrl) {
    // Try json3 format first
    const json3Url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    let cf = await contentFetchText(json3Url);
    // If authenticated fetch returns empty, retry without credentials (URL may be signed for anonymous).
    if (!cf.text) cf = await contentFetchText(json3Url, { credentials: 'omit' });
    let text = cf.text;
    if (!text) text = await bgFetchText(json3Url);
    if (text && text.trimStart().startsWith('{')) {
      const data = JSON.parse(text);
      if (data.events?.length) return data.events;
    }
    if (text && text.trimStart().startsWith('<')) {
      const events = parseTranscriptXML(text);
      if (events.length) return events;
    }

    // Fallback: default XML format (no fmt param)
    cf = await contentFetchText(baseUrl);
    let xmlText = cf.text;
    if (!xmlText) xmlText = await bgFetchText(baseUrl);
    if (xmlText) return parseTranscriptXML(xmlText);

    return null;
  }

  function parseInnertubeTranscript(data) {
    try {
      // Navigate the innertube response to find cue groups
      const actions = data?.actions;
      if (!actions) return null;
      for (const action of actions) {
        const renderer = action?.updateEngagementPanelAction?.content?.transcriptRenderer;
        const body = renderer?.body?.transcriptBodyRenderer;
        if (!body?.cueGroups) continue;

        const lines = [];
        let wordCount = 0;
        const WORD_LIMIT = 10000;

        for (const group of body.cueGroups) {
          const groupRenderer = group?.transcriptCueGroupRenderer;
          const cues = groupRenderer?.cues;
          if (!cues) continue;
          for (const cue of cues) {
            const cr = cue?.transcriptCueRenderer;
            if (!cr) continue;
            const text = getTextFromRenderer(cr.cue).trim();
            if (!text) continue;

            let startSeconds = null;
            for (const msValue of [
              cr.startOffsetMs,
              cr.startMs,
              cr.startTimeMs,
              groupRenderer.startOffsetMs,
              groupRenderer.startMs,
              groupRenderer.startTimeMs,
            ]) {
              const ms = Number(msValue);
              if (Number.isFinite(ms)) {
                startSeconds = Math.max(0, Math.floor(ms / 1000));
                break;
              }
            }
            if (startSeconds == null) {
              startSeconds = parseTimestampToSeconds(
                getTextFromRenderer(cr.formattedStartOffset) ||
                getTextFromRenderer(groupRenderer.formattedStartOffset)
              );
            }

            lines.push({
              text,
              startSeconds,
              timestamp: startSeconds != null ? formatTimecode(startSeconds) : '',
            });
            wordCount += text.split(/\s+/).length;
            if (wordCount >= WORD_LIMIT) break;
          }
          if (wordCount >= WORD_LIMIT) break;
        }

        // Try to get language from the footer
        const langLabel = renderer?.footer?.transcriptFooterRenderer
          ?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems
          ?.find(i => i.selected)?.title || 'en';

        if (lines.length > 0) return { language: langLabel, lines };
      }
    } catch {}
    return null;
  }

  async function fetchYouTubeTranscript(playerResponse) {
    const videoId = new URLSearchParams(location.search).get('v');

    // Primary: innertube get_transcript endpoint (via background script)
    try {
      let clientVersion;
      let clientName = 'WEB';
      let apiKey;
      let visitorData;
      let transcriptParams;
      try {
        const ytcfgData = window.wrappedJSObject?.ytcfg?.data_;
        clientVersion = ytcfgData?.INNERTUBE_CLIENT_VERSION;
        clientName = ytcfgData?.INNERTUBE_CLIENT_NAME || 'WEB';
        apiKey = ytcfgData?.INNERTUBE_API_KEY;
        visitorData = ytcfgData?.VISITOR_DATA;
      } catch {}
      try {
        const initialData = await withTimeout(getYTInitialData(), 2000, null);
        transcriptParams = extractTranscriptParams(initialData);
      } catch {}

      const result = await withTimeout(
        browser.runtime.sendMessage({
          type: 'fetchYouTubeTranscript',
          videoId,
          clientVersion,
          clientName,
          apiKey,
          visitorData,
          transcriptParams,
          watchUrl: location.href,
          timeoutMs: YOUTUBE_TRANSCRIPT_PRIMARY_TIMEOUT_MS,
        }),
        YOUTUBE_TRANSCRIPT_PRIMARY_TIMEOUT_MS + 500,
        null
      );

      if (result?.data) {
        const transcript = parseInnertubeTranscript(result.data);
        if (transcript) return transcript;
      }
    } catch {}

    // Secondary fallback: timedtext API via caption track URLs. This is silent
    // and usually faster than opening YouTube's transcript panel.
    try {
      const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks?.length) {
        const chosen = chooseCaptionTrack(tracks);
        if (chosen?.baseUrl) {
          const events = await withTimeout(
            fetchCaptionEvents(chosen.baseUrl),
            YOUTUBE_TRANSCRIPT_CAPTION_TIMEOUT_MS + 1000,
            null
          );
          if (events?.length) return formatTranscriptEvents(events, chosen);
        }
      }
    } catch {}

    // Last fallback: parse transcript from YouTube's own DOM panel.
    try {
      const domTranscript = await withTimeout(
        fetchTranscriptFromDOMPanel(),
        YOUTUBE_TRANSCRIPT_DOM_TIMEOUT_MS,
        null
      );
      if (domTranscript) return domTranscript;
    } catch {}

    return null;
  }

  function formatTranscriptEvents(events, chosen) {
    const lines = [];
    let wordCount = 0;
    const WORD_LIMIT = 10000;

    for (const event of events) {
      if (!event.segs) continue;
      const text = event.segs.map(s => s.utf8 || '').join('').trim();
      if (!text) continue;

      const startSeconds = Number.isFinite(Number(event.tStartMs))
        ? Math.max(0, Math.floor(Number(event.tStartMs) / 1000))
        : null;
      lines.push({
        text,
        startSeconds,
        timestamp: startSeconds != null ? formatTimecode(startSeconds) : '',
      });

      wordCount += text.split(/\s+/).length;
      if (wordCount >= WORD_LIMIT) break;
    }

    const language = chosen.name?.simpleText || chosen.languageCode || 'unknown';
    return { language, lines };
  }

  function extractYouTubeComments() {
    const comments = [];
    try {
      const threads = document.querySelectorAll('[class*="comment-thread-renderer"]');
      for (const thread of threads) {
        if (comments.length >= 30) break;
        const authorEl = thread.querySelector('#author-text span');
        const textEl = thread.querySelector('#content-text');
        if (!textEl) continue;
        const author = authorEl?.textContent?.trim() || 'Unknown';
        const text = textEl.textContent.trim();
        if (text) comments.push({ author, text });
      }
    } catch {}
    return comments;
  }

  function buildYouTubeTextContent(meta, description, transcript, comments) {
    const lines = [];

    lines.push(`# ${meta.title}`);
    lines.push('');
    lines.push('## Video Info');
    if (meta.channel) lines.push(`- **Channel:** ${meta.channel}`);
    if (meta.publishDate) lines.push(`- **Published:** ${meta.publishDate}`);
    if (meta.viewCount) {
      const formatted = Number(meta.viewCount).toLocaleString();
      lines.push(`- **Views:** ${formatted}`);
    }
    if (meta.videoId) lines.push(`- **Video ID:** ${meta.videoId}`);
    lines.push('');

    lines.push('## Description');
    lines.push(description || '*No description available.*');
    lines.push('');

    if (transcript && transcript.lines.length > 0) {
      lines.push(`## Transcript (${transcript.language})`);
      if (meta.videoId) {
        lines.push(`Timestamp URL format: https://www.youtube.com/watch?v=${encodeURIComponent(meta.videoId)}&t=SECONDSs`);
      }
      lines.push('Transcript lines include compact timecodes and t=SECONDS markers when timing is available.');
      for (const line of transcript.lines) {
        const formattedLine = formatTranscriptContextLine(line);
        if (formattedLine) lines.push(formattedLine);
      }
    } else {
      lines.push('## Transcript');
      lines.push('*No transcript available.*');
    }
    lines.push('');

    if (comments.length > 0) {
      lines.push('## Comments');
      for (const c of comments) {
        lines.push(`**@${c.author}:** ${c.text}`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  async function distillYouTube(options = {}) {
    const playerResponse = await getYTInitialPlayerResponse();
    const meta = extractYouTubeMetadata(playerResponse);
    const description = extractYouTubeDescription(playerResponse);
    const transcript = await fetchYouTubeTranscript(playerResponse);
    const comments = extractYouTubeComments();

    let textContent = buildYouTubeTextContent(meta, description, transcript, comments);
    let technicalContext = null;
    const limits = [];
    if (options.includeTechnicalContext) {
      const technical = await buildTechnicalContextSection();
      textContent += `\n\n${technical.sectionText}`;
      technicalContext = technical.data;
      if (Array.isArray(technical.limits?.details)) limits.push(...technical.limits.details);
    }
    const wordCount = textContent.split(/\s+/).filter(Boolean).length;

    return {
      title: meta.title,
      url: location.href,
      description: description.substring(0, 300),
      textContent,
      wordCount,
      technicalContext,
      contextLimits: {
        applied: limits.length > 0,
        details: limits,
      },
    };
  }

  // ── Generic extraction ─────────────────────────────────────────────

  async function distill(options = {}) {
    if (isYouTubeWatchPage()) return distillYouTube(options);

    const mainDocContent = extractMainContentFromDocument(document);
    const includeIframes = options.includeIframes !== false;
    const iframeResult = includeIframes
      ? extractAccessibleIframeContent()
      : { content: { headings: [], paragraphs: [], images: [], links: [], lists: [], tables: [], codeBlocks: [] }, limits: [] };
    const iframeContent = iframeResult.content;
    const limits = [...iframeResult.limits];

    const title = document.title || '';
    const url = document.location.href;
    const metaDesc = document.querySelector('meta[name="description"]');
    const description = metaDesc ? metaDesc.getAttribute('content') || '' : '';

    const commentResult = extractComments();

    const data = {
      title,
      url,
      description,
      headings: uniqueBy([...mainDocContent.headings, ...iframeContent.headings], (h) => `${h.level}|${h.text}`),
      paragraphs: limitArray(
        uniqueBy([...mainDocContent.paragraphs, ...iframeContent.paragraphs], (p) => p),
        400,
        'paragraphs',
        limits
      ),
      images: uniqueBy([...mainDocContent.images, ...iframeContent.images], (img) => `${img.src}|${img.alt}|${img.caption}`),
      links: limitArray(
        uniqueBy([...mainDocContent.links, ...iframeContent.links], (l) => l.href),
        250,
        'links',
        limits
      ),
      lists: uniqueBy([...mainDocContent.lists, ...iframeContent.lists], (l) => `${l.type}|${l.items.join('|')}`),
      tables: limitArray(
        uniqueBy([...mainDocContent.tables, ...iframeContent.tables], (t) => JSON.stringify(t)),
        80,
        'tables',
        limits
      ),
      codeBlocks: limitArray(
        uniqueBy([...mainDocContent.codeBlocks, ...iframeContent.codeBlocks], (b) => b),
        150,
        'code blocks',
        limits
      ),
      comments: limitArray(
        commentResult.comments || [],
        120,
        'comments',
        limits
      ),
      forms: limitArray(
        extractFormState(findMainContent(document.body)),
        120,
        'form fields',
        limits
      ),
    };
    limits.push(...(commentResult.limits || []));

    const liveRoot = findMainContent(document.body);
    const built = buildTextContentWithSources(data, { liveRoot });
    let textContent = built.textContent;
    let technicalContext = null;
    if (options.includeTechnicalContext) {
      const technical = await buildTechnicalContextSection();
      textContent += `\n\n${technical.sectionText}`;
      technicalContext = technical.data;
      if (Array.isArray(technical.limits?.details)) limits.push(...technical.limits.details);
    }
    const wordCount = textContent.split(/\s+/).filter(Boolean).length;

    return {
      title,
      url,
      description,
      textContent,
      wordCount,
      sourceAnchors: built.sourceAnchors || {},
      comments: data.comments,
      technicalContext,
      contextLimits: {
        applied: limits.length > 0,
        details: limits,
      },
    };
  }

  // Listen for distill requests from background/sidebar
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'distill') {
      return distill(message.options || {}).catch(err => ({
        title: document.title || '',
        url: document.location.href,
        description: '',
        textContent: '',
        wordCount: 0,
        error: err.message,
      }));
    }
    if (message.type === 'seekYouTubeVideo') {
      return seekCurrentYouTubeVideo(message.seconds, message.url || '');
    }
    if (message.type === 'scrollToSource') {
      const selector = String(message.selector || '');
      const snippet = String(message.snippet || '').trim();
      const occurrence = Math.max(1, Number(message.occurrence) || 1);
      if (!selector && !snippet) return { ok: false, error: 'missing selector/snippet' };
      let el = null;
      if (selector) {
        try {
          el = document.querySelector(selector);
        } catch {
          // fall through to snippet lookup
        }
      }
      if (!el && snippet) {
        const root = findMainContent(document.body);
        const target = snippet.replace(/\s+/g, ' ').trim().toLowerCase();
        const exactCandidates = [];
        const targetWords = target.split(/\s+/).filter((w) => w.length >= 4);
        const scoreCandidate = (candidateText) => {
          const text = candidateText.replace(/\s+/g, ' ').trim().toLowerCase();
          if (!text) return -1;
          if (text === target) return 1000;
          if (text.includes(target) && target.length >= 24) return 900;
          if (target.includes(text) && text.length >= 24) return 700;
          if (target.length < 8) return -1;
          let overlap = 0;
          for (const w of targetWords) {
            if (text.includes(w)) overlap += 1;
          }
          if (overlap === 0) return -1;
          const ratio = overlap / Math.max(1, targetWords.length);
          const lenPenalty = Math.abs(text.length - target.length) / Math.max(target.length, 1);
          return Math.round(ratio * 500 - lenPenalty * 80);
        };
        const candidates = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,li,tr,pre,code,a,img'));
        let best = null;
        let bestScore = -1;
        for (const node of candidates) {
          const raw = node.tagName === 'IMG'
            ? (node.getAttribute('alt') || '')
            : (node.textContent || '');
          const normalized = raw.replace(/\s+/g, ' ').trim().toLowerCase();
          if (normalized === target) exactCandidates.push(node);
          const score = scoreCandidate(raw);
          if (score > bestScore) {
            bestScore = score;
            best = node;
          }
        }
        if (exactCandidates.length > 0) {
          const idx = Math.min(exactCandidates.length - 1, occurrence - 1);
          el = exactCandidates[idx];
        } else if (best && bestScore >= 120) {
          el = best;
        }
      }
      if (!el) return { ok: false, error: 'not found' };
      try {
        const rect = el.getBoundingClientRect();
        const targetTop = Math.max(0, rect.top + window.scrollY - Math.round(window.innerHeight * 0.35));
        window.scrollTo({ top: targetTop, behavior: 'smooth' });
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const prevOutline = el.style.outline;
        const prevOffset = el.style.outlineOffset;
        const prevTransition = el.style.transition;
        el.style.outline = '2px solid #f59e0b';
        el.style.outlineOffset = '2px';
        el.style.transition = 'outline 0.2s ease';
        setTimeout(() => {
          el.style.outline = prevOutline;
          el.style.outlineOffset = prevOffset;
          el.style.transition = prevTransition;
        }, 1800);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err?.message || 'scroll failed' };
      }
    }
  });
})();
