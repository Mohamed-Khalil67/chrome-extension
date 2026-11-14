import { DevToolsNetworkAdapter } from '../core/adapters/devtools-network.adapter';
import { RequestExecutor } from '../core/execution/request-executor';
import { CapturedJsError, CapturedNetworkRequest } from '../core/models/debugger';
import {
  Collection,
  Environment,
  HttpMethod,
  RequestHistoryItem,
  RequestItem
} from '../core/models/workspace';
import { Redactor } from '../core/security/redactor';
import { storage } from '../core/storage/indexed-db';
import { JsonViewer } from './components/json-viewer';

export class PanelController {
  private tabId: number = 0;
  private activeScreen: 'monitor' | 'workspace' = 'monitor';
  private environments: Environment[] = [];
  private activeEnv: Environment | null = null;
  private collections: Collection[] = [];
  private savedRequests: RequestItem[] = [];
  private history: RequestHistoryItem[] = [];

  // Monitor state
  private requests: CapturedNetworkRequest[] = [];
  private selectedRequestId: string | null = null;
  private runtimeErrors: CapturedJsError[] = [];

  // API Client state
  private openTabs: RequestItem[] = [];
  private activeTabId: string = '';

  async init(): Promise<void> {
    this.detectTabContext();
    this.setupEventListeners();
    await this.loadWorkspaceData();
    this.initDefaultWorkspaceTab();
    this.listenToDevToolsMessages();
  }

