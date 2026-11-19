# FE Lens

A small Chrome side-panel extension that answers the three questions you keep
asking while building a front end (Angular first, React/Vue basic support):

| Tab | What it tells you |
|---|---|
| **Inspect** | Click **Pick**, then any area of the page. **Component** tab: the component, **its class and the template line that created the element, shown as code inside the panel**, inputs/signals/state, event listeners, parents. **Styles** tab: box model and the CSS rules that apply (overridden ones struck through). **Layout** tab: plain-language problems (overflow, hidden, covered, contrast, z-index). |
| **Network and errors** | Every request **and every JS error on one timeline**. At the top, **Responses by status code**: one bar per code the page got (200, 304, 401, 404, 500…), JS errors and Angular NG errors, each with what it means. Click a bar to filter. Type tabs (API, Doc, JS, CSS, Img, Font, Errors), a sortable table with a waterfall where errors show as markers, and hints for common problems (HTML instead of JSON, slow, large, duplicate calls). Click a request for **what the backend is saying, what to check in the front end and in the backend, the server's own message**, the JS errors just before it, then Headers, Payload, Response, Preview, Timing and **Initiator: the line of your code that made the call**. Click an error for **the failing source line**, a plain explanation, and docs links for `NG0xxx` codes. |

The header shows a health strip (errors, failed requests, layout issues) that jumps to the right view.

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
