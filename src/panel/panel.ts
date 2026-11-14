import { DevToolsNetworkAdapter } from '../core/adapters/devtools-network.adapter';
import { RequestExecutor } from '../core/execution/request-executor';
import { CapturedNetworkRequest, InspectedElementData } from '../core/models/debugger';
import {
  AuthType,
  Collection,
  Environment,
  HttpMethod,
  KeyValuePair,
  RequestHistoryItem,
  RequestItem
} from '../core/models/workspace';
import { Redactor } from '../core/security/redactor';
import { storage } from '../core/storage/indexed-db';
import { BoxModelDiagram } from './components/box-model';
import { JsonViewer } from './components/json-viewer';

export class PanelController {
  private tabId: number = 0;
  private activeMode: 'debugger' | 'workspace' = 'debugger';
  private environments: Environment[] = [];
  private activeEnv: Environment | null = null;
  private collections: Collection[] = [];
  private savedRequests: RequestItem[] = [];
  private history: RequestHistoryItem[] = [];

  // Debugger state
  private debuggerRequests: CapturedNetworkRequest[] = [];
  private selectedDebuggerRequestId: string | null = null;

  // Workspace state
  private openTabs: RequestItem[] = [];
  private activeTabId: string = '';

  async init(): Promise<void> {
    this.detectTabId();
    this.setupEventListeners();
    await this.loadWorkspaceData();
    this.initDefaultWorkspaceTab();
    this.listenToDevToolsMessages();
  }

  private detectTabId(): void {
    if (typeof chrome !== 'undefined' && chrome.devtools && chrome.devtools.inspectedWindow) {
      this.tabId = chrome.devtools.inspectedWindow.tabId;
      const badge = document.getElementById('tabSessionBadge');
      if (badge) badge.textContent = `Tab: ${this.tabId}`;
    }
  }

  private async loadWorkspaceData(): Promise<void> {
    try {
      this.collections = await storage.getCollections();
      this.savedRequests = await storage.getRequests();
      this.environments = await storage.getEnvironments();
      this.history = await storage.getHistory(50);

      this.renderEnvironmentsDropdown();
      this.renderCollectionsSidebar();
      this.renderHistorySidebar();
      this.renderEnvironmentsSidebar();
    } catch (e) {
      console.error('Failed to load storage data:', e);
    }
  }

