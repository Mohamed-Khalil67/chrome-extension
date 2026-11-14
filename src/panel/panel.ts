import { DevToolsNetworkAdapter } from '../core/adapters/devtools-network.adapter';
import { RequestExecutor } from '../core/execution/request-executor';
import { CurlImporter } from '../core/importers/curl.importer';
import { EnvironmentImporter } from '../core/importers/environment.importer';
import { OpenApiImporter } from '../core/importers/openapi.importer';
import { PostmanImporter } from '../core/importers/postman.importer';
import { CapturedJsError, CapturedNetworkRequest, ResourceCategory } from '../core/models/debugger';
import {
  Collection,
  CollectionFolder,
  CollectionNode,
  CollectionRequest,
  Environment,
  HttpMethod,
  KeyValuePair,
  RequestHistoryItem,
  RequestItem
} from '../core/models/workspace';
import { CollectionTreeService } from '../core/services/collection-tree.service';
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

  // Tree state
  private expandedNodeIds: Set<string> = new Set();
  private treeSearchQuery: string = '';
  private contextTarget: {
    colId: string;
    nodeId?: string;
    nodeType: 'collection' | 'folder' | 'request';
    nodeName: string;
  } | null = null;

  // Monitor state
  private requests: CapturedNetworkRequest[] = [];
  private selectedRequestId: string | null = null;
  private runtimeErrors: CapturedJsError[] = [];
  private activeFilterCategory: 'api' | 'document' | 'asset' | 'all' | 'error' = 'api';
  private filterMethod: string = '';
  private filterStatus: string = '';
  private hideCached: boolean = false;
  private preserveLog: boolean = false;

  // API Client state
  private openTabs: RequestItem[] = [];
  private activeTabId: string = '';
  private activeImportTab: 'impPostman' | 'impOpenApi' | 'impCurl' | 'impEnv' = 'impPostman';

  async init(): Promise<void> {
    this.detectTabContext();
    this.setupEventListeners();
    await this.loadWorkspaceData();
    this.initDefaultWorkspaceTab();
    this.updateMonitorMetrics();
    this.renderRequestsTable();
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

      // Load preserveLog state
      try {
        const pLog = localStorage.getItem('frontend_lens_preserve_log');
        if (pLog !== null) this.preserveLog = pLog === 'true';
      } catch {
        this.preserveLog = false;
      }

      // Load expanded state from localStorage
      try {
        const raw = localStorage.getItem('frontend_lens_expanded');
        if (raw) {
          this.expandedNodeIds = new Set(JSON.parse(raw));
        }
      } catch {
        this.expandedNodeIds = new Set();
      }

      // Normalize & migrate collections without children
      for (const col of this.collections) {
        if (!col.children || col.children.length === 0) {
          const childReqs = this.savedRequests.filter(r => r.collectionId === col.id);
          if (childReqs.length > 0) {
            col.children = childReqs.map(r => ({
              id: r.id,
              name: r.name,
              type: 'request',
              method: r.method,
              request: r
            }));
            await storage.saveCollection(col);
          } else {
            col.children = [];
          }
        }
      }

      // Default expand all collections if initial state is empty
      if (this.expandedNodeIds.size === 0) {
        this.collections.forEach(c => this.expandedNodeIds.add(c.id));
      }

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

    btnNavMonitor?.addEventListener('click', () => this.switchToScreen('monitor'));
    btnNavWorkspace?.addEventListener('click', () => this.switchToScreen('workspace'));

    // Clear monitor buttons (toolbar and top bar)
    document.getElementById('btnClearMonitorLog')?.addEventListener('click', () => {
      this.clearMonitorTraffic();
    });
    document.getElementById('btnClearMonitor')?.addEventListener('click', () => {
      this.clearMonitorTraffic();
    });

    // Preserve Log Checkbox
    const chkPreserveLog = document.getElementById('chkPreserveLog') as HTMLInputElement;
    if (chkPreserveLog) {
      chkPreserveLog.checked = this.preserveLog;
      chkPreserveLog.addEventListener('change', () => {
        this.preserveLog = chkPreserveLog.checked;
        try {
          localStorage.setItem('frontend_lens_preserve_log', String(this.preserveLog));
        } catch {}
      });
    }

    // Dismiss errors
    document.getElementById('btnDismissErrors')?.addEventListener('click', () => {
      this.runtimeErrors = [];
      this.renderErrorsDrawer();
      this.updateMonitorMetrics();
    });

    // 5 Filter Pills (API, Documents, Assets, All, Errors)
    document.querySelectorAll('.filter-buttons-group .filter-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        const cat = (e.currentTarget as HTMLElement).dataset.cat as 'api' | 'document' | 'asset' | 'all' | 'error';
        document.querySelectorAll('.filter-buttons-group .filter-pill').forEach(p => p.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        this.activeFilterCategory = cat;
        this.renderRequestsTable();
      });
    });

    // Search filter with clear button
    const searchInput = document.getElementById('netSearchInput') as HTMLInputElement;
    const searchClearBtn = document.getElementById('btnSearchClear');

    searchInput?.addEventListener('input', () => {
      if (searchInput.value.trim()) {
        searchClearBtn?.classList.remove('hidden');
      } else {
        searchClearBtn?.classList.add('hidden');
      }
      this.renderRequestsTable();
    });

    searchClearBtn?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      searchClearBtn.classList.add('hidden');
      this.renderRequestsTable();
      searchInput?.focus();
    });

    // Keyboard shortcuts: Alt+C to clear traffic
    document.addEventListener('keydown', (e) => {
      if ((e.altKey && e.key.toLowerCase() === 'c') || (e.ctrlKey && e.key.toLowerCase() === 'l')) {
        if (this.activeScreen === 'monitor') {
          e.preventDefault();
          this.clearMonitorTraffic();
        }
      }
    });

    // More Filters Menu
    const btnMoreFilters = document.getElementById('btnToggleMoreFilters');
    const moreMenu = document.getElementById('moreFiltersMenu');
    btnMoreFilters?.addEventListener('click', (e) => {
      e.stopPropagation();
      moreMenu?.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      moreMenu?.classList.add('hidden');
    });

    moreMenu?.addEventListener('click', (e) => e.stopPropagation());

    const filterMethodSelect = document.getElementById('filterMethodSelect') as HTMLSelectElement;
    filterMethodSelect?.addEventListener('change', () => {
      this.filterMethod = filterMethodSelect.value;
      this.renderRequestsTable();
    });

    const filterStatusSelect = document.getElementById('filterStatusSelect') as HTMLSelectElement;
    filterStatusSelect?.addEventListener('change', () => {
      this.filterStatus = filterStatusSelect.value;
      this.renderRequestsTable();
    });

    const chkHideCached = document.getElementById('chkHideCached') as HTMLInputElement;
    chkHideCached?.addEventListener('change', () => {
      this.hideCached = chkHideCached.checked;
      this.renderRequestsTable();
    });

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

    // Save to API Client Modal button
    document.getElementById('btnSaveToApiClient')?.addEventListener('click', () => {
      this.openSaveCapturedModal();
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

    // HTML Search inside Document Response
    const inputHtmlSearch = document.getElementById('inputHtmlSearch') as HTMLInputElement;
    inputHtmlSearch?.addEventListener('input', () => {
      this.performHtmlSearch(inputHtmlSearch.value);
    });

    // --- API Client Navigation & Events ---
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

    // Import Modal
    document.getElementById('btnOpenImportModal')?.addEventListener('click', () => {
      this.openImportModal();
    });

    document.getElementById('btnCancelImport')?.addEventListener('click', () => {
      (document.getElementById('modalImport') as HTMLDialogElement)?.close();
    });

    document.getElementById('btnConfirmImport')?.addEventListener('click', () => {
      this.executeImport();
    });

    // Import Tabs
    document.querySelectorAll('.import-tabs-bar .imp-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const imptab = (e.currentTarget as HTMLElement).dataset.imptab as 'impPostman' | 'impOpenApi' | 'impCurl' | 'impEnv';
        document.querySelectorAll('.import-tabs-bar .imp-tab').forEach(t => t.classList.remove('active'));
        (e.currentTarget as HTMLElement).classList.add('active');
        this.activeImportTab = imptab;
      });
    });

    // File Input for Import
    const fileInput = document.getElementById('importFileInput') as HTMLInputElement;
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const content = evt.target?.result as string;
          const textarea = document.getElementById('importTextarea') as HTMLTextAreaElement;
          if (textarea) textarea.value = content;
        };
        reader.readAsText(file);
      }
    });

    // Add row buttons
    document.getElementById('btnAddParamRow')?.addEventListener('click', () => this.addParamRow('', ''));
    document.getElementById('btnAddHeaderRow')?.addEventListener('click', () => this.addHeaderRow('', ''));
    document.getElementById('btnAddEnvVar')?.addEventListener('click', () => this.addEnvVarRow('', ''));

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

    // Collection Tree Search Input
    const treeSearchInput = document.getElementById('treeSearchInput') as HTMLInputElement;
    treeSearchInput?.addEventListener('input', () => {
      this.treeSearchQuery = treeSearchInput.value;
      this.renderCollectionsSidebar();
    });

    // Expand / Collapse All Tree
    document.getElementById('btnExpandAllTree')?.addEventListener('click', () => {
      this.expandAllTreeNodes();
    });

    document.getElementById('btnCollapseAllTree')?.addEventListener('click', () => {
      this.collapseAllTreeNodes();
    });

    // New Collection button
    document.getElementById('btnCreateCollection')?.addEventListener('click', () => {
      this.handleCreateCollection();
    });

    // Context Menu item actions
    document.getElementById('ctxAddRequest')?.addEventListener('click', () => {
      this.handleContextAddRequest();
    });
    document.getElementById('ctxAddFolder')?.addEventListener('click', () => {
      this.handleContextAddFolder();
    });
    document.getElementById('ctxRenameNode')?.addEventListener('click', () => {
      this.handleContextRename();
    });
    document.getElementById('ctxDeleteNode')?.addEventListener('click', () => {
      this.handleContextDelete();
    });

    // Dismiss context menu on click or Escape
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('treeContextMenu');
      if (menu && !menu.contains(e.target as Node)) {
        this.hideContextMenu();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideContextMenu();
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

    // Support window messages for testing and page bridge
    window.addEventListener('message', (ev) => {
      if (ev.data && typeof ev.data === 'object') {
        if (ev.data.type === 'FRONTEND_LENS_NETWORK_REQUEST') {
          this.handleCapturedRequest(ev.data.data as CapturedNetworkRequest);
        } else if (ev.data.type === 'FRONTEND_LENS_RUNTIME_ERROR') {
          this.handleCapturedError(ev.data.data as CapturedJsError);
        } else if (ev.data.type === 'FRONTEND_LENS_PAGE_NAVIGATED') {
          this.handlePageNavigated(ev.data.url as string);
        }
      }
    });

    if (typeof chrome !== 'undefined' && chrome.devtools && chrome.devtools.network) {
      chrome.devtools.network.onRequestFinished.addListener(async (req) => {
        const adapted = await DevToolsNetworkAdapter.adaptHarRequest(req, this.tabId);
        this.handleCapturedRequest(adapted);
      });

      // Listen for page navigation and reload events
      chrome.devtools.network.onNavigated.addListener((url: string) => {
        this.handlePageNavigated(url);
      });
    }
  }

  private handlePageNavigated(url: string): void {
    if (!this.preserveLog) {
      // By default, refresh cleanly on every reload / navigation
      this.clearMonitorTraffic();
    } else {
      // If user checked "Preserve log", insert a reload / navigation divider
      const navItem: CapturedNetworkRequest = {
        id: `nav_${Date.now()}`,
        tabId: this.tabId,
        timestamp: Date.now(),
        method: 'NAV',
        url: url,
        pathname: url,
        resourceType: 'document',
        category: 'document',
        status: 0,
        statusText: 'Navigated',
        duration: 0,
        size: 0,
        mimeType: 'text/html',
        isCached: false,
        requestHeaders: [],
        responseHeaders: [],
        isJson: false,
        isHtml: true,
        statusClassification: 'success',
        isNavigationDivider: true,
        navigatedUrl: url
      };
      this.requests.unshift(navItem);
      this.renderRequestsTable();
    }
  }

  private clearMonitorTraffic(): void {
    this.requests = [];
    this.selectedRequestId = null;
    this.runtimeErrors = [];
    this.updateMonitorMetrics();
    this.renderRequestsTable();
    this.renderRequestDetail();
    this.renderErrorsDrawer();
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
    const pillErrorsCountEl = document.getElementById('pillErrorsCount');

    // Exclude navigation dividers from request count
    const actualRequests = this.requests.filter(r => !r.isNavigationDivider);
    const totalRequests = actualRequests.length;
    const httpErrors = actualRequests.filter(r => (r.status >= 400 && r.status !== 304) || r.statusClassification === 'app-failure' || r.status === 0).length;
    const totalErrors = httpErrors + this.runtimeErrors.length;

    let avgDuration = 0;
    if (totalRequests > 0) {
      const sum = actualRequests.reduce((acc, r) => acc + r.duration, 0);
      avgDuration = Math.round(sum / totalRequests);
    }

    if (totalRequestsEl) totalRequestsEl.textContent = String(totalRequests);
    if (totalErrorsEl) {
      totalErrorsEl.textContent = String(totalErrors);
      if (totalErrors > 0) totalErrorsEl.classList.add('error');
      else totalErrorsEl.classList.remove('error');
    }
    if (avgDurationEl) avgDurationEl.textContent = `${avgDuration}ms`;

    // Update pill badge on "Errors" filter pill
    if (pillErrorsCountEl) {
      pillErrorsCountEl.textContent = String(totalErrors);
      if (totalErrors > 0) {
        pillErrorsCountEl.classList.remove('hidden');
      } else {
        pillErrorsCountEl.classList.add('hidden');
      }
    }
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
    const searchFilter = (document.getElementById('netSearchInput') as HTMLInputElement)?.value.toLowerCase() || '';

    if (!tbody) return;

    const filtered = this.requests.filter(r => {
      // If it is a navigation divider, always display unless search filter hides it
      if (r.isNavigationDivider) {
        if (searchFilter && !r.url.toLowerCase().includes(searchFilter)) return false;
        return true;
      }

      // 1. Primary Category Filter
      if (this.activeFilterCategory === 'api' && r.category !== 'api') return false;
      if (this.activeFilterCategory === 'document' && r.category !== 'document') return false;
      if (this.activeFilterCategory === 'asset' && r.category !== 'asset') return false;
      if (this.activeFilterCategory === 'error') {
        const isErr = (r.status >= 400 && r.status !== 304) || r.status === 0 || r.statusClassification === 'app-failure';
        if (!isErr) return false;
      }

      // 2. Hide Cached filter
      if (this.hideCached && r.isCached) return false;

      // 3. Method filter
      if (this.filterMethod && r.method.toUpperCase() !== this.filterMethod) return false;

      // 4. Status range filter
      if (this.filterStatus) {
        if (this.filterStatus === '2xx' && (r.status < 200 || r.status >= 300)) return false;
        if (this.filterStatus === '3xx' && (r.status < 300 || r.status >= 400)) return false;
        if (this.filterStatus === '4xx' && (r.status < 400 || r.status >= 500)) return false;
        if (this.filterStatus === '5xx' && r.status < 500) return false;
      }

      // 5. Search text filter
      if (searchFilter) {
        return r.url.toLowerCase().includes(searchFilter) ||
          r.status.toString().includes(searchFilter) ||
          r.method.toLowerCase().includes(searchFilter);
      }

      return true;
    });

    if (filtered.length === 0) {
      const isFilterActive = !!(searchFilter || this.filterMethod || this.filterStatus || this.hideCached || this.activeFilterCategory !== 'api');
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">
            <div class="empty-state-card">
              <div class="empty-state-icon">⚡</div>
              <div class="empty-state-title">${isFilterActive ? 'No Matching Requests' : 'Waiting for Application Traffic'}</div>
              <div class="empty-state-subtitle">${isFilterActive ? 'No captured requests match your current filters. Try selecting a different filter pill or clearing the search.' : 'Reload the inspected tab or trigger API calls in your web application to inspect traffic.'}</div>
              ${!isFilterActive ? '<button class="btn-reload-tab" id="btnEmptyReload">↻ Reload Page</button>' : ''}
            </div>
          </td>
        </tr>
      `;

      tbody.querySelector('#btnEmptyReload')?.addEventListener('click', () => {
        if (typeof chrome !== 'undefined' && chrome.devtools && chrome.devtools.inspectedWindow) {
          chrome.devtools.inspectedWindow.reload({});
        } else {
          window.location.reload();
        }
      });
      return;
    }

    tbody.innerHTML = '';
    filtered.forEach(r => {
      if (r.isNavigationDivider) {
        const tr = document.createElement('tr');
        tr.className = 'nav-divider-row';
        tr.innerHTML = `
          <td colspan="5">
            <span class="nav-divider-badge">⟳ Reload / Navigated to ${r.navigatedUrl || r.url}</span>
          </td>
        `;
        tbody.appendChild(tr);
        return;
      }

      const tr = document.createElement('tr');
      if (r.id === this.selectedRequestId) tr.classList.add('selected');

      let badgeClass = 'badge-2xx';
      if (r.statusClassification === 'app-failure') badgeClass = 'badge-app-err';
      else if (r.status >= 500) badgeClass = 'badge-5xx';
      else if (r.status >= 400) badgeClass = 'badge-4xx';
      else if (r.status === 304) badgeClass = 'badge-2xx'; // 304 is cache success
      else if (r.status >= 300) badgeClass = 'badge-3xx';
      else if (r.status === 0) badgeClass = 'badge-5xx';

      let statusDisplay = String(r.status);
      if (r.statusClassification === 'app-failure') statusDisplay = `${r.status} APP`;
      else if (r.status === 304) statusDisplay = '304 (Cache)';
      else if (r.status === 0) statusDisplay = 'FAIL';

      const methodClass = `tree-method-${r.method.toLowerCase()}`;

      tr.innerHTML = `
        <td><span class="status-badge ${badgeClass}">${statusDisplay}</span></td>
        <td><span class="tree-method-tag ${methodClass}">${r.method}</span></td>
        <td title="${r.url}" class="req-url-cell"><span class="req-path">${r.pathname || r.url}</span></td>
        <td><span class="type-tag">${r.resourceType}</span></td>
        <td class="time-tag ${r.duration > 1000 ? 'time-slow' : ''}">${r.duration} ms</td>
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
    if (selected.status === 304) pill.className = 'status-badge badge-2xx';
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

    // SSR / HTML Document Diagnostic Card
    const ssrCard = document.getElementById('ssrDiagnosticCard')!;
    const htmlSearchBar = document.getElementById('htmlSearchBar')!;
    if (selected.htmlDiagnosis) {
      ssrCard.classList.remove('hidden');
      htmlSearchBar.classList.remove('hidden');
      document.getElementById('ssrDiagTitle')!.textContent = selected.htmlDiagnosis.title;
      document.getElementById('ssrDiagDesc')!.textContent = selected.htmlDiagnosis.description;
    } else {
      ssrCard.classList.add('hidden');
      htmlSearchBar.classList.add('hidden');
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

    // Response Content
    const jsonTree = document.getElementById('detailJsonViewer')!;
    const rawBox = document.getElementById('detailRawResponse')!;
    rawBox.textContent = selected.responseBody || 'No response content available.';

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
      // HTML or Text document
      jsonTree.classList.add('hidden');
      rawBox.classList.remove('hidden');
      document.getElementById('btnTogglePrettyView')!.textContent = 'Pretty View';
    }
  }

  private performHtmlSearch(query: string): void {
    const rawBox = document.getElementById('detailRawResponse')!;
    const matchCountEl = document.getElementById('htmlMatchCount')!;
    const selected = this.requests.find(r => r.id === this.selectedRequestId);

    if (!selected || !selected.responseBody) return;

    if (!query || !query.trim()) {
      rawBox.textContent = selected.responseBody;
      matchCountEl.textContent = '0 matches';
      return;
    }

    const text = selected.responseBody;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();

    let count = 0;
    let pos = 0;
    while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
      count++;
      pos += lowerQuery.length;
    }

    matchCountEl.textContent = `${count} ${count === 1 ? 'match' : 'matches'}`;
  }

  // --- "Save to API Client" Modal Logic ---
  private openSaveCapturedModal(): void {
    const selected = this.requests.find(r => r.id === this.selectedRequestId);
    if (!selected) return;

    const modal = document.getElementById('modalSaveRequest') as HTMLDialogElement;
    modal.dataset.isFromCaptured = 'true';
    const nameInput = document.getElementById('saveReqName') as HTMLInputElement;
    const colSelect = document.getElementById('saveReqCollectionSelect') as HTMLSelectElement;

    nameInput.value = `${selected.method} ${selected.pathname || '/api'}`;
    colSelect.innerHTML = '<option value="">(No collection)</option>';
    this.collections.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      colSelect.appendChild(opt);
    });

    modal.showModal();
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
      if (response.status === 304) badge.className = 'status-badge badge-2xx';
      if (response.status >= 500 || response.status === 0) badge.className = 'status-badge badge-5xx';

      document.getElementById('respDurationText')!.textContent = `${response.duration} ms`;
      document.getElementById('respSizeText')!.textContent = `${response.size} B`;

      const jsonTree = document.getElementById('respJsonTree')!;
      const emptyState = document.getElementById('respEmptyState')!;
      const rawBox = document.getElementById('respRawContent')!;
      const headersContent = document.getElementById('respHeadersContent')!;

      rawBox.textContent = response.body || response.error || 'No content';

      if (response.status === 0 || response.error) {
        emptyState.innerHTML = `<div style="color: #fca5a5; padding: 12px; background: rgba(239,68,68,0.15); border: 1px solid #7f1d1d; border-radius: 6px;"><strong>Request Failed:</strong> ${response.error || 'Network error or CORS restriction'}</div>`;
        emptyState.classList.remove('hidden');
        jsonTree.classList.add('hidden');
      } else if (response.isJson && response.body) {
        try {
          const parsed = JSON.parse(response.body);
          emptyState.classList.add('hidden');
          jsonTree.classList.remove('hidden');
          JsonViewer.render(parsed, jsonTree);
        } catch {
          emptyState.innerHTML = 'Unable to parse response as JSON. Check Raw tab.';
          emptyState.classList.remove('hidden');
          jsonTree.classList.add('hidden');
        }
      } else {
        emptyState.innerHTML = 'Response is not JSON. Switch to <strong>Raw</strong> tab to inspect content.';
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

  // --- Import Modal & Importers Execution ---
  private openImportModal(): void {
    const modal = document.getElementById('modalImport') as HTMLDialogElement;
    const errorBanner = document.getElementById('importErrorBanner')!;
    const textarea = document.getElementById('importTextarea') as HTMLTextAreaElement;
    errorBanner.classList.add('hidden');
    textarea.value = '';
    modal.showModal();
  }

  private async executeImport(): Promise<void> {
    const textarea = document.getElementById('importTextarea') as HTMLTextAreaElement;
    const errorBanner = document.getElementById('importErrorBanner')!;
    const modal = document.getElementById('modalImport') as HTMLDialogElement;
    const content = textarea.value.trim();

    if (!content) {
      errorBanner.textContent = 'Please paste content or select a file to import.';
      errorBanner.classList.remove('hidden');
      return;
    }

    try {
      errorBanner.classList.add('hidden');

      if (this.activeImportTab === 'impPostman') {
        const { collection, requests } = PostmanImporter.parse(content);
        await storage.saveCollection(collection);
        this.collections.push(collection);
        for (const req of requests) {
          await storage.saveRequest(req);
          this.savedRequests.push(req);
        }
        this.renderCollectionsSidebar();
        if (requests.length > 0) this.addNewWorkspaceTab(requests[0]);
      } else if (this.activeImportTab === 'impOpenApi') {
        const { collection, requests } = OpenApiImporter.parse(content);
        await storage.saveCollection(collection);
        this.collections.push(collection);
        for (const req of requests) {
          await storage.saveRequest(req);
          this.savedRequests.push(req);
        }
        this.renderCollectionsSidebar();
        if (requests.length > 0) this.addNewWorkspaceTab(requests[0]);
      } else if (this.activeImportTab === 'impCurl') {
        const parsed = CurlImporter.parse(content);
        this.addNewWorkspaceTab(parsed);
      } else if (this.activeImportTab === 'impEnv') {
        const env = EnvironmentImporter.parse(content);
        await storage.saveEnvironment(env);
        this.environments.push(env);
        this.activeEnv = env;
        this.renderEnvironmentsDropdown();
        this.renderEnvironmentsSidebar();
      }

      modal.close();
    } catch (err: unknown) {
      errorBanner.textContent = err instanceof Error ? err.message : String(err);
      errorBanner.classList.remove('hidden');
    }
  }

  // --- Tree State Persistence & Expansion ---
  private saveExpandedState(): void {
    try {
      localStorage.setItem('frontend_lens_expanded', JSON.stringify(Array.from(this.expandedNodeIds)));
    } catch {
      // Ignore in restricted environments
    }
  }

  private expandAllTreeNodes(): void {
    for (const col of this.collections) {
      this.expandedNodeIds.add(col.id);
      if (col.children) {
        CollectionTreeService.collectAllFolderIds(col.children).forEach(id => this.expandedNodeIds.add(id));
      }
    }
    this.saveExpandedState();
    this.renderCollectionsSidebar();
  }

  private collapseAllTreeNodes(): void {
    this.expandedNodeIds.clear();
    this.saveExpandedState();
    this.renderCollectionsSidebar();
  }

  // --- Modal Prompt Helper ---
  private showTreePrompt(title: string, label: string, defaultValue: string = ''): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = document.getElementById('modalTreePrompt') as HTMLDialogElement;
      const titleEl = document.getElementById('treePromptTitle')!;
      const labelEl = document.getElementById('treePromptLabel')!;
      const inputEl = document.getElementById('treePromptInput') as HTMLInputElement;
      const btnConfirm = document.getElementById('btnConfirmTreePrompt') as HTMLButtonElement;
      const btnCancel = document.getElementById('btnCancelTreePrompt') as HTMLButtonElement;

      titleEl.textContent = title;
      labelEl.textContent = label;
      inputEl.value = defaultValue;

      const cleanup = () => {
        btnConfirm.onclick = null;
        btnCancel.onclick = null;
        inputEl.onkeydown = null;
      };

      btnConfirm.onclick = () => {
        const val = inputEl.value.trim();
        cleanup();
        modal.close();
        resolve(val || null);
      };

      btnCancel.onclick = () => {
        cleanup();
        modal.close();
        resolve(null);
      };

      inputEl.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          btnConfirm.click();
        } else if (e.key === 'Escape') {
          btnCancel.click();
        }
      };

      modal.showModal();
      inputEl.focus();
      inputEl.select();
    });
  }

  // --- Context Menu & Tree Actions ---
  private async handleCreateCollection(): Promise<void> {
    const name = await this.showTreePrompt('Create Collection', 'Collection Name:');
    if (!name) return;

    const col: Collection = {
      id: `col_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name,
      children: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await storage.saveCollection(col);
    this.collections.push(col);
    this.expandedNodeIds.add(col.id);
    this.saveExpandedState();
    this.renderCollectionsSidebar();
  }

  private async handleContextAddFolder(): Promise<void> {
    if (!this.contextTarget) return;
    const target = { ...this.contextTarget };
    this.hideContextMenu();

    const name = await this.showTreePrompt('Create Folder', 'Folder Name:');
    if (!name) return;

    const col = this.collections.find(c => c.id === target.colId);
    if (!col) return;
    col.children = col.children || [];

    const newFolder: CollectionFolder = {
      id: `fld_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name,
      type: 'folder',
      children: []
    };

    const parentFolderId = target.nodeType === 'folder' ? target.nodeId || null : null;
    CollectionTreeService.insertNode(col.children, parentFolderId, newFolder);
    await storage.saveCollection(col);

    if (parentFolderId) this.expandedNodeIds.add(parentFolderId);
    this.expandedNodeIds.add(col.id);
    this.expandedNodeIds.add(newFolder.id);
    this.saveExpandedState();
    this.renderCollectionsSidebar();
  }

  private async handleContextAddRequest(): Promise<void> {
    if (!this.contextTarget) return;
    const target = { ...this.contextTarget };
    this.hideContextMenu();

    const name = await this.showTreePrompt('Create Request', 'Request Name:', 'New Request');
    if (!name) return;

    const col = this.collections.find(c => c.id === target.colId);
    if (!col) return;
    col.children = col.children || [];

    const newReq: RequestItem = {
      id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      collectionId: col.id,
      name,
      method: 'GET',
      url: 'https://jsonplaceholder.typicode.com/todos/1',
      headers: [],
      params: [],
      auth: { type: 'none' },
      body: { type: 'none' },
      executionMode: 'inspected-page',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const reqNode: CollectionRequest = {
      id: newReq.id,
      name: newReq.name,
      type: 'request',
      method: newReq.method,
      request: newReq
    };

    const parentFolderId = target.nodeType === 'folder' ? target.nodeId || null : null;
    CollectionTreeService.insertNode(col.children, parentFolderId, reqNode);
    await storage.saveCollection(col);
    await storage.saveRequest(newReq);
    this.savedRequests.push(newReq);

    if (parentFolderId) this.expandedNodeIds.add(parentFolderId);
    this.expandedNodeIds.add(col.id);
    this.saveExpandedState();

    this.addNewWorkspaceTab(newReq);
    this.renderCollectionsSidebar();
  }

  private async handleContextRename(): Promise<void> {
    if (!this.contextTarget) return;
    const target = { ...this.contextTarget };
    this.hideContextMenu();

    const newName = await this.showTreePrompt('Rename', 'New Name:', target.nodeName);
    if (!newName || newName === target.nodeName) return;

    const col = this.collections.find(c => c.id === target.colId);
    if (!col) return;

    if (target.nodeType === 'collection') {
      col.name = newName;
      col.updatedAt = Date.now();
      await storage.saveCollection(col);
    } else {
      col.children = col.children || [];
      CollectionTreeService.renameNode(col.children, target.nodeId!, newName);
      col.updatedAt = Date.now();
      await storage.saveCollection(col);

      if (target.nodeType === 'request') {
        const req = this.savedRequests.find(r => r.id === target.nodeId);
        if (req) {
          req.name = newName;
          await storage.saveRequest(req);
        }
        const tab = this.openTabs.find(t => t.id === target.nodeId);
        if (tab) {
          tab.name = newName;
          this.renderWorkspaceTabs();
        }
      }
    }

    this.renderCollectionsSidebar();
  }

  private async handleContextDelete(): Promise<void> {
    if (!this.contextTarget) return;
    const target = { ...this.contextTarget };
    this.hideContextMenu();

    if (!confirm(`Are you sure you want to delete "${target.nodeName}"?`)) return;

    if (target.nodeType === 'collection') {
      await storage.deleteCollection(target.colId);
      this.collections = this.collections.filter(c => c.id !== target.colId);
    } else {
      const col = this.collections.find(c => c.id === target.colId);
      if (!col) return;
      col.children = col.children || [];
      CollectionTreeService.removeNode(col.children, target.nodeId!);
      col.updatedAt = Date.now();
      await storage.saveCollection(col);
    }

    this.renderCollectionsSidebar();
  }

  private openContextMenu(
    e: MouseEvent,
    target: { colId: string; nodeId?: string; nodeType: 'collection' | 'folder' | 'request'; nodeName: string }
  ): void {
    this.contextTarget = target;
    const menu = document.getElementById('treeContextMenu');
    if (!menu) return;

    const itemAddReq = document.getElementById('ctxAddRequest');
    const itemAddFld = document.getElementById('ctxAddFolder');

    if (target.nodeType === 'request') {
      itemAddReq?.classList.add('hidden');
      itemAddFld?.classList.add('hidden');
    } else {
      itemAddReq?.classList.remove('hidden');
      itemAddFld?.classList.remove('hidden');
    }

    menu.classList.remove('hidden');

    const menuWidth = 170;
    const menuHeight = 160;
    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;

    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
  }

  private hideContextMenu(): void {
    const menu = document.getElementById('treeContextMenu');
    menu?.classList.add('hidden');
    this.contextTarget = null;
  }

  // --- Collections Sidebar Recursive Tree Rendering ---
  private renderCollectionsSidebar(): void {
    const container = document.getElementById('collectionsItemsList');
    if (!container) return;

    if (this.collections.length === 0) {
      container.innerHTML = '<div class="empty-state">No collections yet. Click Import or + New.</div>';
      return;
    }

    container.innerHTML = '';
    const hasSearch = !!this.treeSearchQuery.trim();

    for (const col of this.collections) {
      const colChildren = col.children || [];

      // Check if collection matches search
      let displayNodes = colChildren;
      if (hasSearch) {
        const { filteredNodes } = CollectionTreeService.filterTree(colChildren, this.treeSearchQuery);
        const colNameMatches = col.name.toLowerCase().includes(this.treeSearchQuery.toLowerCase());
        if (!colNameMatches && filteredNodes.length === 0) {
          continue;
        }
        if (!colNameMatches) {
          displayNodes = filteredNodes;
        }
      }

      const isExpanded = hasSearch ? true : this.expandedNodeIds.has(col.id);

      // Render Collection Root Row
      const colRow = document.createElement('div');
      colRow.className = 'tree-node-row';
      colRow.style.paddingLeft = '6px';

      const chevron = document.createElement('span');
      chevron.className = `tree-chevron ${isExpanded ? 'expanded' : ''}`;
      chevron.textContent = '▶';
      chevron.onclick = (e) => {
        e.stopPropagation();
        if (this.expandedNodeIds.has(col.id)) {
          this.expandedNodeIds.delete(col.id);
        } else {
          this.expandedNodeIds.add(col.id);
        }
        this.saveExpandedState();
        this.renderCollectionsSidebar();
      };

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = '📦';

      const label = document.createElement('span');
      label.className = 'tree-label';
      label.innerHTML = `<strong>${col.name}</strong>`;

      const triggerBtn = document.createElement('button');
      triggerBtn.className = 'tree-actions-trigger';
      triggerBtn.textContent = '•••';
      triggerBtn.title = 'Collection Actions';
      triggerBtn.onclick = (e) => {
        e.stopPropagation();
        this.openContextMenu(e, { colId: col.id, nodeType: 'collection', nodeName: col.name });
      };

      colRow.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openContextMenu(e, { colId: col.id, nodeType: 'collection', nodeName: col.name });
      };

      colRow.onclick = () => {
        if (this.expandedNodeIds.has(col.id)) {
          this.expandedNodeIds.delete(col.id);
        } else {
          this.expandedNodeIds.add(col.id);
        }
        this.saveExpandedState();
        this.renderCollectionsSidebar();
      };

      colRow.appendChild(chevron);
      colRow.appendChild(icon);
      colRow.appendChild(label);
      colRow.appendChild(triggerBtn);
      container.appendChild(colRow);

      // Render Child Nodes if expanded
      if (isExpanded) {
        this.renderTreeNodes(displayNodes, 1, col.id, container, hasSearch);
      }
    }

    if (container.children.length === 0 && hasSearch) {
      container.innerHTML = '<div class="empty-state">No matching requests or folders found.</div>';
    }
  }

  private renderTreeNodes(
    nodes: CollectionNode[],
    depth: number,
    colId: string,
    container: HTMLElement,
    isSearchActive: boolean
  ): void {
    const activeTab = this.getActiveTab();

    for (const node of nodes) {
      if (node.type === 'folder') {
        const isFolderExpanded = isSearchActive ? true : this.expandedNodeIds.has(node.id);

        const folderRow = document.createElement('div');
        folderRow.className = 'tree-node-row';
        folderRow.style.paddingLeft = `${depth * 16 + 6}px`;

        const chevron = document.createElement('span');
        chevron.className = `tree-chevron ${isFolderExpanded ? 'expanded' : ''}`;
        chevron.textContent = '▶';
        chevron.onclick = (e) => {
          e.stopPropagation();
          if (this.expandedNodeIds.has(node.id)) {
            this.expandedNodeIds.delete(node.id);
          } else {
            this.expandedNodeIds.add(node.id);
          }
          this.saveExpandedState();
          this.renderCollectionsSidebar();
        };

        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = isFolderExpanded ? '📂' : '📁';

        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.name;

        const triggerBtn = document.createElement('button');
        triggerBtn.className = 'tree-actions-trigger';
        triggerBtn.textContent = '•••';
        triggerBtn.title = 'Folder Actions';
        triggerBtn.onclick = (e) => {
          e.stopPropagation();
          this.openContextMenu(e, { colId, nodeId: node.id, nodeType: 'folder', nodeName: node.name });
        };

        folderRow.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openContextMenu(e, { colId, nodeId: node.id, nodeType: 'folder', nodeName: node.name });
        };

        folderRow.onclick = () => {
          if (this.expandedNodeIds.has(node.id)) {
            this.expandedNodeIds.delete(node.id);
          } else {
            this.expandedNodeIds.add(node.id);
          }
          this.saveExpandedState();
          this.renderCollectionsSidebar();
        };

        folderRow.appendChild(chevron);
        folderRow.appendChild(icon);
        folderRow.appendChild(label);
        folderRow.appendChild(triggerBtn);
        container.appendChild(folderRow);

        if (isFolderExpanded && Array.isArray(node.children)) {
          this.renderTreeNodes(node.children, depth + 1, colId, container, isSearchActive);
        }
      } else if (node.type === 'request') {
        const reqRow = document.createElement('div');
        const isSelected = (activeTab && activeTab.id === node.request.id) || (activeTab && activeTab.url === node.request.url && activeTab.method === node.request.method);
        reqRow.className = `tree-node-row ${isSelected ? 'active' : ''}`;
        reqRow.style.paddingLeft = `${depth * 16 + 22}px`;

        const methodBadge = document.createElement('span');
        methodBadge.className = `tree-method-tag tree-method-${node.method.toLowerCase()}`;
        methodBadge.textContent = node.method;

        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.name;
        label.title = `${node.method} ${node.request.url}`;

        const triggerBtn = document.createElement('button');
        triggerBtn.className = 'tree-actions-trigger';
        triggerBtn.textContent = '•••';
        triggerBtn.title = 'Request Actions';
        triggerBtn.onclick = (e) => {
          e.stopPropagation();
          this.openContextMenu(e, { colId, nodeId: node.id, nodeType: 'request', nodeName: node.name });
        };

        reqRow.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openContextMenu(e, { colId, nodeId: node.id, nodeType: 'request', nodeName: node.name });
        };

        reqRow.onclick = () => {
          this.addNewWorkspaceTab(node.request);
          this.renderCollectionsSidebar();
        };

        reqRow.appendChild(methodBadge);
        reqRow.appendChild(label);
        reqRow.appendChild(triggerBtn);
        container.appendChild(reqRow);
      }
    }
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
    delete modal.dataset.isFromCaptured;
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
    const modal = document.getElementById('modalSaveRequest') as HTMLDialogElement;
    const name = (document.getElementById('saveReqName') as HTMLInputElement).value.trim();
    const colId = (document.getElementById('saveReqCollectionSelect') as HTMLSelectElement).value;
    const redactOnSave = (document.getElementById('chkRedactSensitiveOnSave') as HTMLInputElement).checked;

    const selectedCaptured = this.requests.find(r => r.id === this.selectedRequestId);

    if (modal.dataset.isFromCaptured === 'true' && selectedCaptured) {
      // Saving captured request from Monitor into API Client collection
      delete modal.dataset.isFromCaptured;

      let headers: KeyValuePair[] = selectedCaptured.requestHeaders.map(h => ({
        id: Math.random().toString(),
        key: h.name,
        value: h.value,
        enabled: true
      }));

      if (redactOnSave) {
        headers = Redactor.redactKeyValuePairs(headers);
      }

      const newReq: RequestItem = {
        id: `req_${Date.now()}`,
        collectionId: colId || undefined,
        name: name || `${selectedCaptured.method} ${selectedCaptured.pathname}`,
        method: selectedCaptured.method as HttpMethod,
        url: selectedCaptured.url,
        headers,
        params: [],
        auth: { type: 'none' },
        body: {
          type: selectedCaptured.requestPayload ? 'json' : 'none',
          raw: selectedCaptured.requestPayload
        },
        executionMode: 'inspected-page',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await storage.saveRequest(newReq);
      this.savedRequests.push(newReq);

      if (colId) {
        const col = this.collections.find(c => c.id === colId);
        if (col) {
          col.children = col.children || [];
          col.children.push({
            id: newReq.id,
            name: newReq.name,
            type: 'request',
            method: newReq.method,
            request: newReq
          });
          await storage.saveCollection(col);
          this.expandedNodeIds.add(col.id);
          this.saveExpandedState();
        }
      }

      this.addNewWorkspaceTab(newReq);
      this.renderCollectionsSidebar();
      modal.close();
      this.switchToScreen('workspace');
      return;
    }

    // Normal save from API Client tab
    const tab = this.getActiveTab();
    if (!tab) return;

    tab.name = name || 'Untitled Request';
    tab.collectionId = colId || undefined;
    tab.updatedAt = Date.now();

    await storage.saveRequest(tab);
    const idx = this.savedRequests.findIndex(r => r.id === tab.id);
    if (idx >= 0) this.savedRequests[idx] = tab;
    else this.savedRequests.push(tab);

    if (tab.collectionId) {
      const col = this.collections.find(c => c.id === tab.collectionId);
      if (col) {
        col.children = col.children || [];
        const existing = CollectionTreeService.findNode(col.children, tab.id);
        if (existing && existing.type === 'request') {
          existing.name = tab.name;
          existing.method = tab.method;
          existing.request = { ...tab };
        } else if (!existing) {
          col.children.push({
            id: tab.id,
            name: tab.name,
            type: 'request',
            method: tab.method,
            request: { ...tab }
          });
        }
        await storage.saveCollection(col);
        this.expandedNodeIds.add(col.id);
        this.saveExpandedState();
      }
    }

    this.renderWorkspaceTabs();
    this.renderCollectionsSidebar();
    modal.close();
  }

  private openSaveCapturedModalFromMonitor(): void {
    const selected = this.requests.find(r => r.id === this.selectedRequestId);
    if (!selected) return;

    const modal = document.getElementById('modalSaveRequest') as HTMLDialogElement;
    modal.dataset.isFromCaptured = 'true';
    const nameInput = document.getElementById('saveReqName') as HTMLInputElement;
    const colSelect = document.getElementById('saveReqCollectionSelect') as HTMLSelectElement;

    nameInput.value = `${selected.method} ${selected.pathname || '/api'}`;
    colSelect.innerHTML = '<option value="">(No collection)</option>';
    this.collections.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      colSelect.appendChild(opt);
    });

    modal.showModal();
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
