// Service Worker for Frontend Lens (Manifest V3)

chrome.runtime.onInstalled.addListener(() => {
  console.log('Frontend Lens extension installed successfully.');
});

// Relay messages between DevTools panels and content scripts if needed
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'PING') {
    sendResponse({ status: 'PONG' });
  }
  return true;
});
