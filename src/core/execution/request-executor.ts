import { Environment, ExecutionResponse, RequestItem } from '../models/workspace';
import { ResolvedRequest, VariableResolver } from '../services/variable-resolver';

export class RequestExecutor {
  static async execute(req: RequestItem, env: Environment | null): Promise<ExecutionResponse> {
    const resolved = VariableResolver.resolveRequest(req, env);

    if (resolved.executionMode === 'inspected-page') {
      return this.executeInInspectedPage(resolved);
    } else {
      return this.executeInExtensionContext(resolved);
    }
  }

  static async executeInExtensionContext(req: ResolvedRequest): Promise<ExecutionResponse> {
    const startTime = performance.now();
    try {
      const options: RequestInit = {
        method: req.method,
        headers: req.headers
      };

      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
        options.body = req.body;
      }

      const res = await fetch(req.url, options);
      const duration = Math.round(performance.now() - startTime);
      const text = await res.text();

      const headers: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        headers[key] = val;
      });

      const contentType = headers['content-type'] || '';
      const isJson = contentType.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[');

      return {
        status: res.status,
        statusText: res.statusText,
        duration,
        size: new Blob([text]).size,
        headers,
        body: text,
        isJson,
        timestamp: Date.now()
      };
    } catch (err: unknown) {
      const duration = Math.round(performance.now() - startTime);
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        status: 0,
        statusText: 'Failed',
        duration,
        size: 0,
        headers: {},
        body: '',
        isJson: false,
        timestamp: Date.now(),
        error: errorMsg
      };
    }
  }

  static async executeInInspectedPage(req: ResolvedRequest): Promise<ExecutionResponse> {
    if (typeof chrome === 'undefined' || !chrome.devtools || !chrome.devtools.inspectedWindow) {
      // Fallback if not running in active DevTools window
      return this.executeInExtensionContext(req);
    }

    const payload = JSON.stringify({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body
    });

    const script = `
      (async () => {
        const payload = ${payload};
        const startTime = performance.now();
        try {
          const opts = {
            method: payload.method,
            headers: payload.headers,
            credentials: 'include'
          };
          if (payload.method !== 'GET' && payload.method !== 'HEAD' && payload.body !== undefined) {
            opts.body = payload.body;
          }
          const res = await window.fetch(payload.url, opts);
          const duration = Math.round(performance.now() - startTime);
          const text = await res.text();
          const headers = {};
          res.headers.forEach((v, k) => { headers[k] = v; });
          return JSON.stringify({
            status: res.status,
            statusText: res.statusText,
            duration,
            headers,
            body: text,
            timestamp: Date.now()
          });
        } catch (err) {
          const duration = Math.round(performance.now() - startTime);
          return JSON.stringify({
            status: 0,
            statusText: 'Failed',
            duration,
            headers: {},
            body: '',
            error: err && err.message ? err.message : String(err),
            timestamp: Date.now()
          });
        }
      })()
    `;

    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval(script, (result, exceptionInfo) => {
        if (exceptionInfo && exceptionInfo.isException) {
          resolve({
            status: 0,
            statusText: 'Exception',
            duration: 0,
            size: 0,
            headers: {},
            body: '',
            isJson: false,
            timestamp: Date.now(),
            error: exceptionInfo.value || 'Script evaluation exception in inspected page'
          });
          return;
        }

        try {
          const parsed = typeof result === 'string' ? JSON.parse(result) : result;
          const bodyText = parsed.body || '';
          const isJson = bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[');
          resolve({
            status: parsed.status || 0,
            statusText: parsed.statusText || '',
            duration: parsed.duration || 0,
            size: new Blob([bodyText]).size,
            headers: parsed.headers || {},
            body: bodyText,
            isJson,
            timestamp: parsed.timestamp || Date.now(),
            error: parsed.error
          });
        } catch {
          resolve({
            status: 0,
            statusText: 'Parse Error',
            duration: 0,
            size: 0,
            headers: {},
            body: '',
            isJson: false,
            timestamp: Date.now(),
            error: 'Failed to parse execution result from inspected window'
          });
        }
      });
    });
  }
}
