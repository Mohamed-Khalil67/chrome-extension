import { DevToolsNetworkAdapter } from '../core/adapters/devtools-network.adapter';

chrome.devtools.panels.create(
  'Frontend Lens',
  'assets/icon16.png',
  'panel/panel.html',
  (panel) => {
    panel.onShown.addListener(() => {
      // Panel shown
    });
  }
);

// Subscribe to network requests at the DevTools root level
if (chrome.devtools && chrome.devtools.network) {
  chrome.devtools.network.onRequestFinished.addListener(async (request) => {
    try {
      const tabId = chrome.devtools.inspectedWindow.tabId;
      const adapted = await DevToolsNetworkAdapter.adaptHarRequest(request, tabId);
      chrome.runtime.sendMessage({
        type: 'FRONTEND_LENS_NETWORK_REQUEST',
        tabId,
        data: adapted
      }).catch(() => {
        // Ignored if panel or background is not actively listening
      });
    } catch (err) {
      console.error('DevTools network adapter error:', err);
    }
  });
}
