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
    'form', 'button', 'input', 'select', 'textarea',
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

  /**
   * Extract comments from the live document.
   * Handles: same-origin comment iframes (XenForo, Disqus, etc.)
   * and inline comment sections.
   */
  function extractComments() {
    const comments = [];

    // 1. Try same-origin comment iframes on the live document
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument;
          if (!doc || !doc.body) continue;
          const src = iframe.src || '';
          const container = iframe.parentElement;
          const cid = (container?.id || '') + ' ' + (container?.className || '');
          const looksLikeComments =
            src.includes('comment') || src.includes('forum') ||
            src.includes('civis') || src.includes('discuss') ||
            src.includes('thread') || cid.includes('comment') ||
            cid.includes('forum') || cid.includes('thread');
          if (!looksLikeComments) continue;

          // Try specific selectors for common forum/comment systems
          const selectors = [
            '.message-body .bbWrapper', // XenForo
            '.message-body', '.comment-body', '.comment-content',
            '.comment-text', '.post-body', '.reply-body',
          ];
          for (const sel of selectors) {
            const els = doc.querySelectorAll(sel);
            if (els.length > 0) {
              for (const el of els) {
                const text = el.textContent.trim();
                if (text.length > 10) comments.push(text);
              }
              break;
            }
          }
          // Fallback: paragraphs from the iframe
          if (comments.length === 0) {
            const ps = doc.querySelectorAll('article p, .message p, p');
            for (const p of ps) {
              const text = p.textContent.trim();
              if (text.length > 20) comments.push(text);
            }
          }
        } catch {
          // Cross-origin iframe — skip
        }
      }
    } catch {}

    // 2. Inline comments (not in iframes)
    if (comments.length === 0) {
      const inlineSelectors = [
        '#comments .comment-body', '#comments .comment-content',
        '.comments .comment-body', '.comments .comment-content',
        '.comment-list .comment-text', '#disqus_thread .post-body',
      ];
      for (const sel of inlineSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            for (const el of els) {
              const text = el.textContent.trim();
              if (text.length > 10) comments.push(text);
            }
            break;
          }
        } catch {}
      }
    }

    // Cap to avoid massive context
    return comments.slice(0, 50);
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
      lines.push('## User Comments');
      lines.push('');
      for (const comment of data.comments) {
        lines.push(comment);
        lines.push('');
      }
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
    const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`);
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

  /**
   * Fetch a URL via the background script as fallback.
   */
  async function bgFetchText(url) {
    try {
      const result = await browser.runtime.sendMessage({ type: 'fetchText', url });
      return result?.text || '';
    } catch {
      return '';
    }
  }

  async function contentFetchText(url) {
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
      });
      const text = await resp.text();
      return { text: text || '', status: resp.status || 0 };
    } catch {
      return { text: '', status: 0 };
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

  function logTranscriptCandidates() {
    try {
      const selectors = [
        'button',
        '[class*="paper-button"]',
        '[class*="button-renderer"]',
        '[class*="paper-item"]',
        '[class*="menu-service-item-renderer"]',
      ];
      const all = Array.from(document.querySelectorAll(selectors.join(',')));
      const matches = all
        .map(el => ({ el, label: getElementLabel(el) }))
        .filter(({ label }) => {
          const joined = `${label.text} ${label.aria} ${label.title}`.toLowerCase();
          return joined.includes('transcript') || joined.includes('caption') || joined.includes('show');
        })
        .slice(0, 30);

      // Intentionally no-op in production; kept for optional local debugging.
      void matches;
    } catch (err) {
      void err;
    }
  }

  function parseTranscriptFromDOM() {
    const lines = [];
    let wordCount = 0;
    const WORD_LIMIT = 10000;

    // Variant A: classic segment renderer rows.
    const segmentNodes = document.querySelectorAll('[class*="transcript-segment-renderer"]');
    for (const seg of segmentNodes) {
      const textEl = seg.querySelector('.segment-text, #segment-text, [class*="segment-text"], [id="message"], [id="text"], [class*="formatted-string"]');
      const text = textEl?.textContent?.trim() || '';
      if (!text) continue;

      lines.push(text);
      wordCount += text.split(/\s+/).length;
      if (wordCount >= WORD_LIMIT) break;
    }

    // Variant B: parse transcript panel text as timestamp/text pairs.
    if (!lines.length) {
      const panel =
        document.querySelector('[target-id*="transcript"]') ||
        document.querySelector('[class*="transcript-search-panel-renderer"]') ||
        document.querySelector('[class*="transcript-renderer"]');

      const panelText = panel?.textContent?.replace(/\u00a0/g, ' ').trim() || '';
      if (panelText) {
        const rawLines = panelText
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean);
        const tsRe = /^\d{1,2}:\d{2}(?::\d{2})?$/;
        for (let i = 0; i < rawLines.length; i++) {
          if (!tsRe.test(rawLines[i])) continue;
          const text = rawLines[i + 1] || '';
          if (!text || tsRe.test(text)) continue;
          lines.push(text);
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
    // If already rendered, no need to click anything.
    if (document.querySelector('[class*="transcript-segment-renderer"]')) return;

    logTranscriptCandidates();

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
      .slice(0, 5);

    if (!candidates.length) {
      // No transcript control found in the current view.
    } else {
      for (const c of candidates) {
        const target = resolveClickable(c.el);
        clickElement(target);
        await sleep(900);

        const panelVisible = !!document.querySelector(
          '[target-id*="transcript"], [class*="transcript-renderer"], [class*="transcript-search-panel-renderer"]'
        );
        const segCount = document.querySelectorAll('[class*="transcript-segment-renderer"]').length;
        if (panelVisible || segCount > 0) return;
      }
    }

    // Second pass: expand description/details, then re-try transcript controls.
    const showMore = findVisibleShowMoreButton();
    if (showMore) {
      clickElement(resolveClickable(showMore));
      await sleep(600);
      logTranscriptCandidates();

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
        .slice(0, 5);

      for (const c of retryCandidates) {
        const target = resolveClickable(c.el);
        clickElement(target);
        await sleep(900);
        const panelVisible = !!document.querySelector(
          '[class*="engagement-panel-section-list-renderer"][target-id*="transcript"], [class*="transcript-renderer"], [class*="transcript-search-panel-renderer"]'
        );
        const segCount = document.querySelectorAll('[class*="transcript-segment-renderer"]').length;
        if (panelVisible || segCount > 0) return;
      }
    }
  }

  async function fetchTranscriptFromDOMPanel() {
    let parsed = parseTranscriptFromDOM();
    if (parsed) return parsed;
    try {
      await tryOpenTranscriptPanel();
      parsed = parseTranscriptFromDOM();
      if (parsed) return parsed;
    } catch {}
    return null;
  }

  async function fetchCaptionEvents(baseUrl) {
    // Try json3 format first
    const json3Url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    let cf = await contentFetchText(json3Url);
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
          const cues = group?.transcriptCueGroupRenderer?.cues;
          if (!cues) continue;
          for (const cue of cues) {
            const cr = cue?.transcriptCueRenderer;
            if (!cr) continue;
            const text = (cr.cue?.simpleText || '').trim();
            if (!text) continue;

            lines.push(text);
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
      try {
        const ytcfgData = window.wrappedJSObject?.ytcfg?.data_;
        clientVersion = ytcfgData?.INNERTUBE_CLIENT_VERSION;
        clientName = ytcfgData?.INNERTUBE_CLIENT_NAME || 'WEB';
        apiKey = ytcfgData?.INNERTUBE_API_KEY;
      } catch {}

      const result = await browser.runtime.sendMessage({
        type: 'fetchYouTubeTranscript',
        videoId,
        clientVersion,
        clientName,
        apiKey,
      });

      if (result?.data) {
        const transcript = parseInnertubeTranscript(result.data);
        if (transcript) return transcript;
      }
    } catch {}

    // Secondary fallback: parse transcript from YouTube's own DOM panel.
    try {
      const domTranscript = await fetchTranscriptFromDOMPanel();
      if (domTranscript) return domTranscript;
    } catch {}

    // Fallback: timedtext API via caption track URLs
    try {
      const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks?.length) {
        const chosen = chooseCaptionTrack(tracks);
        if (chosen?.baseUrl) {
          const events = await fetchCaptionEvents(chosen.baseUrl);
          if (events?.length) return formatTranscriptEvents(events, chosen);
        }
      }
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

      lines.push(text);

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
      for (const line of transcript.lines) {
        lines.push(line);
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

  async function distillYouTube() {
    const playerResponse = await getYTInitialPlayerResponse();
    const meta = extractYouTubeMetadata(playerResponse);
    const description = extractYouTubeDescription(playerResponse);
    const transcript = await fetchYouTubeTranscript(playerResponse);
    const comments = extractYouTubeComments();

    const textContent = buildYouTubeTextContent(meta, description, transcript, comments);
    const wordCount = textContent.split(/\s+/).filter(Boolean).length;

    return {
      title: meta.title,
      url: location.href,
      description: description.substring(0, 300),
      textContent,
      wordCount,
      contextLimits: {
        applied: false,
        details: [],
      },
    };
  }

  // ── Generic extraction ─────────────────────────────────────────────

  async function distill(options = {}) {
    if (isYouTubeWatchPage()) return distillYouTube();

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
      comments: extractComments(),
    };

    const liveRoot = findMainContent(document.body);
    const built = buildTextContentWithSources(data, { liveRoot });
    const textContent = built.textContent;
    const wordCount = textContent.split(/\s+/).filter(Boolean).length;

    return {
      title,
      url,
      description,
      textContent,
      wordCount,
      sourceAnchors: built.sourceAnchors || {},
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
