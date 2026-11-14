# Frontend Lens Implementation Plan

Refer to `GEMINI.md` and `docs/architecture/overview.md` for full project guidelines.

## Milestones
- [x] **Milestone 0: Architecture, Rules, Skills & Contracts**
  - Git repository connection and branch alignment on `main`.
  - Workspace rules (`.agents/rules/`).
  - Workspace skills (`.agents/skills/`).
  - Architectural decision records (`docs/decisions/`).
  - Data models and contracts (`src/core/models/`).
- [ ] **Milestone 1: Technical Proof of Concept**
  - DevTools custom panel registration.
  - Per-tab Frontend Debugger (HAR capture + `getContent()` + JSON viewer + DOM Box Model).
  - Postman-like Request Workspace (Multi-tab, dual execution, IndexedDB storage).
- [ ] **Milestone 2: Enhanced Correlation & Diagnostics**
  - Request-to-UI correlation.
  - Advanced layout & overflow warnings.
- [ ] **Milestone 3: Import/Export & History Search**
  - Postman collection import/export.
  - Environment switching and script assertions.
