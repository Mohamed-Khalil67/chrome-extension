---
name: extension-security
description: Security and privacy runbook for Chrome DevTools extensions handling sensitive network payloads, credentials, and DOM rendering.
---

# Extension Security & Privacy

## Redaction Strategy
- Automatically redact sensitive HTTP headers (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`).
- Mask password values and tokens in request bodies before storing or exporting.

## Safe Rendering
- When displaying JSON or formatted responses, parse into data objects and generate DOM elements safely (`document.createElement`).
- Never pass raw API responses into `innerHTML` or `eval()`.
