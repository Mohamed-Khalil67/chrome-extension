// Links that open a source file in the user's editor.
import { $, closest, esc } from './dom';
import { S } from './state';

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

export function fileLink(file: string | null | undefined, line?: number | null, col?: number | null, label?: string): string {
  if (!file) return '<span class="file-link nofile">source location unavailable</span>';
  const text = esc(label ?? `${file}${line ? `:${line}` : ''}${col ? `:${col}` : ''}`);
  return `<button type="button" class="file-link" data-open-file="${esc(file)}" data-line="${line ?? 1}" data-col="${col ?? 1}" title="Open ${esc(file)} in your editor">${text}</button>`;
}

export async function openInEditor(file: string, line: number, col: number): Promise<void> {
  const url = editorUrl(file, line, col);
  if (!url) {
    $('#settings').showPopover();
    $('#root').focus();
    $('#saved').textContent = 'Set your project folder to open files.';
    return;
  }
  // An external-protocol URL is handed to the OS without navigating the tab.
  if (S.tabId != null) await chrome.tabs.update(S.tabId, { url });
}

document.addEventListener('click', (e) => {
  const b = closest(e, '[data-open-file]');
  if (!b) return;
  e.stopPropagation();
  void openInEditor(b.dataset.openFile ?? '', Number(b.dataset.line) || 1, Number(b.dataset.col) || 1);
});
