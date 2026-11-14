# TypeScript Guidelines

1. **No `any`**:
   - Use `unknown` with type narrowing, generic constraints, or discriminated unions.
2. **Explicit Models**:
   - Use strongly typed interfaces for all workspace entities (`RequestItem`, `Collection`, `Environment`, `CapturedNetworkRequest`).
3. **Immutability & Safety**:
   - Return clean cloned or readonly structures where appropriate.
   - Use optional chaining and nullish coalescing safely.
4. **Native DOM Integration**:
   - Strongly type DOM events and element references (`HTMLElement`, `HTMLInputElement`, `HTMLSelectElement`).
