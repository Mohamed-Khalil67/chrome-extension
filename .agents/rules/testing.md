# Testing Guidelines

1. **Unit Testing**:
   - Write tests for pure logic: variable resolver, status classifier, redaction utility, and box model diagnostics.
2. **Build Verification**:
   - Every modification must be validated by running `npm run build` and `npm run typecheck`.
3. **Chrome API Mocking**:
   - Unit tests must mock `chrome.devtools`, `chrome.runtime`, and `chrome.tabs` when testing extension-specific integration logic.
