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

  function buildTextContent(data) {
    const lines = [];

    lines.push(`# ${data.title}`);
    lines.push(`URL: ${data.url}`);
    if (data.description) lines.push(`Description: ${data.description}`);
    lines.push('');

    for (const h of data.headings) {
      lines.push(`${'#'.repeat(h.level)} ${h.text}`);
    }
    if (data.headings.length > 0) lines.push('');

    for (const p of data.paragraphs) {
      lines.push(p);
      lines.push('');
    }

    if (data.lists.length > 0) {
      for (const list of data.lists) {
        for (const item of list.items) {
          lines.push(`- ${item}`);
        }
        lines.push('');
      }
    }

    if (data.tables.length > 0) {
      for (const table of data.tables) {
        for (const row of table) {
          lines.push(`| ${row.join(' | ')} |`);
        }
        lines.push('');
      }
    }

    if (data.codeBlocks.length > 0) {
      for (const block of data.codeBlocks) {
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
        lines.push(`- [${img.alt}]${cap}`);
      }
      lines.push('');
    }

    if (data.links.length > 0) {
      lines.push('Links:');
      for (const link of data.links.slice(0, 30)) {
        lines.push(`- [${link.text}](${link.href})`);
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

    return lines.join('\n');
  }

  function distill() {
    const clone = document.body.cloneNode(true);
    removeNoise(clone);
    const mainContent = findMainContent(clone);

    const title = document.title || '';
    const url = document.location.href;
    const metaDesc = document.querySelector('meta[name="description"]');
    const description = metaDesc ? metaDesc.getAttribute('content') || '' : '';

    const data = {
      title,
      url,
      description,
      headings: extractHeadings(mainContent),
      paragraphs: extractParagraphs(mainContent),
      images: extractImages(mainContent),
      links: extractLinks(mainContent),
      lists: extractLists(mainContent),
      tables: extractTables(mainContent),
      codeBlocks: extractCodeBlocks(mainContent),
      comments: extractComments(),
    };

    const textContent = buildTextContent(data);
    const wordCount = textContent.split(/\s+/).filter(Boolean).length;

    return {
      title,
      url,
      description,
      textContent,
      wordCount,
    };
  }

  // Listen for distill requests from background/sidebar
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'distill') {
      try {
        const result = distill();
        return Promise.resolve(result);
      } catch (err) {
        return Promise.resolve({
          title: document.title || '',
          url: document.location.href,
          description: '',
          textContent: '',
          wordCount: 0,
          error: err.message,
        });
      }
    }
  });
})();
