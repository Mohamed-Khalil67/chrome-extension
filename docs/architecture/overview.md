# Frontend Lens — System Architecture

## Overview
Frontend Lens is a streamlined developer tool built for **Chrome DevTools (Manifest V3)** using **pure TypeScript and native HTML/CSS/DOM APIs**.

It is designed around two clean, focused screens:
1. **Monitor**: Automatically inspects application network traffic, latencies, payloads, headers, response bodies, and JavaScript runtime errors in the inspected tab.
2. **API Client**: A simple Postman-like multi-tab request builder with collections, environments (`{{baseUrl}}`), and history.

```
+------------------------------------------------------------------------+
| Chrome DevTools Window                                                 |
|                                                                        |
|  +------------------------------------------------------------------+  |
|  | DevTools Page (devtools.html / devtools.ts)                      |  |
|  | Registers "Frontend Lens" Panel & Subscribes to Network Events   |  |
|  +------------------------------------------------------------------+  |
|                                |                                       |
|                                v                                       |
|  +------------------------------------------------------------------+  |
|  | Frontend Lens Panel (panel.html / panel.ts)                      |  |
|  |                                                                  |  |
|  |  +-----------------------------+  +---------------------------+  |  |
|  |  | [1] Monitor                 |  | [2] API Client            |  |  |
|  |  | - Tab-bound (tabId)         |  | - Multi-tab requests      |  |  |
|  |  | - Network HAR + getContent  |  | - GET/POST/PUT/PATCH/DEL  |  |  |
|  |  | - Status classification     |  | - Headers, Params, Body   |  |  |
|  |  | - Pretty JSON response view |  | - Environments ({{var}})  |  |  |
|  |  | - Simple JS errors list     |  | - History & Collections   |  |  |
|  |  | - "Open in API Client"      |  | - Response Pretty JSON    |  |  |
|  |  +-----------------------------+  +---------------------------+  |  |
|  |                                                 |                |  |
|  +-------------------------------------------------|----------------+  |
|                                                    v                   |
|                                           +------------------+         |
|                                           | IndexedDB Store  |         |
|                                           +------------------+         |
+------------------------------------------------------------------------+
```

## Technical Decisions
- **Zero UI Frameworks**: Pure TypeScript, native HTML5, and modern CSS. Fast loading (< 60 KB bundle), instant startup.
- **Tab Isolation**: Network monitoring belongs strictly to `chrome.devtools.inspectedWindow.tabId`.
- **Dual Execution Engine**:
  - *Inspected Page Mode*: Dispatched via `chrome.devtools.inspectedWindow.eval`, adopting active session cookies and page origin.
  - *Extension Context Mode*: Dispatched directly via extension `fetch()`.
