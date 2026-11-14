---
name: testing-and-debugging
description: Runbook for unit testing TypeScript logic, mocking browser extension APIs, and verifying builds.
---

# Testing & Debugging

## Automated Checks
1. `npm run typecheck`: Validates TypeScript strict rules.
2. `npm test`: Executes unit tests for core utilities and models.
3. `npm run build`: Bundles extension artifacts into `dist/`.

## DevTools Verification
- Load `dist/` as an unpacked extension at `chrome://extensions`.
- Inspect DevTools console via `Ctrl+Shift+I` on the DevTools window itself to inspect extension logs.
