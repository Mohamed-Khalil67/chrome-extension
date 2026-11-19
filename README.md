# Angular Lens

A Chrome side-panel extension for debugging Angular apps. Its tabs follow Chrome DevTools:

| Tab | What it tells you |
|---|---|
| **Inspect** | Click **Pick**, or hold **Alt** and click any part of the page while you use it. **Component**: the component, its class and **the template line that created the element, shown as code in the panel**, inputs, signals, state and event listeners, and the parent components. **Styles**: box model and the CSS rules that apply (overridden ones struck through). **Layout**: plain-language problems (overflow, hidden, covered, contrast, z-index). |
| **Console** | Everything the page logs, with **the line of your code that logged it**. **Errors and warnings** are rows you can expand: what the error means, the failing source line, a docs link for `NG0xxx` codes, and the stack. A prompt at the bottom **runs JavaScript in the page** (`await` works, ↑/↓ recall history, Ctrl+L clears). `$0` is the element you picked, and `ng.getOwningComponent($0)` gives its component. |
| **Network** | **Only the calls your app makes to its backend** (fetch/XHR returning JSON), each with **the file and line that made it** and the component it was called from. At the top, **Responses by status code** explains each code from the backend's side. Click a bar to filter. Click a call for what the backend is saying, what to check in the front end and the backend, the server's own message, then Code, Headers, Payload, Response, Preview and Timing. |
| **Requests** | Build and send an HTTP request (method, params, headers, JSON/form body, bearer/basic/API-key auth, `{{variables}}`) without CORS limits. Copy **TypeScript interfaces** generated from the JSON response (optional fields worked out across array items) and an **Angular service** method. In Network, **Open in Requests** sends any captured call again. |

The header shows a health strip (errors, failed API calls, layout issues) that jumps to the right tab.

## Install (developer mode)

1. `npm install`, then `npm run build`. The extension is built into `dist/`.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the `dist/` folder.
3. Open your app (`ng serve` → `http://localhost:4200`), then click the Angular Lens icon to open the side panel.
4. In ⚙ settings, set **Project folder** (the folder that contains `src/`) so file links open in VS Code, Cursor or WebStorm.

While you work on the extension, `npm run watch` rebuilds on every change. Reload it at `chrome://extensions` afterwards.

Angular Lens runs on `localhost`, `127.0.0.1`, `*.localhost` and `*.test` by default. On any other site, the panel offers **Turn on for this site**.

**Shortcuts:**
- **Alt+Shift+X** starts the picker.
- While picking:
  - **↑** selects the parent.
  - **↓** steps back toward the element under the cursor.
  - **Enter** or a click selects.
  - **Esc** cancels.
- **Alt+click** picks while the panel is open, without entering pick mode. A plain click still works as usual.

## Notes

- **Which calls Network lists.** It finds your backend by itself. Calls to another host that answer with JSON count, as do calls on the app's own host to paths without a file extension (`/api/...`). Static files fetched by code, such as `/assets/i18n/en.json`, are left out. To choose yourself, set **API base URL** in settings.
- **The line shown for a call** is where it was sent. `HttpClient` sends when the observable is subscribed, so that is usually the component that subscribes, followed by the template event that triggered it. Calls started by Angular itself (`httpResource`, `resource`, `effect`) show "Started by Angular".
- **Code in the panel** comes from the dev server's source maps (`sourcesContent`), so no file access is needed.
- **Component names and files** need a development build (`ng serve`). In production builds, Network, Console and the CSS checks still work.
- **Debugging the panel itself:** it can be opened as a page pinned to one tab, at `chrome-extension://<id>/panel/index.html?tabId=<tabId>`.

## Layout

```
src/
  background/index.ts      service worker: opens the panel, shortcut, error badge
  content/hook.main.ts     page world: fetch/XHR, errors, console, Console eval, Angular adapter
  content/isolated.ts      isolated world: buffers, messaging with the panel
  content/picker.ts        pick overlay and Alt+click (top-layer popover + Shadow DOM)
  content/css-inspect.ts   matched rules, specificity, overrides, layout warnings
  panel/main.ts            panel shell: tabs, settings, connection, health strip
  panel/core/              state, DOM helpers, typed event bus, formatting, editor links, code view
  panel/features/          inspect, console (+ errors), network, requests
  shared/                  typed messages between worlds, source maps, status codes, JSON → TS
static/                    manifest.json, panel HTML and CSS, icons
scripts/build.mjs          esbuild: one bundle per entry, copies static/ into dist/
```

`npm run typecheck` runs the strict TypeScript check. Rules for coding agents are in [AGENTS.md](AGENTS.md).
