# ADR 001: Native TypeScript UI and IndexedDB Persistence

## Status
Accepted

## Context
Chrome DevTools panels require fast startup, minimal memory overhead, and smooth interaction. Using heavyweight frontend frameworks (Angular, React, Vue) inside the extension increases bundle size, bundle complexity, and memory footprint. Furthermore, the extension must persist API collections, environments, and history across browser sessions.

## Decision
1. Implement Frontend Lens using **pure TypeScript and native DOM/HTML/CSS**.
2. Persist workspace collections, requests, environments, and history using **IndexedDB** (`frontend_lens_db`).
3. Maintain in-memory tab-isolated sessions for passive debugging events.

## Consequences
- Bundle size remains small (< 200 KB total).
- Instant startup inside DevTools.
- Zero framework runtime coupling.
- Complete framework independence on the inspected application side.
