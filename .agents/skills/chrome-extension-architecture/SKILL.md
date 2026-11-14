---
name: chrome-extension-architecture
description: Guide for developing Manifest V3 Chrome extensions with custom DevTools panels, content scripts, and background service workers.
---

# Chrome Extension Architecture

## Contexts & Communication
- **DevTools Page (`devtools.html`)**: Lives as long as DevTools is open. Creates panels using `chrome.devtools.panels.create()`.
- **Panel Window (`panel.html`)**: The full UI window loaded inside the DevTools tab. Receives tab events and renders user interface.
- **Inspected Window (`chrome.devtools.inspectedWindow`)**:
  - `tabId`: Identifies inspected page.
  - `eval(expression, callback)`: Runs JavaScript inside the inspected page context.
- **Content Scripts**: Injected into web pages, runs in an isolated world with direct DOM access.
- **Service Worker (`background.js`)**: Event-driven background coordinator.

## Key APIs
- `chrome.devtools.network.onRequestFinished.addListener((request) => ...)`
- `request.getContent((body, encoding) => ...)`
- `chrome.devtools.inspectedWindow.eval(...)`
