# Feature: Request Workspace (API Client)

## Capabilities
1. **Multi-Tab Interface**:
   - Open, switch between, and close multiple request tabs.
   - Reorder and duplicate request tabs.
2. **Request Authoring**:
   - HTTP Methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.
   - Parameters: Key-value query parameters editor.
   - Headers: Key-value custom headers editor.
   - Authentication: None, Bearer Token, Basic Auth, API Key.
   - Body: None, JSON, form-data, x-www-form-urlencoded, raw text.
3. **Execution & Response**:
   - Status code, latency (ms), and payload size indicators.
   - Tabbed response viewer: Pretty-printed JSON, Raw text, Response Headers.
4. **Workspace Organization & Persistence**:
   - Collections with folders.
   - Environment variables (`{{baseUrl}}`, `{{token}}`).
   - Request history stored in IndexedDB.
