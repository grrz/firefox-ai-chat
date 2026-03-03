# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Firefox browser extension (WebExtension / Manifest V3).

## Key References

- Manifest V3 docs: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions
- Firefox-specific APIs use the `browser.*` namespace (not `chrome.*`). The `browser.*` API returns Promises natively; no need for callback patterns.

## Development

### Loading the extension for development
```
about:debugging#/runtime/this-firefox → "Load Temporary Add-on" → select manifest.json
```

### Packaging
```
cd <extension-root> && zip -r ../extension.zip . -x '.*' -x '__MACOSX'
```

### Linting
```
npx web-ext lint
```

### Running with auto-reload
```
npx web-ext run
```

## Architecture Notes

- `manifest.json` — extension manifest (permissions, content scripts, background scripts, browser action)
- Background scripts run as service workers in MV3 (`"background": {"scripts": [...], "type": "module"}`)
- Content scripts are injected into web pages and communicate with background via `browser.runtime.sendMessage` / `browser.runtime.onMessage`
- Popup UI (if any) lives under `browser_action.default_popup` in manifest

## Firefox-Specific Conventions

- Use `browser_specific_settings.gecko.id` in manifest.json for AMO submission
- Firefox MV3 still supports persistent background pages (event pages) unlike Chrome
- `browser.storage.local` for extension-local storage; `browser.storage.sync` for cross-device sync