  private detectTabContext(): void {
    if (typeof chrome !== 'undefined' && chrome.devtools && chrome.devtools.inspectedWindow) {
      this.tabId = chrome.devtools.inspectedWindow.tabId;
      const targetDisplay = document.getElementById('tabTargetDisplay');
      if (targetDisplay) {
        targetDisplay.textContent = `Tab: ${this.tabId}`;
      }
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

  // --- Main Navigation & Event Listeners ---
  private setupEventListeners(): void {
    const btnNavMonitor = document.getElementById('btnNavMonitor');
    const btnNavWorkspace = document.getElementById('btnNavWorkspace');
    const screenMonitor = document.getElementById('screenMonitor');
    const screenWorkspace = document.getElementById('screenWorkspace');

    btnNavMonitor?.addEventListener('click', () => {
      this.switchToScreen('monitor');
    });

    btnNavWorkspace?.addEventListener('click', () => {
      this.switchToScreen('workspace');
    });

    // Clear monitor
    document.getElementById('btnClearMonitor')?.addEventListener('click', () => {
      this.requests = [];
      this.selectedRequestId = null;
      this.runtimeErrors = [];
      this.updateMonitorMetrics();
      this.renderRequestsTable();
      this.renderRequestDetail();
      this.renderErrorsDrawer();
    });

    // Dismiss errors
    document.getElementById('btnDismissErrors')?.addEventListener('click', () => {
      this.runtimeErrors = [];
      this.renderErrorsDrawer();
      this.updateMonitorMetrics();
    });

    // Search / Filter Monitor
    const searchInput = document.getElementById('netSearchInput') as HTMLInputElement;
    searchInput?.addEventListener('input', () => this.renderRequestsTable());

    // Monitor Detail Tabs (Headers | Payload | Response)
    document.querySelectorAll('.detail-tabs-bar .tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = (e.currentTarget as HTMLElement).dataset.tab;
        document.querySelectorAll('.detail-tabs-bar .tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        if (tab) document.getElementById(tab)?.classList.add('active');
      });
    });

    // Clone captured request to API Client
    document.getElementById('btnCloneToWorkspace')?.addEventListener('click', () => {
      this.cloneSelectedRequestToWorkspace();
    });

    // Toggle Pretty / Raw Response in Monitor
    const btnTogglePretty = document.getElementById('btnTogglePrettyView');
    const jsonViewer = document.getElementById('detailJsonViewer');
    const rawBox = document.getElementById('detailRawResponse');
    btnTogglePretty?.addEventListener('click', () => {
      const isRaw = jsonViewer?.classList.contains('hidden');
      if (isRaw) {
        jsonViewer?.classList.remove('hidden');
        rawBox?.classList.add('hidden');
        btnTogglePretty.textContent = 'Raw Text';
      } else {
        jsonViewer?.classList.add('hidden');
        rawBox?.classList.remove('hidden');
        btnTogglePretty.textContent = 'Pretty View';
      }
    });

    // Copy Response Body
    document.getElementById('btnCopyResponse')?.addEventListener('click', () => {
      const selected = this.requests.find(r => r.id === this.selectedRequestId);
      if (selected && selected.responseBody) {
        navigator.clipboard.writeText(selected.responseBody);
      }
    });

    // --- API Client Navigation & Events ---
    // Sidebar navigation
    document.querySelectorAll('.sidebar-nav .s-nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sec = (e.currentTarget as HTMLElement).dataset.section;
        document.querySelectorAll('.sidebar-nav .s-nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        if (sec) document.getElementById(sec)?.classList.add('active');
      });
    });

    // Config tabs (Params, Headers, Body, Auth)
    document.querySelectorAll('.config-tabs-bar .cfg-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const cfg = (e.currentTarget as HTMLElement).dataset.cfg;
        document.querySelectorAll('.config-tabs-bar .cfg-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.cfg-content').forEach(c => c.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        if (cfg) document.getElementById(cfg)?.classList.add('active');
      });
    });

    // Response view modes (Pretty, Raw, Headers)
    document.querySelectorAll('.resp-view-modes .resp-mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = (e.currentTarget as HTMLElement).dataset.resp;
        document.querySelectorAll('.resp-view-modes .resp-mode-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.resp-pane').forEach(p => p.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        if (mode) document.getElementById(mode)?.classList.add('active');
      });
    });

    // Add Tab Button
    document.getElementById('btnAddRequestTab')?.addEventListener('click', () => {
      this.addNewWorkspaceTab();
    });

    // Send Request Button
    document.getElementById('btnSendRequest')?.addEventListener('click', () => {
      this.sendActiveRequest();
    });

    // Save to Collection Button & Modal
    document.getElementById('btnSaveToCollection')?.addEventListener('click', () => {
      this.openSaveModal();
    });

    document.getElementById('btnCancelSave')?.addEventListener('click', () => {
      (document.getElementById('modalSaveRequest') as HTMLDialogElement)?.close();
    });

    document.getElementById('btnConfirmSave')?.addEventListener('click', () => {
      this.confirmSave();
    });

    // Environment Modal
    document.getElementById('btnCreateEnv')?.addEventListener('click', () => {
      this.openEnvModal();
    });

    document.getElementById('btnCancelEnv')?.addEventListener('click', () => {
      (document.getElementById('modalEnvironment') as HTMLDialogElement)?.close();
    });

    document.getElementById('btnSaveEnv')?.addEventListener('click', () => {
      this.saveEnvModal();
    });

    // Add row buttons
    document.getElementById('btnAddParamRow')?.addEventListener('click', () => {
      this.addParamRow('', '');
    });

    document.getElementById('btnAddHeaderRow')?.addEventListener('click', () => {
      this.addHeaderRow('', '');
    });

    document.getElementById('btnAddEnvVar')?.addEventListener('click', () => {
      this.addEnvVarRow('', '');
    });

    // Format JSON button
    document.getElementById('btnFormatJson')?.addEventListener('click', () => {
      const editor = document.getElementById('reqBodyEditor') as HTMLTextAreaElement;
      if (editor && editor.value) {
        try {
          const parsed = JSON.parse(editor.value);
          editor.value = JSON.stringify(parsed, null, 2);
        } catch {}
      }
    });

    // Active Environment select
    const envSelect = document.getElementById('activeEnvSelect') as HTMLSelectElement;
    envSelect?.addEventListener('change', () => {
      this.activeEnv = this.environments.find(e => e.id === envSelect.value) || null;
    });

    // New Collection button
    document.getElementById('btnCreateCollection')?.addEventListener('click', () => {
      const name = prompt('Collection Name:');
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

  private switchToScreen(screen: 'monitor' | 'workspace'): void {
    this.activeScreen = screen;
    const btnNavMonitor = document.getElementById('btnNavMonitor');
    const btnNavWorkspace = document.getElementById('btnNavWorkspace');
    const screenMonitor = document.getElementById('screenMonitor');
    const screenWorkspace = document.getElementById('screenWorkspace');

    if (screen === 'monitor') {
      btnNavMonitor?.classList.add('active');
      btnNavWorkspace?.classList.remove('active');
      screenMonitor?.classList.remove('hidden');
      screenWorkspace?.classList.add('hidden');
    } else {
      btnNavWorkspace?.classList.add('active');
      btnNavMonitor?.classList.remove('active');
      screenWorkspace?.classList.remove('hidden');
      screenMonitor?.classList.add('hidden');
    }
  }

  // --- Monitor Logic & Traffic Capture ---
  private listenToDevToolsMessages(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'FRONTEND_LENS_NETWORK_REQUEST') {
          this.handleCapturedRequest(msg.data as CapturedNetworkRequest);
        } else if (msg && msg.type === 'FRONTEND_LENS_RUNTIME_ERROR') {
          this.handleCapturedError(msg.data as CapturedJsError);
        }
      });
    }

    if (typeof chrome !== 'undefined' && chrome.devtools && chrome.devtools.network) {
      chrome.devtools.network.onRequestFinished.addListener(async (req) => {
        const adapted = await DevToolsNetworkAdapter.adaptHarRequest(req, this.tabId);
        this.handleCapturedRequest(adapted);
      });
    }
  }

  private handleCapturedRequest(req: CapturedNetworkRequest): void {
    this.requests.unshift(req);
    if (this.requests.length > 500) {
      this.requests.pop();
    }
    this.updateMonitorMetrics();
    this.renderRequestsTable();
  }

  private handleCapturedError(err: CapturedJsError): void {
    err.id = `err_${Date.now()}`;
    err.timestamp = Date.now();
    this.runtimeErrors.unshift(err);
    if (this.runtimeErrors.length > 100) this.runtimeErrors.pop();
    this.updateMonitorMetrics();
    this.renderErrorsDrawer();
  }

  private updateMonitorMetrics(): void {
    const totalRequestsEl = document.getElementById('metricTotalRequests');
    const totalErrorsEl = document.getElementById('metricTotalErrors');
    const avgDurationEl = document.getElementById('metricAvgDuration');

    const totalRequests = this.requests.length;
    const httpErrors = this.requests.filter(r => r.status >= 400 || r.statusClassification === 'app-failure' || r.status === 0).length;
    const totalErrors = httpErrors + this.runtimeErrors.length;

    let avgDuration = 0;
    if (totalRequests > 0) {
      const sum = this.requests.reduce((acc, r) => acc + r.duration, 0);
      avgDuration = Math.round(sum / totalRequests);
    }

    if (totalRequestsEl) totalRequestsEl.textContent = String(totalRequests);
    if (totalErrorsEl) totalErrorsEl.textContent = String(totalErrors);
    if (avgDurationEl) avgDurationEl.textContent = `${avgDuration}ms`;
  }

  private renderErrorsDrawer(): void {
    const drawer = document.getElementById('errorsDrawer');
    const countEl = document.getElementById('errorsCount');
    const listEl = document.getElementById('errorsList');

    if (!drawer || !countEl || !listEl) return;

    if (this.runtimeErrors.length === 0) {
      drawer.classList.add('hidden');
      return;
    }

    drawer.classList.remove('hidden');
    countEl.textContent = String(this.runtimeErrors.length);
    listEl.innerHTML = this.runtimeErrors.map(e => `
      <div class="error-item">
        • ${e.message} ${e.filename ? `(${e.filename}:${e.lineno})` : ''}
      </div>
    `).join('');
  }

  private renderRequestsTable(): void {
    const tbody = document.getElementById('netTableBody');
    const filter = (document.getElementById('netSearchInput') as HTMLInputElement)?.value.toLowerCase() || '';

    if (!tbody) return;

    const filtered = this.requests.filter(r => {
      if (!filter) return true;
      return r.url.toLowerCase().includes(filter) ||
        r.status.toString().includes(filter) ||
        r.method.toLowerCase().includes(filter);
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${this.requests.length === 0 ? 'Waiting for application traffic in inspected tab...' : 'No matching requests.'}</td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    filtered.forEach(r => {
      const tr = document.createElement('tr');
      if (r.id === this.selectedRequestId) tr.classList.add('selected');

      let badgeClass = 'badge-2xx';
      if (r.statusClassification === 'app-failure') badgeClass = 'badge-app-err';
      else if (r.status >= 500) badgeClass = 'badge-5xx';
      else if (r.status >= 400) badgeClass = 'badge-4xx';
      else if (r.status >= 300) badgeClass = 'badge-3xx';
      else if (r.status === 0) badgeClass = 'badge-5xx';

      const statusText = r.statusClassification === 'app-failure' ? `${r.status} APP` : (r.status === 0 ? 'FAIL' : String(r.status));

      tr.innerHTML = `
        <td><span class="status-badge ${badgeClass}">${statusText}</span></td>
        <td><span class="method-tag">${r.method}</span></td>
        <td title="${r.url}">${r.pathname || r.url}</td>
        <td><span class="type-tag">${r.resourceType || 'Fetch'}</span></td>
        <td class="time-tag">${r.duration} ms</td>
      `;

      tr.onclick = () => {
        this.selectedRequestId = r.id;
        this.renderRequestsTable();
        this.renderRequestDetail();
      };

      tbody.appendChild(tr);
    });
  }

  private renderRequestDetail(): void {
    const placeholder = document.getElementById('detailPlaceholder');
    const container = document.getElementById('detailContainer');
    if (!placeholder || !container) return;

    const selected = this.requests.find(r => r.id === this.selectedRequestId);
    if (!selected) {
      placeholder.classList.remove('hidden');
      container.classList.add('hidden');
      return;
    }

    placeholder.classList.add('hidden');
    container.classList.remove('hidden');

    // Header info
    const pill = document.getElementById('detailStatusPill')!;
    pill.textContent = `${selected.status} ${selected.statusText}`;
    pill.className = 'status-badge ' + (selected.status >= 200 && selected.status < 300 ? 'badge-2xx' : 'badge-4xx');
    if (selected.status >= 500 || selected.status === 0) pill.className = 'status-badge badge-5xx';
    if (selected.statusClassification === 'app-failure') pill.className = 'status-badge badge-app-err';

    document.getElementById('detailMethod')!.textContent = selected.method;
    const urlEl = document.getElementById('detailUrlPath')!;
    urlEl.textContent = selected.pathname || selected.url;
    urlEl.title = selected.url;

    // Application error banner
    const appAlert = document.getElementById('detailAppErrorAlert')!;
    const appMsg = document.getElementById('detailAppErrorMessage')!;
    if (selected.statusClassification === 'app-failure') {
      appAlert.classList.remove('hidden');
      appMsg.textContent = selected.applicationErrorMessage || 'Business failure payload detected';
    } else {
      appAlert.classList.add('hidden');
    }

    // Headers
    const resHeadersEl = document.getElementById('detailResponseHeaders')!;
    resHeadersEl.innerHTML = '';
    Redactor.redactHeaderPairs(selected.responseHeaders).forEach(h => {
      const entry = document.createElement('div');
      entry.className = 'header-entry';
      entry.innerHTML = `<span class="header-key">${h.name}:</span><span class="header-val">${h.value}</span>`;
      resHeadersEl.appendChild(entry);
    });

    const reqHeadersEl = document.getElementById('detailRequestHeaders')!;
    reqHeadersEl.innerHTML = '';
    Redactor.redactHeaderPairs(selected.requestHeaders).forEach(h => {
      const entry = document.createElement('div');
      entry.className = 'header-entry';
      entry.innerHTML = `<span class="header-key">${h.name}:</span><span class="header-val">${h.value}</span>`;
      reqHeadersEl.appendChild(entry);
    });

    // Payload
    const payloadBox = document.getElementById('detailPayloadBox')!;
    payloadBox.textContent = selected.requestPayload || 'No request payload sent with this request.';

    // Response
    const jsonTree = document.getElementById('detailJsonViewer')!;
    const rawBox = document.getElementById('detailRawResponse')!;
    rawBox.textContent = selected.responseBody || 'No response content.';

    if (selected.responseBody && selected.isJson) {
      try {
        const parsed = JSON.parse(selected.responseBody);
        jsonTree.classList.remove('hidden');
        rawBox.classList.add('hidden');
        document.getElementById('btnTogglePrettyView')!.textContent = 'Raw Text';
        JsonViewer.render(parsed, jsonTree);
      } catch {
        jsonTree.classList.add('hidden');
        rawBox.classList.remove('hidden');
      }
    } else {
      jsonTree.classList.add('hidden');
      rawBox.classList.remove('hidden');
    }
  }

  private cloneSelectedRequestToWorkspace(): void {
    const selected = this.requests.find(r => r.id === this.selectedRequestId);
    if (!selected) return;

    this.addNewWorkspaceTab({
      name: `${selected.method} ${selected.pathname || '/request'}`,
      method: selected.method as HttpMethod,
      url: selected.url,
      headers: selected.requestHeaders.map(h => ({
        id: Math.random().toString(),
        key: h.name,
        value: h.value,
        enabled: true
      })),
      body: {
        type: selected.requestPayload ? 'json' : 'none',
        raw: selected.requestPayload
      }
    });

    this.switchToScreen('workspace');
  }

  // --- API Client (Postman) Logic ---
  private initDefaultWorkspaceTab(): void {
    if (this.openTabs.length === 0) {
      const defaultReq: RequestItem = {
        id: `tab_${Date.now()}`,
        name: 'GET Users',
        method: 'GET',
        url: 'https://jsonplaceholder.typicode.com/users',
        headers: [{ id: '1', key: 'Accept', value: 'application/json', enabled: true }],
        params: [{ id: 'p1', key: 'limit', value: '10', enabled: true }],
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
      name: initial?.name || 'New Request',
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
    const strip = document.getElementById('requestTabsStrip');
    const addBtn = document.getElementById('btnAddRequestTab');
    if (!strip) return;

    strip.innerHTML = '';
    this.openTabs.forEach(tab => {
      const item = document.createElement('div');
      item.className = `req-tab-item ${tab.id === this.activeTabId ? 'active' : ''}`;
      item.innerHTML = `
        <span class="method-tag">${tab.method}</span>
        <span>${tab.name}</span>
        <span class="tab-x-btn">&times;</span>
      `;

      item.onclick = (e) => {
        if ((e.target as HTMLElement).classList.contains('tab-x-btn')) {
          e.stopPropagation();
          this.closeWorkspaceTab(tab.id);
        } else {
          this.saveActiveFormIntoTab();
          this.activeTabId = tab.id;
          this.renderWorkspaceTabs();
          this.loadActiveTabIntoForm();
        }
      };

      strip.appendChild(item);
    });

    if (addBtn) strip.appendChild(addBtn);
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
    document.querySelectorAll('#paramsRows .kv-row').forEach(row => {
      const k = (row.querySelector('.kv-key') as HTMLInputElement)?.value;
      const v = (row.querySelector('.kv-val') as HTMLInputElement)?.value;
      if (k) tab.params.push({ id: Math.random().toString(), key: k, value: v, enabled: true });
    });

    // Collect headers
    tab.headers = [];
    document.querySelectorAll('#headersRows .kv-row').forEach(row => {
      const k = (row.querySelector('.kv-key') as HTMLInputElement)?.value;
      const v = (row.querySelector('.kv-val') as HTMLInputElement)?.value;
      if (k) tab.headers.push({ id: Math.random().toString(), key: k, value: v, enabled: true });
    });

    // Collect body
    const bodyFormat = (document.querySelector('input[name="reqBodyFormat"]:checked') as HTMLInputElement)?.value as RequestItem['body']['type'];
    tab.body = {
      type: bodyFormat || 'none',
      raw: (document.getElementById('reqBodyEditor') as HTMLTextAreaElement)?.value
    };
  }

  private loadActiveTabIntoForm(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    (document.getElementById('reqMethodSelect') as HTMLSelectElement).value = tab.method;
    (document.getElementById('reqUrlInput') as HTMLInputElement).value = tab.url;
    (document.getElementById('reqExecModeSelect') as HTMLSelectElement).value = tab.executionMode;

    // Params
    const paramsContainer = document.getElementById('paramsRows')!;
    paramsContainer.innerHTML = '';
    tab.params.forEach(p => this.addParamRow(p.key, p.value));
    if (tab.params.length === 0) this.addParamRow('', '');

    // Headers
    const headersContainer = document.getElementById('headersRows')!;
    headersContainer.innerHTML = '';
    tab.headers.forEach(h => this.addHeaderRow(h.key, h.value));
    if (tab.headers.length === 0) this.addHeaderRow('', '');

    // Body
    const bodyRadio = document.querySelector(`input[name="reqBodyFormat"][value="${tab.body.type}"]`) as HTMLInputElement;
    if (bodyRadio) bodyRadio.checked = true;
    (document.getElementById('reqBodyEditor') as HTMLTextAreaElement).value = tab.body.raw || '';
  }

  private addParamRow(k: string, v: string): void {
    const container = document.getElementById('paramsRows')!;
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `
      <input type="text" class="kv-input kv-key" placeholder="Key" value="${k}">
      <input type="text" class="kv-input kv-val" placeholder="Value" value="${v}">
      <button class="btn-micro" style="color:#ef4444;">&times;</button>
    `;
    row.querySelector('button')?.addEventListener('click', () => row.remove());
    container.appendChild(row);
  }

  private addHeaderRow(k: string, v: string): void {
    const container = document.getElementById('headersRows')!;
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `
      <input type="text" class="kv-input kv-key" placeholder="Header" value="${k}">
      <input type="text" class="kv-input kv-val" placeholder="Value" value="${v}">
      <button class="btn-micro" style="color:#ef4444;">&times;</button>
    `;
    row.querySelector('button')?.addEventListener('click', () => row.remove());
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

    const badge = document.getElementById('respStatusBadge')!;
    badge.textContent = 'Sending...';
    badge.className = 'status-badge';

    try {
      const response = await RequestExecutor.execute(tab, this.activeEnv);

      badge.textContent = `${response.status} ${response.statusText}`;
      badge.className = 'status-badge ' + (response.status >= 200 && response.status < 300 ? 'badge-2xx' : 'badge-4xx');
      if (response.status >= 500 || response.status === 0) badge.className = 'status-badge badge-5xx';

      document.getElementById('respDurationText')!.textContent = `${response.duration} ms`;
      document.getElementById('respSizeText')!.textContent = `${response.size} B`;

      const jsonTree = document.getElementById('respJsonTree')!;
      const emptyState = document.getElementById('respEmptyState')!;
      const rawBox = document.getElementById('respRawContent')!;
      const headersContent = document.getElementById('respHeadersContent')!;

      rawBox.textContent = response.body || response.error || 'No content';

      if (response.isJson && response.body) {
        try {
          const parsed = JSON.parse(response.body);
          emptyState.classList.add('hidden');
          jsonTree.classList.remove('hidden');
          JsonViewer.render(parsed, jsonTree);
        } catch {
          emptyState.classList.remove('hidden');
          jsonTree.classList.add('hidden');
        }
      } else {
        emptyState.classList.remove('hidden');
        jsonTree.classList.add('hidden');
      }

      headersContent.innerHTML = Object.entries(response.headers)
        .map(([k, v]) => `<div class="header-entry"><span class="header-key">${k}:</span><span class="header-val">${v}</span></div>`)
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
      badge.textContent = 'Error';
      badge.className = 'status-badge badge-5xx';
      document.getElementById('respRawContent')!.textContent = String(err);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Request';
    }
  }

  // --- Collections, History, Environments Rendering ---
  private renderCollectionsSidebar(): void {
    const list = document.getElementById('collectionsItemsList')!;
    if (this.collections.length === 0) {
      list.innerHTML = '<div class="empty-state">No collections yet.</div>';
      return;
    }
    list.innerHTML = '';
    this.collections.forEach(col => {
      const item = document.createElement('div');
      item.className = 'sidebar-item';
      item.innerHTML = `
        <div class="item-title-row">📁 <strong>${col.name}</strong></div>
        <button class="btn-micro" style="color:#ef4444;">&times;</button>
      `;
      item.querySelector('button')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete collection "${col.name}"?`)) {
          storage.deleteCollection(col.id).then(() => {
            this.collections = this.collections.filter(c => c.id !== col.id);
            this.renderCollectionsSidebar();
          });
        }
      });
      list.appendChild(item);
    });
  }

  private renderHistorySidebar(): void {
    const list = document.getElementById('historyItemsList')!;
    if (this.history.length === 0) {
      list.innerHTML = '<div class="empty-state">No request history yet.</div>';
      return;
    }
    list.innerHTML = '';
    this.history.forEach(h => {
      const item = document.createElement('div');
      item.className = 'sidebar-item';
      item.innerHTML = `
        <div class="item-title-row">
          <span class="method-tag">${h.request.method}</span>
          <span title="${h.request.url}">${h.request.name || h.request.url}</span>
        </div>
        <span class="time-tag">${h.response.status}</span>
      `;
      item.onclick = () => this.addNewWorkspaceTab(h.request);
      list.appendChild(item);
    });
  }

  private renderEnvironmentsDropdown(): void {
    const select = document.getElementById('activeEnvSelect') as HTMLSelectElement;
    if (!select) return;
    select.innerHTML = '<option value="">None</option>';
    this.environments.forEach(env => {
      const opt = document.createElement('option');
      opt.value = env.id;
      opt.textContent = env.name;
      if (this.activeEnv?.id === env.id) opt.selected = true;
      select.appendChild(opt);
    });
  }

  private renderEnvironmentsSidebar(): void {
    const list = document.getElementById('environmentsItemsList')!;
    if (this.environments.length === 0) {
      list.innerHTML = '<div class="empty-state">No environments configured.</div>';
      return;
    }
    list.innerHTML = '';
    this.environments.forEach(env => {
      const item = document.createElement('div');
      item.className = 'sidebar-item';
      item.innerHTML = `
        <div class="item-title-row">🌐 <strong>${env.name}</strong> (${env.variables.length} vars)</div>
        <button class="btn-micro" style="color:#ef4444;">&times;</button>
      `;
      item.querySelector('button')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete environment "${env.name}"?`)) {
          storage.deleteEnvironment(env.id).then(() => {
            this.environments = this.environments.filter(en => en.id !== env.id);
            if (this.activeEnv?.id === env.id) this.activeEnv = null;
            this.renderEnvironmentsDropdown();
            this.renderEnvironmentsSidebar();
          });
        }
      });
      item.onclick = () => this.openEnvModal(env);
      list.appendChild(item);
    });
  }

  // --- Modals ---
  private openSaveModal(): void {
    this.saveActiveFormIntoTab();
    const tab = this.getActiveTab();
    if (!tab) return;

    const modal = document.getElementById('modalSaveRequest') as HTMLDialogElement;
    const nameInput = document.getElementById('saveReqName') as HTMLInputElement;
    const colSelect = document.getElementById('saveReqCollectionSelect') as HTMLSelectElement;

    nameInput.value = tab.name;
    colSelect.innerHTML = '<option value="">(No collection)</option>';
    this.collections.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (tab.collectionId === c.id) opt.selected = true;
      colSelect.appendChild(opt);
    });

    modal.showModal();
  }

  private async confirmSave(): Promise<void> {
    const tab = this.getActiveTab();
    if (!tab) return;

    const modal = document.getElementById('modalSaveRequest') as HTMLDialogElement;
    const name = (document.getElementById('saveReqName') as HTMLInputElement).value.trim();
    const colId = (document.getElementById('saveReqCollectionSelect') as HTMLSelectElement).value;

    tab.name = name || 'Untitled Request';
    tab.collectionId = colId || undefined;
    tab.updatedAt = Date.now();

    await storage.saveRequest(tab);
    this.renderWorkspaceTabs();
    this.renderCollectionsSidebar();
    modal.close();
  }

  private openEnvModal(env?: Environment): void {
    const modal = document.getElementById('modalEnvironment') as HTMLDialogElement;
    const nameInput = document.getElementById('envNameInput') as HTMLInputElement;
    const rows = document.getElementById('envModalVars')!;
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
    const rows = document.getElementById('envModalVars')!;
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `
      <input type="text" class="kv-input env-k" placeholder="Key" value="${k}">
      <input type="text" class="kv-input env-v" placeholder="Value" value="${v}">
      <button class="btn-micro" style="color:#ef4444;">&times;</button>
    `;
    row.querySelector('button')?.addEventListener('click', () => row.remove());
    rows.appendChild(row);
  }

  private async saveEnvModal(): Promise<void> {
    const modal = document.getElementById('modalEnvironment') as HTMLDialogElement;
    const nameInput = document.getElementById('envNameInput') as HTMLInputElement;
    const name = nameInput.value.trim();
    if (!name) return;

    const variables: Environment['variables'] = [];
    document.querySelectorAll('#envModalVars .kv-row').forEach(row => {
      const k = (row.querySelector('.env-k') as HTMLInputElement)?.value.trim();
      const v = (row.querySelector('.env-v') as HTMLInputElement)?.value;
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
    const idx = this.environments.findIndex(e => e.id === env.id);
    if (idx >= 0) this.environments[idx] = env;
    else this.environments.push(env);

    this.activeEnv = env;
    this.renderEnvironmentsDropdown();
    this.renderEnvironmentsSidebar();
    modal.close();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const panel = new PanelController();
  panel.init().catch(err => console.error('Panel init error:', err));
});