  // --- Top Navigation & Mode Switching ---
  private setupEventListeners(): void {
    const btnDebugger = document.getElementById('btnModeDebugger');
    const btnWorkspace = document.getElementById('btnModeWorkspace');
    const viewDebugger = document.getElementById('viewDebugger');
    const viewWorkspace = document.getElementById('viewWorkspace');

    btnDebugger?.addEventListener('click', () => {
      this.activeMode = 'debugger';
      btnDebugger.classList.add('active');
      btnWorkspace?.classList.remove('active');
      viewDebugger?.classList.remove('hidden');
      viewWorkspace?.classList.add('hidden');
    });

    btnWorkspace?.addEventListener('click', () => {
      this.activeMode = 'workspace';
      btnWorkspace.classList.add('active');
      btnDebugger?.classList.remove('active');
      viewWorkspace?.classList.remove('hidden');
      viewDebugger?.classList.add('hidden');
    });

    // Sub-navigation for Debugger (Network vs UI)
    document.querySelectorAll('.sub-nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = (e.currentTarget as HTMLElement).dataset.target;
        document.querySelectorAll('.sub-nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.sub-view-section').forEach(s => s.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        if (target) document.getElementById(target)?.classList.add('active');
      });
    });

    // Detail Pane Subtabs
    document.querySelectorAll('.detail-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const sub = (e.currentTarget as HTMLElement).dataset.subtab;
        document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.detail-section').forEach(s => s.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        if (sub) document.getElementById(sub)?.classList.add('active');
      });
    });

    // Filter Network table
    const netFilter = document.getElementById('netFilterInput') as HTMLInputElement;
    netFilter?.addEventListener('input', () => this.renderNetworkTable());

    // Clear session
    document.getElementById('btnClearSession')?.addEventListener('click', () => {
      this.debuggerRequests = [];
      this.selectedDebuggerRequestId = null;
      this.renderNetworkTable();
      this.renderNetworkDetail();
    });

    // DOM Inspector button
    document.getElementById('btnInspectSelectedElement')?.addEventListener('click', () => {
      this.inspectSelectedElement();
    });

    // Copy response body
    document.getElementById('btnCopyResponseBody')?.addEventListener('click', () => {
      const selected = this.debuggerRequests.find(r => r.id === this.selectedDebuggerRequestId);
      if (selected && selected.responseBody) {
        navigator.clipboard.writeText(selected.responseBody);
      }
    });

    // Toggle Pretty / Raw JSON
    const btnToggle = document.getElementById('btnTogglePrettyJson');
    const formatted = document.getElementById('detailResponseFormatted');
    const raw = document.getElementById('detailResponseRaw');
    btnToggle?.addEventListener('click', () => {
      const isRaw = formatted?.classList.contains('hidden');
      if (isRaw) {
        formatted?.classList.remove('hidden');
        raw?.classList.add('hidden');
        btnToggle.textContent = 'Raw Text';
      } else {
        formatted?.classList.add('hidden');
        raw?.classList.remove('hidden');
        btnToggle.textContent = 'Pretty Tree';
      }
    });

    // --- Workspace Events ---
    // Sidebar Tabs
    document.querySelectorAll('.sidebar-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const sidetab = (e.currentTarget as HTMLElement).dataset.sidetab;
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.sidebar-content').forEach(c => c.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        if (sidetab) document.getElementById(sidetab)?.classList.add('active');
      });
    });

    // Config Tabs (Params, Headers, Auth, Body)
    document.querySelectorAll('.config-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const cfg = (e.currentTarget as HTMLElement).dataset.cfg;
        document.querySelectorAll('.config-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.config-section').forEach(s => s.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        if (cfg) document.getElementById(cfg)?.classList.add('active');
      });
    });

    // Response Subtabs (Pretty, Raw, Headers)
    document.querySelectorAll('.resp-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const resptab = (e.currentTarget as HTMLElement).dataset.resptab;
        document.querySelectorAll('.resp-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.resp-content').forEach(c => c.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        if (resptab) document.getElementById(resptab)?.classList.add('active');
      });
    });

    // Add Tab Button
    document.getElementById('btnNewRequestTab')?.addEventListener('click', () => {
      this.addNewWorkspaceTab();
    });

    // Send Request
    document.getElementById('btnSendRequest')?.addEventListener('click', () => {
      this.sendActiveRequest();
    });

    // Save Request Modal
    document.getElementById('btnSaveRequest')?.addEventListener('click', () => {
      this.openSaveRequestModal();
    });

    document.getElementById('btnCloseSaveModal')?.addEventListener('click', () => {
      (document.getElementById('saveReqModal') as HTMLDialogElement)?.close();
    });

    document.getElementById('btnCancelSaveModal')?.addEventListener('click', () => {
      (document.getElementById('saveReqModal') as HTMLDialogElement)?.close();
    });

    document.getElementById('btnConfirmSaveReq')?.addEventListener('click', () => {
      this.confirmSaveRequest();
    });

    // Environment Modal
    document.getElementById('btnCreateEnv')?.addEventListener('click', () => {
      this.openEnvironmentModal();
    });

    document.getElementById('btnCloseEnvModal')?.addEventListener('click', () => {
      (document.getElementById('envModal') as HTMLDialogElement)?.close();
    });

    document.getElementById('btnCancelEnvModal')?.addEventListener('click', () => {
      (document.getElementById('envModal') as HTMLDialogElement)?.close();
    });

    document.getElementById('btnSaveEnvModal')?.addEventListener('click', () => {
      this.saveEnvironmentModal();
    });

    // Add row buttons
    document.getElementById('btnAddParamRow')?.addEventListener('click', () => {
      this.addParamRow('', '');
    });

    document.getElementById('btnAddHeaderRow')?.addEventListener('click', () => {
      this.addHeaderRow('', '');
    });

    document.getElementById('btnAddEnvVarRow')?.addEventListener('click', () => {
      this.addEnvVarRow('', '');
    });

    // Format JSON body button
    document.getElementById('btnFormatJsonBody')?.addEventListener('click', () => {
      const textarea = document.getElementById('reqBodyTextarea') as HTMLTextAreaElement;
      if (textarea && textarea.value) {
        try {
          const parsed = JSON.parse(textarea.value);
          textarea.value = JSON.stringify(parsed, null, 2);
        } catch {
          // not valid JSON, leave as is
        }
      }
    });

    // Environment dropdown change
    const envSelect = document.getElementById('activeEnvSelect') as HTMLSelectElement;
    envSelect?.addEventListener('change', () => {
      const selectedId = envSelect.value;
      this.activeEnv = this.environments.find(e => e.id === selectedId) || null;
    });

    // Create Collection button
    document.getElementById('btnCreateCollection')?.addEventListener('click', () => {
      const name = prompt('Enter new collection name:');
      if (name && name.trim()) {
        const col: Collection = {
          id: `col_${Date.now()}`,
          name: name.trim(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        storage.saveCollection(col).then(() => {
          this.collections.push(col);
          this.renderCollectionsSidebar();
        });
      }
    });

    // Clear History button
    document.getElementById('btnClearHistory')?.addEventListener('click', () => {
      if (confirm('Clear all request history?')) {
        storage.clearHistory().then(() => {
          this.history = [];
          this.renderHistorySidebar();
        });
      }
    });
  }

  // --- DevTools Integration & Request Capture ---
  private listenToDevToolsMessages(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'FRONTEND_LENS_NETWORK_REQUEST') {
          this.handleCapturedRequest(msg.data as CapturedNetworkRequest);
        }
      });
    }

    // Direct registration when panel is loaded
    if (typeof chrome !== 'undefined' && chrome.devtools && chrome.devtools.network) {
      chrome.devtools.network.onRequestFinished.addListener(async (req) => {
        const adapted = await DevToolsNetworkAdapter.adaptHarRequest(req, this.tabId);
        this.handleCapturedRequest(adapted);
      });
    }
  }

  private handleCapturedRequest(req: CapturedNetworkRequest): void {
    this.debuggerRequests.unshift(req);
    // Limit to 500 requests per tab session to avoid unbounded memory
    if (this.debuggerRequests.length > 500) {
      this.debuggerRequests.pop();
    }
    this.renderNetworkTable();
  }

  private renderNetworkTable(): void {
    const tbody = document.getElementById('netTableBody');
    const countBadge = document.getElementById('netRequestCount');
    const filterText = (document.getElementById('netFilterInput') as HTMLInputElement)?.value.toLowerCase() || '';

    if (!tbody) return;

    const filtered = this.debuggerRequests.filter(r => {
      if (!filterText) return true;
      return r.url.toLowerCase().includes(filterText) ||
        r.status.toString().includes(filterText) ||
        r.method.toLowerCase().includes(filterText);
    });

    if (countBadge) countBadge.textContent = `${filtered.length} requests`;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${this.debuggerRequests.length === 0 ? 'Waiting for network requests in inspected tab...' : 'No matching requests found.'}</td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    filtered.forEach(r => {
      const tr = document.createElement('tr');
      if (r.id === this.selectedDebuggerRequestId) tr.classList.add('selected');

      let badgeClass = 'badge-2xx';
      if (r.statusClassification === 'app-failure') badgeClass = 'badge-app-err';
      else if (r.status >= 500) badgeClass = 'badge-5xx';
      else if (r.status >= 400) badgeClass = 'badge-4xx';
      else if (r.status >= 300) badgeClass = 'badge-3xx';
      else if (r.status === 0) badgeClass = 'badge-5xx';

      const statusDisplay = r.statusClassification === 'app-failure' ? `${r.status} APP` : (r.status === 0 ? 'FAIL' : r.status);
      const sizeDisplay = r.size > 1024 ? `${(r.size / 1024).toFixed(1)} KB` : `${r.size} B`;

      tr.innerHTML = `
        <td><span class="badge-status ${badgeClass}">${statusDisplay}</span></td>
        <td><span class="badge-method">${r.method}</span></td>
        <td title="${r.url}">${r.pathname || r.url}</td>
        <td>${r.duration} ms</td>
        <td>${sizeDisplay}</td>
      `;

      tr.onclick = () => {
        this.selectedDebuggerRequestId = r.id;
        this.renderNetworkTable();
        this.renderNetworkDetail();
      };

      tbody.appendChild(tr);
    });
  }

  private renderNetworkDetail(): void {
    const emptyMsg = document.getElementById('netDetailEmpty');
    const content = document.getElementById('netDetailContent');
    if (!emptyMsg || !content) return;

    const selected = this.debuggerRequests.find(r => r.id === this.selectedDebuggerRequestId);
    if (!selected) {
      emptyMsg.classList.remove('hidden');
      content.classList.add('hidden');
      return;
    }

    emptyMsg.classList.add('hidden');
    content.classList.remove('hidden');

    // Overview
    document.getElementById('detailUrl')!.textContent = selected.url;
    document.getElementById('detailStatus')!.textContent = `${selected.status} ${selected.statusText}`;
    document.getElementById('detailMethod')!.textContent = selected.method;
    document.getElementById('detailLatency')!.textContent = `${selected.duration} ms`;
    document.getElementById('detailSize')!.textContent = `${selected.size} bytes`;
    document.getElementById('detailMime')!.textContent = selected.mimeType;

    const appErrRow = document.getElementById('appErrorRow');
    const appErrMsg = document.getElementById('detailAppError');
    if (selected.statusClassification === 'app-failure') {
      appErrRow!.style.display = 'flex';
      appErrMsg!.textContent = selected.applicationErrorMessage || 'Application error returned in payload';
    } else {
      appErrRow!.style.display = 'none';
    }

    // Headers with Redactor
    const resHeadersEl = document.getElementById('detailResHeaders')!;
    resHeadersEl.innerHTML = '';
    const redactedResHeaders = Redactor.redactHeaderPairs(selected.responseHeaders);
    redactedResHeaders.forEach(h => {
      const row = document.createElement('div');
      row.className = 'header-row';
      row.innerHTML = `<span class="header-name">${h.name}:</span><span class="header-val">${h.value}</span>`;
      resHeadersEl.appendChild(row);
    });

    const reqHeadersEl = document.getElementById('detailReqHeaders')!;
    reqHeadersEl.innerHTML = '';
    const redactedReqHeaders = Redactor.redactHeaderPairs(selected.requestHeaders);
    redactedReqHeaders.forEach(h => {
      const row = document.createElement('div');
      row.className = 'header-row';
      row.innerHTML = `<span class="header-name">${h.name}:</span><span class="header-val">${h.value}</span>`;
      reqHeadersEl.appendChild(row);
    });

    // Payload
    const payloadEl = document.getElementById('detailPayloadText')!;
    payloadEl.textContent = selected.requestPayload || 'No payload sent with this request.';

    // Response
    const formattedContainer = document.getElementById('detailResponseFormatted')!;
    const rawPreview = document.getElementById('detailResponseRaw')!;
    rawPreview.textContent = selected.responseBody || 'No response body content available.';

    if (selected.responseBody && selected.isJson) {
      try {
        const parsed = JSON.parse(selected.responseBody);
        JsonViewer.render(parsed, formattedContainer);
        formattedContainer.classList.remove('hidden');
        rawPreview.classList.add('hidden');
        document.getElementById('btnTogglePrettyJson')!.textContent = 'Raw Text';
      } catch {
        formattedContainer.innerHTML = '';
        formattedContainer.classList.add('hidden');
        rawPreview.classList.remove('hidden');
      }
    } else {
      formattedContainer.innerHTML = '';
      formattedContainer.classList.add('hidden');
      rawPreview.classList.remove('hidden');
    }
  }

  // --- UI & DOM Inspector ---
  private inspectSelectedElement(): void {
    if (typeof chrome === 'undefined' || !chrome.devtools || !chrome.devtools.inspectedWindow) {
      alert('DOM inspection is only available inside active Chrome DevTools.');
      return;
    }

    const script = `
      (() => {
        const el = $0 || document.activeElement || document.body;
        if (!el) return JSON.stringify({ error: 'No element selected' });
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const parsePx = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n); };

        const dimensions = {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          margin: { top: parsePx(cs.marginTop), right: parsePx(cs.marginRight), bottom: parsePx(cs.marginBottom), left: parsePx(cs.marginLeft) },
          border: { top: parsePx(cs.borderTopWidth), right: parsePx(cs.borderRightWidth), bottom: parsePx(cs.borderBottomWidth), left: parsePx(cs.borderLeftWidth) },
          padding: { top: parsePx(cs.paddingTop), right: parsePx(cs.paddingRight), bottom: parsePx(cs.paddingBottom), left: parsePx(cs.paddingLeft) }
        };

        const warnings = [];
        if (rect.right > window.innerWidth + 1) {
          warnings.push('Element extends ' + Math.round(rect.right - window.innerWidth) + 'px beyond viewport width (causes horizontal scrollbar).');
        }
        if (el.scrollWidth > el.clientWidth && cs.overflowX !== 'hidden' && cs.overflowX !== 'scroll' && cs.overflowX !== 'auto') {
          warnings.push('Content overflows element width without an explicit overflow handler.');
        }
        if (['BUTTON', 'A', 'INPUT'].includes(el.tagName)) {
          if (dimensions.width === 0 || dimensions.height === 0 || cs.display === 'none' || parseFloat(cs.opacity) === 0) {
            warnings.push('Interactive element is invisible or zero-sized and cannot be clicked.');
          }
        }
        if (el.tagName === 'IMG' && !el.hasAttribute('alt')) {
          warnings.push('Image lacks an alt attribute (Accessibility issue).');
        }

        let selector = el.tagName.toLowerCase();
        if (el.id) selector += '#' + el.id;
        else if (el.classList.length > 0) selector += '.' + Array.from(el.classList).slice(0, 3).join('.');

        return JSON.stringify({
          tagName: el.tagName.toLowerCase(),
          id: el.id,
          selector,
          classes: Array.from(el.classList),
          dimensions,
          computedStyles: {
            display: cs.display,
            position: cs.position,
            overflow: cs.overflow,
            zIndex: cs.zIndex,
            boxSizing: cs.boxSizing
          },
          warnings
        });
      })()
    `;

    chrome.devtools.inspectedWindow.eval(script, (result, exceptionInfo) => {
      if (exceptionInfo && exceptionInfo.isException) {
        alert('Could not inspect element: ' + (exceptionInfo.value || 'Script exception'));
        return;
      }
      try {
        const data = typeof result === 'string' ? JSON.parse(result) : result;
        if (data.error) {
          alert(data.error);
          return;
        }
        this.renderDomInspection(data as InspectedElementData);
      } catch (err) {
        console.error('Failed to parse DOM inspection result:', err);
      }
    });
  }

  private renderDomInspection(data: InspectedElementData): void {
    document.getElementById('uiSelectorPill')!.textContent = `<${data.selector}>`;

    // Box Model
    const boxContainer = document.getElementById('uiBoxModelContainer')!;
    BoxModelDiagram.render(data.dimensions, boxContainer);

    // Computed Styles
    document.getElementById('styleDisplay')!.textContent = data.computedStyles.display;
    document.getElementById('stylePosition')!.textContent = data.computedStyles.position;
    document.getElementById('styleOverflow')!.textContent = data.computedStyles.overflow;
    document.getElementById('styleBoxSizing')!.textContent = data.computedStyles.boxSizing;
    document.getElementById('styleZIndex')!.textContent = data.computedStyles.zIndex;

    // Warnings
    const warnContainer = document.getElementById('uiWarningsContainer')!;
    if (data.warnings.length === 0) {
      warnContainer.innerHTML = '<div class="alert-info">No layout or accessibility warnings detected.</div>';
    } else {
      warnContainer.innerHTML = data.warnings
        .map(w => `<div class="alert-warning">${w}</div>`)
        .join('');
    }
  }

  // --- API Client Workspace Management ---
  private initDefaultWorkspaceTab(): void {
    if (this.openTabs.length === 0) {
      const defaultReq: RequestItem = {
        id: `tab_${Date.now()}`,
        name: 'Untitled Request',
        method: 'GET',
        url: 'https://jsonplaceholder.typicode.com/todos/1',
        headers: [{ id: '1', key: 'Accept', value: 'application/json', enabled: true }],
        params: [],
        auth: { type: 'none' },
        body: { type: 'none' },
        executionMode: 'inspected-page',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.openTabs.push(defaultReq);
      this.activeTabId = defaultReq.id;
    }
    this.renderWorkspaceTabs();
    this.loadActiveTabIntoForm();
  }

  private addNewWorkspaceTab(initial?: Partial<RequestItem>): void {
    const newReq: RequestItem = {
      id: `tab_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: initial?.name || 'Untitled Request',
      method: initial?.method || 'GET',
      url: initial?.url || '',
      headers: initial?.headers || [],
      params: initial?.params || [],
      auth: initial?.auth || { type: 'none' },
      body: initial?.body || { type: 'none' },
      executionMode: initial?.executionMode || 'inspected-page',
      collectionId: initial?.collectionId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.openTabs.push(newReq);
    this.activeTabId = newReq.id;
    this.renderWorkspaceTabs();
    this.loadActiveTabIntoForm();
  }

  private renderWorkspaceTabs(): void {
    const bar = document.getElementById('requestTabsBar');
    if (!bar) return;

    // Keep the new tab button at the end
    const newBtn = document.getElementById('btnNewRequestTab');
    bar.innerHTML = '';

    this.openTabs.forEach(tab => {
      const pill = document.createElement('div');
      pill.className = `req-tab-pill ${tab.id === this.activeTabId ? 'active' : ''}`;
      pill.innerHTML = `
        <span class="sidebar-method-badge badge-${tab.method.toLowerCase()}">${tab.method}</span>
        <span class="tab-title">${tab.name}</span>
        <span class="tab-close-btn">&times;</span>
      `;

      pill.onclick = (e) => {
        if ((e.target as HTMLElement).classList.contains('tab-close-btn')) {
          e.stopPropagation();
          this.closeWorkspaceTab(tab.id);
        } else {
          this.saveActiveFormIntoTab();
          this.activeTabId = tab.id;
          this.renderWorkspaceTabs();
          this.loadActiveTabIntoForm();
        }
      };

      bar.appendChild(pill);
    });

    if (newBtn) bar.appendChild(newBtn);
  }

  private closeWorkspaceTab(id: string): void {
    this.openTabs = this.openTabs.filter(t => t.id !== id);
    if (this.openTabs.length === 0) {
      this.addNewWorkspaceTab();
    } else if (this.activeTabId === id) {
      this.activeTabId = this.openTabs[this.openTabs.length - 1]!.id;
    }
    this.renderWorkspaceTabs();
    this.loadActiveTabIntoForm();
  }

  private getActiveTab(): RequestItem | undefined {
    return this.openTabs.find(t => t.id === this.activeTabId);
  }

  private saveActiveFormIntoTab(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    tab.method = (document.getElementById('reqMethodSelect') as HTMLSelectElement).value as HttpMethod;
    tab.url = (document.getElementById('reqUrlInput') as HTMLInputElement).value;
    tab.executionMode = (document.getElementById('reqExecModeSelect') as HTMLSelectElement).value as RequestItem['executionMode'];

    // Collect params
    tab.params = [];
    document.querySelectorAll('#paramsKvRows .kv-row').forEach(row => {
      const k = (row.querySelector('.kv-key') as HTMLInputElement)?.value;
      const v = (row.querySelector('.kv-val') as HTMLInputElement)?.value;
      if (k) tab.params.push({ id: Math.random().toString(), key: k, value: v, enabled: true });
    });

    // Collect headers
    tab.headers = [];
    document.querySelectorAll('#headersKvRows .kv-row').forEach(row => {
      const k = (row.querySelector('.kv-key') as HTMLInputElement)?.value;
      const v = (row.querySelector('.kv-val') as HTMLInputElement)?.value;
      if (k) tab.headers.push({ id: Math.random().toString(), key: k, value: v, enabled: true });
    });

    // Collect body
    const bodyType = (document.querySelector('input[name="bodyType"]:checked') as HTMLInputElement)?.value as RequestItem['body']['type'];
    tab.body = {
      type: bodyType || 'none',
      raw: (document.getElementById('reqBodyTextarea') as HTMLTextAreaElement)?.value
    };
  }

  private loadActiveTabIntoForm(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    (document.getElementById('reqMethodSelect') as HTMLSelectElement).value = tab.method;
    (document.getElementById('reqUrlInput') as HTMLInputElement).value = tab.url;
    (document.getElementById('reqExecModeSelect') as HTMLSelectElement).value = tab.executionMode;

    // Params
    const paramsContainer = document.getElementById('paramsKvRows')!;
    paramsContainer.innerHTML = '';
    tab.params.forEach(p => this.addParamRow(p.key, p.value));
    if (tab.params.length === 0) this.addParamRow('', '');

    // Headers
    const headersContainer = document.getElementById('headersKvRows')!;
    headersContainer.innerHTML = '';
    tab.headers.forEach(h => this.addHeaderRow(h.key, h.value));
    if (tab.headers.length === 0) this.addHeaderRow('', '');

    // Body
    const bodyRadio = document.querySelector(`input[name="bodyType"][value="${tab.body.type}"]`) as HTMLInputElement;
    if (bodyRadio) bodyRadio.checked = true;
    (document.getElementById('reqBodyTextarea') as HTMLTextAreaElement).value = tab.body.raw || '';
  }

  private addParamRow(k: string, v: string): void {
    const container = document.getElementById('paramsKvRows')!;
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `
      <input type="text" class="kv-input kv-key" placeholder="Parameter key" value="${k}">
      <input type="text" class="kv-input kv-val" placeholder="Value" value="${v}">
      <button class="btn-remove-row">&times;</button>
    `;
    row.querySelector('.btn-remove-row')?.addEventListener('click', () => row.remove());
    container.appendChild(row);
  }

  private addHeaderRow(k: string, v: string): void {
    const container = document.getElementById('headersKvRows')!;
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `
      <input type="text" class="kv-input kv-key" placeholder="Header name" value="${k}">
      <input type="text" class="kv-input kv-val" placeholder="Value" value="${v}">
      <button class="btn-remove-row">&times;</button>
    `;
    row.querySelector('.btn-remove-row')?.addEventListener('click', () => row.remove());
    container.appendChild(row);
  }

  private async sendActiveRequest(): Promise<void> {
    this.saveActiveFormIntoTab();
    const tab = this.getActiveTab();
    if (!tab || !tab.url.trim()) {
      alert('Please enter a request URL');
      return;
    }

    const sendBtn = document.getElementById('btnSendRequest') as HTMLButtonElement;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    const pill = document.getElementById('respStatusPill')!;
    pill.textContent = 'Sending...';
    pill.className = 'metric-pill status-neutral';

    try {
      const response = await RequestExecutor.execute(tab, this.activeEnv);

      // Status pill styling
      pill.textContent = `${response.status} ${response.statusText}`;
      if (response.status >= 200 && response.status < 300) {
        pill.className = 'metric-pill badge-2xx';
      } else if (response.status >= 400 && response.status < 500) {
        pill.className = 'metric-pill badge-4xx';
      } else if (response.status >= 500 || response.status === 0) {
        pill.className = 'metric-pill badge-5xx';
      }

      document.getElementById('respDurationText')!.textContent = `${response.duration} ms`;
      document.getElementById('respSizeText')!.textContent = `${response.size} B`;

      // Render response content
      const prettyTree = document.getElementById('respPrettyTree')!;
      const prettyEmpty = document.getElementById('respPrettyEmpty')!;
      const rawText = document.getElementById('respRawText')!;
      const headersList = document.getElementById('respHeadersList')!;

      rawText.textContent = response.body || response.error || 'No content';

      if (response.isJson && response.body) {
        try {
          const parsed = JSON.parse(response.body);
          prettyEmpty.classList.add('hidden');
          prettyTree.classList.remove('hidden');
          JsonViewer.render(parsed, prettyTree);
        } catch {
          prettyEmpty.classList.remove('hidden');
          prettyTree.classList.add('hidden');
        }
      } else {
        prettyEmpty.classList.remove('hidden');
        prettyTree.classList.add('hidden');
      }

      // Headers list
      headersList.innerHTML = Object.entries(response.headers)
        .map(([k, v]) => `<div class="header-row"><span class="header-name">${k}:</span><span class="header-val">${v}</span></div>`)
        .join('');

      // Add to history
      const historyItem: RequestHistoryItem = {
        id: `hist_${Date.now()}`,
        timestamp: Date.now(),
        tabId: this.tabId,
        request: { ...tab },
        response
      };
      await storage.addHistory(historyItem);
      this.history.unshift(historyItem);
      this.renderHistorySidebar();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pill.textContent = 'Error';
      pill.className = 'metric-pill badge-5xx';
      document.getElementById('respRawText')!.textContent = `Execution failed: ${msg}`;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  }

  // --- Collections & History Sidebar Rendering ---
  private renderCollectionsSidebar(): void {
    const container = document.getElementById('collectionsTree')!;
    if (this.collections.length === 0) {
      container.innerHTML = '<div class="empty-state">No collections yet. Click "+ New Collection" above.</div>';
      return;
    }

    container.innerHTML = '';
    this.collections.forEach(col => {
      const colDiv = document.createElement('div');
      colDiv.className = 'collection-folder';
      colDiv.innerHTML = `
        <div class="sidebar-item folder-header">
          <div class="item-left">📁 <strong>${col.name}</strong></div>
          <button class="btn-micro btn-del-col" title="Delete Collection">&times;</button>
        </div>
        <div class="folder-items" id="col_items_${col.id}"></div>
      `;

      colDiv.querySelector('.btn-del-col')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete collection "${col.name}"?`)) {
          storage.deleteCollection(col.id).then(() => {
            this.collections = this.collections.filter(c => c.id !== col.id);
            this.renderCollectionsSidebar();
          });
        }
      });

      const itemsContainer = colDiv.querySelector(`#col_items_${col.id}`)!;
      const childRequests = this.savedRequests.filter(r => r.collectionId === col.id);
      childRequests.forEach(req => {
        const item = document.createElement('div');
        item.className = 'sidebar-item req-item';
        item.innerHTML = `
          <div class="item-left">
            <span class="sidebar-method-badge badge-${req.method.toLowerCase()}">${req.method}</span>
            <span>${req.name}</span>
          </div>
        `;
        item.onclick = () => this.addNewWorkspaceTab(req);
        itemsContainer.appendChild(item);
      });

      container.appendChild(colDiv);
    });
  }

  private renderHistorySidebar(): void {
    const container = document.getElementById('historyList')!;
    if (this.history.length === 0) {
      container.innerHTML = '<div class="empty-state">No request history yet.</div>';
      return;
    }

    container.innerHTML = '';
    this.history.forEach(h => {
      const item = document.createElement('div');
      item.className = 'sidebar-item history-item';
      const statusBadge = h.response.status >= 200 && h.response.status < 300 ? 'badge-2xx' : 'badge-4xx';
      item.innerHTML = `
        <div class="item-left">
          <span class="sidebar-method-badge badge-${h.request.method.toLowerCase()}">${h.request.method}</span>
          <span title="${h.request.url}">${h.request.name || h.request.url}</span>
        </div>
        <span class="badge-status ${statusBadge}">${h.response.status}</span>
      `;
      item.onclick = () => this.addNewWorkspaceTab(h.request);
      container.appendChild(item);
    });
  }

  // --- Environments Management ---
  private renderEnvironmentsDropdown(): void {
    const select = document.getElementById('activeEnvSelect') as HTMLSelectElement;
    if (!select) return;
    select.innerHTML = '<option value="">No Environment</option>';
    this.environments.forEach(env => {
      const opt = document.createElement('option');
      opt.value = env.id;
      opt.textContent = env.name;
      if (this.activeEnv && this.activeEnv.id === env.id) opt.selected = true;
      select.appendChild(opt);
    });
  }

  private renderEnvironmentsSidebar(): void {
    const container = document.getElementById('environmentsList')!;
    if (this.environments.length === 0) {
      container.innerHTML = '<div class="empty-state">No environments configured.</div>';
      return;
    }

    container.innerHTML = '';
    this.environments.forEach(env => {
      const item = document.createElement('div');
      item.className = 'sidebar-item env-item';
      item.innerHTML = `
        <div class="item-left">🌐 <span>${env.name}</span> (${env.variables.length} vars)</div>
        <button class="btn-micro btn-del-env">&times;</button>
      `;

      item.querySelector('.btn-del-env')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete environment "${env.name}"?`)) {
          storage.deleteEnvironment(env.id).then(() => {
            this.environments = this.environments.filter(e => e.id !== env.id);
            if (this.activeEnv?.id === env.id) this.activeEnv = null;
            this.renderEnvironmentsDropdown();
            this.renderEnvironmentsSidebar();
          });
        }
      });

      item.onclick = () => this.openEnvironmentModal(env);
      container.appendChild(item);
    });
  }

  private openEnvironmentModal(env?: Environment): void {
    const modal = document.getElementById('envModal') as HTMLDialogElement;
    const nameInput = document.getElementById('envNameInput') as HTMLInputElement;
    const rows = document.getElementById('envVarRows')!;
    rows.innerHTML = '';

    if (env) {
      modal.dataset.envId = env.id;
      nameInput.value = env.name;
      env.variables.forEach(v => this.addEnvVarRow(v.key, v.value));
    } else {
      delete modal.dataset.envId;
      nameInput.value = '';
      this.addEnvVarRow('baseUrl', 'http://localhost:3000');
    }

    modal.showModal();
  }

  private addEnvVarRow(k: string, v: string): void {
    const rows = document.getElementById('envVarRows')!;
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `
      <input type="text" class="kv-input env-var-key" placeholder="Variable name" value="${k}">
      <input type="text" class="kv-input env-var-val" placeholder="Value" value="${v}">
      <button class="btn-remove-row">&times;</button>
    `;
    row.querySelector('.btn-remove-row')?.addEventListener('click', () => row.remove());
    rows.appendChild(row);
  }

  private async saveEnvironmentModal(): Promise<void> {
    const modal = document.getElementById('envModal') as HTMLDialogElement;
    const nameInput = document.getElementById('envNameInput') as HTMLInputElement;
    const name = nameInput.value.trim();
    if (!name) {
      alert('Please enter an environment name');
      return;
    }

    const variables: Environment['variables'] = [];
    document.querySelectorAll('#envVarRows .kv-row').forEach(row => {
      const k = (row.querySelector('.env-var-key') as HTMLInputElement)?.value.trim();
      const v = (row.querySelector('.env-var-val') as HTMLInputElement)?.value;
      if (k) variables.push({ id: Math.random().toString(), key: k, value: v, enabled: true });
    });

    const envId = modal.dataset.envId || `env_${Date.now()}`;
    const env: Environment = {
      id: envId,
      name,
      variables,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await storage.saveEnvironment(env);
    const existingIdx = this.environments.findIndex(e => e.id === env.id);
    if (existingIdx >= 0) this.environments[existingIdx] = env;
    else this.environments.push(env);

    this.activeEnv = env;
    this.renderEnvironmentsDropdown();
    this.renderEnvironmentsSidebar();
    modal.close();
  }

  // --- Save Request Modal ---
  private openSaveRequestModal(): void {
    this.saveActiveFormIntoTab();
    const tab = this.getActiveTab();
    if (!tab) return;

    const modal = document.getElementById('saveReqModal') as HTMLDialogElement;
    const nameInput = document.getElementById('saveReqNameInput') as HTMLInputElement;
    const colSelect = document.getElementById('saveReqCollectionSelect') as HTMLSelectElement;

    nameInput.value = tab.name;
    colSelect.innerHTML = '<option value="">No Collection</option>';
    this.collections.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (tab.collectionId === c.id) opt.selected = true;
      colSelect.appendChild(opt);
    });

    modal.showModal();
  }

  private async confirmSaveRequest(): Promise<void> {
    const tab = this.getActiveTab();
    if (!tab) return;

    const modal = document.getElementById('saveReqModal') as HTMLDialogElement;
    const name = (document.getElementById('saveReqNameInput') as HTMLInputElement).value.trim();
    const colId = (document.getElementById('saveReqCollectionSelect') as HTMLSelectElement).value;

    tab.name = name || 'Untitled Request';
    tab.collectionId = colId || undefined;
    tab.updatedAt = Date.now();

    await storage.saveRequest(tab);

    const existingIdx = this.savedRequests.findIndex(r => r.id === tab.id);
    if (existingIdx >= 0) this.savedRequests[existingIdx] = tab;
    else this.savedRequests.push(tab);

    this.renderWorkspaceTabs();
    this.renderCollectionsSidebar();
    modal.close();
  }
}

// Bootstrap when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const panel = new PanelController();
  panel.init().catch(err => console.error('Panel initialization failed:', err));
});
