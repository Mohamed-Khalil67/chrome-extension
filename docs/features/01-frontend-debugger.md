# Feature: Frontend Debugger

## Capabilities
1. **Network Inspector**:
   - Listens to `chrome.devtools.network.onRequestFinished`.
   - Inspects headers, query parameters, request payloads, and status codes.
   - Fetches full response body asynchronously via `getContent()`.
   - Pretty-prints JSON responses with syntax highlighting and searchable trees.
   - Status categorization: Success, Redirect, Client Error, Server Error, Application Failure (e.g. 200 OK with `{ "success": false }`).
2. **UI & DOM Inspector**:
   - Evaluates inspected element (`$0`).
   - Computes layout box model: width, height, padding, margin, border.
   - Automated layout diagnostics:
     * Detects horizontal page or container overflow.
     * Identifies hidden interactive elements (zero width/height, `opacity: 0`).
3. **Tab Isolation**:
   - Bound strictly to `chrome.devtools.inspectedWindow.tabId`.
