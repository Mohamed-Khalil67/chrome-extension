# Frontend Lens — Project Instructions & Engineering Rules

You are working on **Frontend Lens**, a developer-centric developer tool built as a Chrome DevTools extension using Manifest V3:
1. **Monitor**: Inspects application network traffic and runtime errors in real time for the inspected Chrome tab.
2. **API Client**: A simple, elegant Postman-like multi-tab request builder supporting collections, environments (`{{baseUrl}}`), and history.

---

## UI/UX Engineering Rules

1. **Prioritize simplicity over feature quantity.**
2. **Design for visibility and readability.**
3. **Use large, clear section titles and readable text.**
4. **Use generous spacing between sections.**
5. **Make primary actions obvious.**
6. **Avoid excessive cards, borders, badges and tabs.**
7. **Avoid unnecessary navigation levels.**
8. **Keep the interface visually consistent.**
9. **Use a clean dark theme inspired by modern developer tools.**
10. **Support resizing without making content unreadable.**
11. **Keep tables simple and easy to scan.**
12. **Display errors clearly without overwhelming the user.**
13. **Never introduce a feature without a clear user benefit.**
14. **Do not build non-functional placeholder controls.**
15. **Do not implement the UI element picker or manual DOM selection feature.**

## Product Navigation

Only two primary sections:
- **Monitor** (Inspect application traffic and errors)
- **API Client** (Build and test HTTP requests)

Do not introduce additional main navigation sections without an explicit product requirement.

## API Client Scope

Provide a simple Postman-like experience:
- Multiple request tabs.
- Method selector.
- URL input.
- Send button.
- Params, Headers, Body, and Auth.
- Response viewer.
- Request history.
- Simple collections and environment variables (`{{baseUrl}}`).

Avoid unnecessary advanced features (no complex scripting, assertions, or heavy workflows).

## Development Philosophy

Build a small, polished, reliable product first.
A feature should be easy to discover, understand, and use.
Two excellent screens that developers enjoy using every day instead of ten complicated screens with half-working features.

---

## Non-Negotiable Technical Rules

### Rule 1 — Native TypeScript & Zero UI Framework Runtime
- Build the extension with **pure TypeScript, native HTML5, and modern CSS**.
- Zero runtime UI frameworks (no Angular, React, Vue, or heavy libraries). Keep it fast-loading, lightweight, and responsive.
- The inspected target web application can be built with ANY technology. Zero client-side SDKs required.

### Rule 2 — Tab Session Isolation
- Each DevTools window attaches strictly to one Chrome tab via `chrome.devtools.inspectedWindow.tabId`.
- Monitored network traffic and runtime errors belong exclusively to that tab session.

### Rule 3 — Separation of Monitor from API Client
- **Monitor**: Tab-bound passive monitoring.
- **API Client**: Reusable across tabs, persisted in IndexedDB.
- Neither depends on the other to function.

### Rule 4 — Dual Request Execution
- **Inspected Page Mode**: Dispatches requests in target page context via `chrome.devtools.inspectedWindow.eval`, inheriting page cookies, session tokens, and origin.
- **Extension Context Mode**: Dispatches requests via extension `fetch()`.

### Rule 5 — Strict TypeScript
- `strict: true`, no `any`, explicit types on all public methods and data contracts.

### Rule 6 — Privacy & Security by Design
- Local-only data. Never transmit user data to external servers.
- Redact sensitive headers (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`) in logs and UI.
- Safe DOM rendering: no `innerHTML` injection of untrusted bodies.

### Rule 7 — Verifiable Implementation
- Every feature must be verified through builds (`npm run build`), typechecks (`npm run typecheck`), and tests (`npm test`).
