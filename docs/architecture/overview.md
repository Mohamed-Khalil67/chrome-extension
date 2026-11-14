# Frontend Lens — System Architecture

## Overview
Frontend Lens is a dual-purpose developer tool built as a Chrome DevTools extension (Manifest V3) using pure TypeScript and native web technologies.

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
|  |  | [1] Frontend Debugger       |  | [2] API Client Workspace  |  |  |
|  |  | - Tab-bound (tabId)         |  | - Reusable Postman-like   |  |  |
|  |  | - Network HAR + getContent  |  | - Multi-tab requests      |  |  |
|  |  | - DOM Box Model Diagnostics |  | - Collections & Folders   |  |  |
|  |  | - Runtime Error Inspector   |  | - Environments & {{vars}} |  |  |
|  |  | - In-memory Session Store   |  | - History & Assertions    |  |  |
|  |  +-----------------------------+  +---------------------------+  |  |
|  |                                                 |                |  |
|  +-------------------------------------------------|----------------+  |
|                                                    v                   |
|                                           +------------------+         |
|                                           | IndexedDB Store  |         |
|                                           +------------------+         |
+------------------------------------------------------------------------+
```

## Dual Execution Engine
1. **Inspected Page Context**: Requests dispatched via `chrome.devtools.inspectedWindow.eval('fetch(...)')` running in the inspected page's origin, preserving active cookies and session credentials.
2. **Extension Context**: Requests dispatched via extension `window.fetch()`, bypassing CORS where host permissions allow.
