// Messaging with the content script in the inspected tab.
import type { PanelRequest, ResponseOf } from '../../shared/messages';
import { S } from './state';

// Resolves to undefined when the page has no content script (not connected).
export async function send<T extends PanelRequest>(msg: T): Promise<ResponseOf<T> | undefined> {
  if (S.tabId == null) return undefined;
  try {
    // The content script answers each request type with its ResponseOf type.
    return (await chrome.tabs.sendMessage(S.tabId, msg)) as ResponseOf<T>;
  } catch {
    return undefined;
  }
}

// Same-origin scripts in the page, used to find source maps (refreshed lazily:
// route chunks load later).
export async function pageScripts(refresh = false): Promise<string[]> {
  if (refresh || !S.scripts.length) S.scripts = (await send({ type: 'scripts' })) ?? [];
  return S.scripts;
}
