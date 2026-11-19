// Angular Lens service worker. Stateless on purpose: Chrome can stop it at any
// time, so per-page data lives in the content script and settings in chrome.storage.
import { isRecord } from '../shared/messages';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err: unknown) => console.error('Angular Lens: setPanelBehavior failed', err));

// Keyboard shortcut → start the picker in the active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-picker') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'picker:toggle' });
  } catch {
    // Content script not injected on this page (not a dev host, or page not reloaded yet).
  }
});

// Per-tab error badge, reported by the content script.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const tabId = sender.tab?.id;
  if (!isRecord(message) || message.type !== 'badge' || tabId == null) return;
  const count = Number(message.errors) || 0;
  void chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : '' });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
});
