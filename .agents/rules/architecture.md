# Architecture Rules

1. **Context Boundaries**:
   - DevTools page (`devtools.ts`) registers the panel and listens to `chrome.devtools.network`.
   - Panel (`panel.ts`) manages UI, active tabs, and IndexedDB operations.
   - Content Script (`inspector.ts`) runs in the inspected page's context to inspect DOM, layout, and compute styles.
   - Background (`service-worker.ts`) handles extension lifecycle and port routing where required.

2. **Decoupled Data Stores**:
   - Tab-specific debugging events live in an in-memory session manager keyed by `tabId`.
   - Postman-like collections, requests, environments, and history persist in IndexedDB (`frontend_lens_db`).

3. **Status Classification**:
   - Transport error: Network failed, blocked, CORS error, aborted.
   - HTTP status: Response code from the server (2xx, 3xx, 4xx, 5xx).
   - Application status: Server returned 200 OK, but JSON payload contains `{ "success": false }`, `{ "error": ... }`, or GraphQL errors.
