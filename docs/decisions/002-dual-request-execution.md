# ADR 002: Dual Request Execution Modes

## Status
Accepted

## Context
When sending API requests from the Request Workspace, developers often need to simulate either:
1. An authentic client-side request originating from the web application (with active HttpOnly cookies, session tokens, and strict CORS).
2. A direct API test originating from outside the application (bypassing page CORS restrictions).

## Decision
Provide an explicit **Execution Mode** selector on each request:
- **Inspected Page**: Executes inside the inspected tab via `chrome.devtools.inspectedWindow.eval`.
- **Extension Context**: Executes directly from the DevTools panel context using `fetch()`.

## Consequences
- Testing authenticated endpoints that rely on browser cookies works without manual token extraction.
- Cross-origin APIs without CORS headers can still be tested via Extension Context mode.
