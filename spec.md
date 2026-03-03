# Firefox AI Sidebar — Specification

## Goal

A Firefox extension that opens a sidebar with an AI chat interface. The user can converse with any configured AI provider (Claude, OpenAI, Grok, or a local LLM) using the current page's content as context. The page content is distilled into a clean, structured representation before being sent to the model.

---

## Feature Breakdown

### 1. Sidebar Chat UI

- Opens via browser action button (toolbar icon) or keyboard shortcut.
- Adapts to the user's current Firefox theme (light/dark) using `prefers-color-scheme` and Firefox CSS variables.
- **Two states:**
  - **Welcome state** (no conversation yet) — shows the page title/URL, the quick-action buttons prominently as large clickable cards, and the text input. This is the landing experience; the action buttons serve as suggested first interactions.
  - **Chat state** (after first message) — switches to a standard chat view with message list, streaming AI response, and input area. Quick-action buttons collapse into a compact bar above the input.
- Markdown rendering in AI responses (code blocks, lists, bold/italic, links).
- Streaming token display as the AI responds.

### 2. AI Provider Support

Four provider types, all accessed through a unified adapter interface:

| Provider | API Style | Auth |
|----------|-----------|------|
| Claude (Anthropic) | REST, streaming via SSE | API key |
| OpenAI | REST, streaming via SSE | API key |
| Grok (xAI) | OpenAI-compatible REST | API key |
| LM Studio (local) | OpenAI-compatible REST on localhost | None |

- User selects the active provider in settings.
- Each provider has its own configuration (key, model name, optional base URL).
- LM Studio: auto-detect on `localhost:1234` by default; user can override host/port.
- All providers implement a common interface: `sendMessage(messages[], options) → AsyncIterable<string>`.

### 3. Page Context Distillation

When the user opens the sidebar (or presses "Analyze"), the extension extracts a structured representation of the current page:

**Extracted elements:**
- Title, URL, meta description
- Headings (h1–h6) with hierarchy preserved
- Paragraphs and body text
- Emphasized text (bold, italic, marks)
- Images (src, alt text, caption if available)
- Links (href, anchor text) — grouped into content links vs. navigation links
- Lists (ordered/unordered)
- Tables
- Code blocks

**Removed:**
- Ads and ad containers (heuristic: common ad selectors, `aria-label`, known ad domains in iframes)
- Cookie banners / consent dialogs
- Navigation menus, headers, footers (extracted separately as "navigation structure")
- Social share buttons
- Tracking pixels and hidden elements

**Output format:** A structured object (not raw HTML) that serializes to a compact text representation for the AI prompt. This keeps token usage low while preserving document structure.

### 4. Quick-Action Buttons

A bar of pre-configured buttons that inject a prompt template into the chat with the page context attached.

**Architecture:** Buttons are defined as an array of action descriptors:

```js
{
  id: "analyze",
  label: "Analyze",
  icon: "search",           // icon identifier
  prompt: "Analyze this page. Provide a structured summary covering: main topic, key arguments or information presented, intended audience, and any notable bias or perspective. Be concise.",
  includeContext: true,      // attach distilled page content
  contextScope: "full",     // "full" | "selection" | "visible"
}
```

**Default buttons:**
- **Analyze** — full-page analysis and summary
- **Summarize** — concise summary (TL;DR)
- **Key Points** — bullet-point extraction
- **Explain** — explain the page in simple terms

Users cannot edit these in Phase 1 (future: custom buttons via settings).

### 5. Settings

Stored via `browser.storage.sync` (synced across devices via Firefox Account) with `browser.storage.local` as fallback for large data.

**Settings schema:**
- `activeProvider`: enum — which provider to use
- `providers.claude`: `{ apiKey, model }` — default model: `claude-sonnet-4-20250514`
- `providers.openai`: `{ apiKey, model }` — default model: `gpt-4o`
- `providers.grok`: `{ apiKey, model }` — default model: `grok-3`
- `providers.lmstudio`: `{ endpoint, model }` — default endpoint: `http://localhost:1234`
- `ui.theme`: `"auto"` | `"light"` | `"dark"` — default: `"auto"`

Settings page accessible from the sidebar (gear icon) and from the extension's options page.

**Security:** API keys stored in `browser.storage.sync` are encrypted at rest by Firefox's storage backend. Keys are never sent anywhere except to the respective provider's API endpoint.

