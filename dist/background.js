// src/shared/messages.ts
var isRecord = (v) => typeof v === "object" && v !== null;

// src/background/index.ts
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error("Angular Lens: setPanelBehavior failed", err));
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-picker") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "picker:toggle" });
  } catch {
  }
});
chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;
  if (!isRecord(message) || message.type !== "badge" || tabId == null) return;
  const count = Number(message.errors) || 0;
  void chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : "" });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
});
//# sourceMappingURL=background.js.map
