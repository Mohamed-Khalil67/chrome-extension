// Shared state of the side panel.
import type { ErrorEntry, FrameworkInfo, NetEntry, Selection } from '../../shared/messages';
import type { MappedFrame } from '../../shared/sourcemap';

export type Editor = 'vscode' | 'cursor' | 'webstorm';
export interface Settings {
  root: string; // project folder, for editor links
  editor: Editor;
  idePort: number; // JetBrains built-in server port (63342 by default)
  apiBase: string; // optional: backend base URLs, comma separated
}
// An error as the panel keeps it: with its stack mapped to source files.
export type PanelError = ErrorEntry & { mapped?: MappedFrame[] };

export const S = {
  windowId: null as number | null,
  tabId: null as number | null,
  tabUrl: '',
  framework: null as FrameworkInfo | null,
  net: new Map<string, NetEntry>(),
  errors: new Map<string, PanelError>(),
  selection: null as Selection | null,
  settings: { root: '', editor: 'vscode', idePort: 63342, apiBase: '' } as Settings,
  picking: false,
  scripts: [] as string[],
};
