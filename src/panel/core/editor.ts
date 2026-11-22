// Links that open a source file in the user's editor.
import { $, closest, esc } from './dom';
import { S } from './state';

export const DEFAULT_IDE_PORT = 63342;

function absPath(file: string): string | null {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(file)) return file.replaceAll('\\', '/');
  if (!S.settings.root) return null;
  return `${S.settings.root.replaceAll('\\', '/').replace(/\/$/, '')}/${file.replace(/^\.?\//, '')}`;
}

export function editorUrl(file: string, line = 1, col = 1): string | null {
  const p = absPath(file);
  if (!p) return null;
  const slashed = p.startsWith('/') ? p : `/${p}`;
  switch (S.settings.editor) {
    case 'cursor': return `cursor://file${slashed}:${line}:${col}`;
    case 'webstorm': return `webstorm://open?file=${encodeURIComponent(p)}&line=${line}&column=${col}`;
    default: return `vscode://file${slashed}:${line}:${col}`;
  }
}

// JetBrains IDEs run a built-in web server (63342 by default) that opens a file
// and focuses the window. It needs "Allow unsigned requests" in Settings ›
// Build, Execution, Deployment › Debugger. Asking it directly beats handing the
// OS a `webstorm://` URL: the inspected tab is never navigated away, and we
// learn whether it actually worked.
export async function openViaIde(path: string, line: number, col: number): Promise<boolean> {
  const port = S.settings.idePort || DEFAULT_IDE_PORT;
  const root = `http://127.0.0.1:${port}/api/file`;
  // Two shapes, because which one an IDE build accepts varies: the path form
  // (Windows paths start with a drive letter, POSIX ones keep their slash) and
  // the query form.
  const urls = [
    `${root}/${path}:${line}:${col}`,
    `${root}?file=${encodeURIComponent(path)}&line=${line}&column=${col}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (res.ok) return true;
    } catch { /* IDE not running, or the port is closed: try the next shape */ }
  }
  return false;
}

export function fileLink(file: string | null | undefined, line?: number | null, col?: number | null, label?: string): string {
  if (!file) return '<span class="file-link nofile">source location unavailable</span>';
  const text = esc(label ?? `${file}${line ? `:${line}` : ''}${col ? `:${col}` : ''}`);
  return `<button type="button" class="file-link" data-open-file="${esc(file)}" data-line="${line ?? 1}" data-col="${col ?? 1}" title="Open ${esc(file)} in your editor">${text}</button>`;
}

// showPopover() throws if the popover is already open, so force it open instead.
const openSettings = (): void => { $('#settings').togglePopover(true); };

function needsRoot(): void {
  openSettings();
  $('#root').focus();
  $('#saved').textContent = 'Set your project folder to open files.';
}

export async function openInEditor(file: string, line: number, col: number): Promise<void> {
  const path = absPath(file);
  if (!path) {
    // WebStorm resolves a path relative to the project it has open, so no folder is needed.
    if (S.settings.editor === 'webstorm' && await openViaIde(file.replace(/^\.?\//, ''), line, col)) return;
    needsRoot();
    return;
  }
  if (S.settings.editor === 'webstorm' && await openViaIde(path, line, col)) return;
  const url = editorUrl(file, line, col);
  if (!url) { needsRoot(); return; }
  if (S.settings.editor === 'webstorm') {
    openSettings();
    $('#ide-status').textContent = `No answer from WebStorm on port ${S.settings.idePort || DEFAULT_IDE_PORT}. Trying webstorm:// instead.`;
  }
  // An external-protocol URL is handed to the OS without navigating the tab.
  // Chrome rejects the call when no application is registered for the scheme:
  // say so rather than failing silently.
  if (S.tabId == null) return;
  try {
    await chrome.tabs.update(S.tabId, { url });
  } catch {
    openSettings();
    $('#ide-status').textContent = `Chrome couldn't hand ${url.split(':')[0]}:// to ${S.settings.editor}. Is the editor installed, and its URL handler registered?`;
  }
}

document.addEventListener('click', (e) => {
  const b = closest(e, '[data-open-file]');
  if (!b) return;
  e.stopPropagation();
  void openInEditor(b.dataset.openFile ?? '', Number(b.dataset.line) || 1, Number(b.dataset.col) || 1);
});