---

## Technical Specifics

### Extension Manifest (Manifest V3)

```json
{
  "manifest_version": 3,
  "permissions": [
    "activeTab",
    "storage",
    "sidebarAction"
  ],
  "host_permissions": [
    "http://localhost/*"
  ],
  "sidebar_action": {
    "default_panel": "sidebar/sidebar.html",
    "default_title": "AI Chat",
    "default_icon": "icons/icon-48.png"
  },
  "background": {
    "scripts": ["background/background.js"],
    "type": "module"
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content/distill.js"],
    "run_at": "document_idle"
  }],
  "options_ui": {
    "page": "options/options.html"
  }
}
```

### Communication Flow

```
┌─────────────┐     sendMessage      ┌──────────────┐     API call      ┌──────────────┐
│  Sidebar UI │ ──────────────────►  │  Background  │ ───────────────► │ AI Provider  │
│  (panel)    │ ◄──────────────────  │   Script     │ ◄─────────────── │   (remote/   │
│             │   stream tokens      │              │   SSE stream     │    local)    │
└─────────────┘                      └──────────────┘                  └──────────────┘
       │                                    │
       │      requestDistill                │
       │ ──────────────────────────►        │
       │                              ┌─────┴──────┐
       │ ◄────────────────────────    │  Content   │
       │      distilled content       │  Script    │
       │                              │ (distill)  │
       │                              └────────────┘
```

1. **Sidebar** sends user message + page context to **Background** via `browser.runtime.sendMessage`.
2. **Background** routes to the correct AI provider adapter, streams response back via a `Port` connection.
3. **Content script** (`distill.js`) runs on page load, exposes a message handler; sidebar requests distilled content on demand via background as relay.

### File Structure

```
firefox-ai/
├── manifest.json
├── background/
│   ├── background.js          # message router, provider orchestration
│   └── providers/
│       ├── base.js            # abstract provider interface
│       ├── claude.js
│       ├── openai.js          # also used by Grok and LM Studio
│       └── lmstudio.js
├── content/
│   └── distill.js             # page content extraction
├── sidebar/
│   ├── sidebar.html
│   ├── sidebar.js             # chat logic, UI state
│   ├── sidebar.css
│   ├── components/
│   │   ├── message.js         # message rendering (markdown)
│   │   └── actions.js         # quick-action buttons
│   └── lib/
│       └── markdown.js        # lightweight markdown→HTML
├── options/
│   ├── options.html
│   └── options.js
├── shared/
│   ├── settings.js            # read/write settings from storage
│   ├── actions.js             # action button definitions
│   └── constants.js
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── spec.md
```

### Technology Choices

- **No build step.** Plain ES modules (`type: "module"` in background, `<script type="module">` in sidebar/options). Firefox MV3 supports this natively.
- **No frameworks.** Vanilla JS + DOM API for the sidebar UI. Keeps the extension lightweight and avoids bundler complexity.
- **Markdown rendering.** Minimal custom parser or a tiny library (e.g., marked, ~28KB) loaded locally. No CDN dependencies.
- **CSS.** Single stylesheet per page. Uses Firefox's `--lwt-*` CSS variables for theme integration and `prefers-color-scheme` media query.

---

## Development Plan

### Phase 1 — Core (MVP)

1. **Scaffold** — manifest.json, file structure, icons, extension loads in Firefox.
2. **Settings** — options page with provider configuration, `browser.storage.sync` read/write.
3. **Content distillation** — content script that extracts structured page data on demand.
4. **Provider adapters** — implement the unified interface for all four providers with streaming.
5. **Sidebar UI** — chat interface, message display with markdown, input handling, streaming display.
6. **Quick actions** — action button bar with the four default actions wired up.
7. **Integration & polish** — theme adaptation, error handling, loading states, keyboard shortcut.

### Phase 2 — Persistence & History

- Chat history persisted per URL in `browser.storage.local`.
- History panel: searchable list of previously chatted URLs.
- Resume conversation when revisiting a page.
- Storage management (size limits, cleanup of old entries).

### Phase 3 — Extensibility

- User-defined custom action buttons via settings.
- Additional local LLM backends (Ollama, llama.cpp server).
- Text selection context mode (chat about highlighted text only).
- Export conversation (copy, download as markdown).
