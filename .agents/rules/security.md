# Security & Privacy Guidelines

1. **Zero External Exfiltration**:
   - The extension must never send telemetry, logs, or captured user data to remote endpoints.
2. **Credential Redaction**:
   - Automatically redact `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, and secret query parameters when viewing or exporting.
3. **Safe Rendering**:
   - Never use `innerHTML` with unsanitized user inputs or API response payloads. Use `textContent`, safe DOM creation (`document.createElement`), or an HTML escape utility.
4. **Isolated Storage**:
   - IndexedDB stores must not be accessible to the inspected web page. DevTools extensions run in a privileged extension origin isolated from inspected websites.
