// Angular Lens service worker. Stateless on purpose: the service worker can be
// stopped at any time, so per-page data lives in the content script (bridge.js)
// and settings live in chrome.storage.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('Angular Lens: setPanelBehavior failed', err));

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
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'badge' || !sender.tab?.id) return;
  const count = Number(message.errors) || 0;
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: count ? String(Math.min(count, 99)) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#d93025' });
});
