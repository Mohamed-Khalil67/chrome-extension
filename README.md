# FE Lens

A small Chrome side-panel extension that answers the three questions you keep
asking while building a front end (Angular first, React/Vue basic support):

| Tab | What it tells you |
|---|---|
| **Inspect** | Click **Pick**, then any area of the page. **Component** tab: the component, **its class and the template line that created the element, shown as code inside the panel**, inputs/signals/state, event listeners, parents. **Styles** tab: box model and the CSS rules that apply (overridden ones struck through). **Layout** tab: plain-language problems (overflow, hidden, covered, contrast, z-index). |
| **Network** | Every request, classified like DevTools: type chips (API, Doc, JS, CSS, Img, Font) and status chips (2xx, 3xx, 4xx, 5xx, Failed) that combine as filters, a sortable table with a waterfall, and hints for common problems (401 not authenticated, 404 wrong URL, HTML instead of JSON, slow, large, duplicate calls). Click a row for Headers, Payload, Response, Preview (JSON tree), Timing and **Initiator: the line of your code that made the call**. |
| **Errors** | Uncaught errors, promise rejections, `console.error` (Angular's ErrorHandler) and failed requests, grouped (Runtime, HTTP, Angular NG, Warnings), each with **the failing source line shown inline**, plus links to the docs for `NG0xxx` codes. |

The header shows a health strip (errors, failed requests, layout issues) that jumps to the right tab.

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

- Code shown in the panel comes from the dev server's source maps (`sourcesContent`), so no file access is needed. API calls started by the framework itself (an `httpResource`, `resource` or `effect`) have no line of your code on the stack, and the Initiator tab says so.
- Images and fonts from other origins show no status or headers: the browser only exposes those with a `Timing-Allow-Origin` header. Dev-server internals (Vite, Angular hot updates) are hidden from the list.
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
