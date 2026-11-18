# FE Lens

A small Chrome side-panel extension that answers the three questions you keep
asking while building a front end (Angular first, React/Vue basic support):

| Tab | What it tells you |
|---|---|
| **Inspect** | Click **Pick**, then any area of the page: the component that rendered it, its source file and line (opens in your editor), parent components, current `input()`/signal/state values, event listeners, layout problems (overflow, hidden, covered, contrast, z-index), the box model, and which CSS rules apply and which are overridden. |
| **Network** | Every `fetch`/`HttpClient` call: status, timing, request and response bodies (pretty JSON), headers, **the line in your code that made the call**, copy as cURL/fetch. Failed requests are marked in red. |
| **Errors** | Uncaught errors, promise rejections, `console.error` (Angular's ErrorHandler) and failed requests, grouped with counts, mapped back to your `.ts` files via source maps, with links to the docs for `NG0xxx` codes. |

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open your app (`ng serve` → `http://localhost:4200`), then click the FE Lens icon to open the side panel.
4. Open the ⚙ settings and set **Project folder** (the folder that contains `src/`) so file links open in VS Code, Cursor or WebStorm.

FE Lens runs on `localhost`, `127.0.0.1`, `*.localhost` and `*.test` by default. On any other site, the panel offers **Turn on for this site**.

Shortcut: **Alt+Shift+X** starts the picker. While picking: **↑** selects the parent,
**↓** steps back toward the element under the cursor, **Enter** or click selects,
**Esc** cancels. The highlight always matches what a click will select, even when
the page scrolls or a carousel moves under a still cursor.

## Notes

- Component names and files need a **development build** (`ng serve`): Angular exposes them only in dev mode (`ng` global + `ɵcmp.debugInfo`). In production builds, Network, Errors and the CSS checks still work.
- The panel can be opened as a page pinned to one tab for debugging: `chrome-extension://<id>/sidepanel/index.html?tabId=<tabId>`.

## Layout

```
manifest.json            MV3 manifest (side panel, content scripts)
background.js            opens the panel, keyboard shortcut, error badge
content/hook.main.js     page world: fetch/XHR + error capture, framework adapters
content/bridge.js        isolated world: buffers, messaging with the panel
content/picker.js        hover/click overlay (top-layer popover + Shadow DOM)
content/css-inspect.js   matched rules, specificity, overrides, layout warnings
sidepanel/               the UI (vanilla JS modules, no build step)
sidepanel/sourcemap.js   tiny source-map resolver for stack traces
```

Built with the `chrome-extensions` and `modern-web-guidance` skills from
[GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance)
(installed under `.claude/skills/`).
