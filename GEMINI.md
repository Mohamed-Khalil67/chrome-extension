# Frontend Lens — Project Instructions & Engineering Rules

You are working on **Frontend Lens**, a dual-purpose developer tool built as a Chrome DevTools extension using Manifest V3:
1. **Frontend Debugger**: Scoped to the inspected Chrome tab (`chrome.devtools.inspectedWindow.tabId`), providing network capture, response body inspection, DOM/CSS layout diagnostics, and runtime error tracking in complete isolation per tab.
2. **API Client (Request Workspace)**: A Postman-like multi-tab request builder supporting Collections, Environments (`{{variables}}`), dual execution modes (Inspected Page vs Extension Context), and IndexedDB persistence, shared across tabs.

---

## Non-Negotiable Engineering Rules

### Rule 1 — Native TypeScript & Zero UI Framework Runtime
- Build the extension with **pure TypeScript, native HTML5, and modern CSS**.
- Do not introduce Angular, React, Vue, or heavy UI libraries into the extension bundle. Keep the extension lightweight, fast-loading, and responsive.
- The inspected target web application can be built with ANY technology (Angular, React, Vue, vanilla JS/TS, server-rendered). Zero client-side SDKs or scripts are required on the target application.

### Rule 2 — Tab Session Isolation
- Each open DevTools window attaches strictly to one Chrome tab via `chrome.devtools.inspectedWindow.tabId`.
- Captured network traffic, runtime errors, and DOM observations belong exclusively to their respective tab session. Never bleed captured data between tabs.

### Rule 3 — Separation of Debugger from Request Workspace
- **Debugger Session**: Tab-bound, passive monitoring of what happens in the application.
- **Request Workspace**: Global, user-directed request creation, folders, environments, and history.
- The two products share the same TypeScript foundation and styling, but neither depends on the other to function.

### Rule 4 — Dual Request Execution
- **Inspected Page Mode**: Dispatches requests in the target page context using `chrome.devtools.inspectedWindow.eval`. Inherits page cookies, session tokens, same-origin restrictions, and custom page headers.
- **Extension Context Mode**: Dispatches requests via extension `fetch()`, bypassing target page CORS where permissions allow.

### Rule 5 — Strict TypeScript
- `strict: true`, no `any`, explicit return types on public APIs, discriminated unions for events and execution results.
- Handle null and undefined explicitly.

### Rule 6 — Privacy & Security by Design
- All inspected data is local-only. Never transmit inspected application data or request bodies to external servers.
- Redact sensitive headers (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`) in logs and display views.
- Safe DOM rendering: never inject untrusted request/response bodies via `innerHTML` or execute untrusted scripts.

### Rule 7 — Verifiable Implementation
- Every feature must be verified through builds (`npm run build`), typechecks (`npm run typecheck`), and tests (`npm test`).
