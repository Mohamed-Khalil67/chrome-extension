import { Environment, KeyValuePair, RequestItem } from '../models/workspace';

export interface ResolvedRequest {
  id: string;
  name: string;
  method: RequestItem['method'];
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  body: string | undefined;
  executionMode: RequestItem['executionMode'];
}

export class VariableResolver {
  static resolveString(template: string, env: Environment | null): string {
    if (!env || !template) return template;
    const varMap = new Map<string, string>();
    for (const v of env.variables) {
      if (v.enabled && v.key.trim().length > 0) {
        varMap.set(v.key.trim(), v.value);
      }
    }

    return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (match, key: string) => {
      const val = varMap.get(key);
      return val !== undefined ? val : match;
    });
  }

  static resolveRequest(req: RequestItem, env: Environment | null): ResolvedRequest {
    // 1. Resolve URL
    let resolvedUrl = this.resolveString(req.url, env);

    // 2. Resolve query parameters
    const paramsRecord: Record<string, string> = {};
    const enabledParams = req.params.filter(p => p.enabled && p.key.trim().length > 0);
    if (enabledParams.length > 0) {
      try {
        const urlObj = new URL(resolvedUrl);
        for (const p of enabledParams) {
          const k = this.resolveString(p.key.trim(), env);
          const v = this.resolveString(p.value, env);
          urlObj.searchParams.append(k, v);
          paramsRecord[k] = v;
        }
        resolvedUrl = urlObj.toString();
      } catch {
        // If not a full URL yet, format query string manually
        const queryPairs = enabledParams.map(p => {
          const k = encodeURIComponent(this.resolveString(p.key.trim(), env));
          const v = encodeURIComponent(this.resolveString(p.value, env));
          paramsRecord[k] = v;
          return `${k}=${v}`;
        });
        const separator = resolvedUrl.includes('?') ? '&' : '?';
        resolvedUrl = `${resolvedUrl}${separator}${queryPairs.join('&')}`;
      }
    }

    // 3. Resolve headers
    const headersRecord: Record<string, string> = {};
    for (const h of req.headers) {
      if (h.enabled && h.key.trim().length > 0) {
        const k = this.resolveString(h.key.trim(), env);
        const v = this.resolveString(h.value, env);
        headersRecord[k] = v;
      }
    }

    // 4. Resolve Auth
    if (req.auth.type === 'bearer' && req.auth.bearerToken) {
      const token = this.resolveString(req.auth.bearerToken, env);
      headersRecord['Authorization'] = `Bearer ${token}`;
    } else if (req.auth.type === 'basic' && req.auth.basicUsername) {
      const u = this.resolveString(req.auth.basicUsername, env);
      const p = this.resolveString(req.auth.basicPassword ?? '', env);
      const encoded = btoa(`${u}:${p}`);
      headersRecord['Authorization'] = `Basic ${encoded}`;
    } else if (req.auth.type === 'apiKey' && req.auth.apiKeyName && req.auth.apiKeyValue) {
      const name = this.resolveString(req.auth.apiKeyName, env);
      const val = this.resolveString(req.auth.apiKeyValue, env);
      if (req.auth.apiKeyLocation === 'query') {
        try {
          const u = new URL(resolvedUrl);
          u.searchParams.append(name, val);
          resolvedUrl = u.toString();
        } catch {
          const sep = resolvedUrl.includes('?') ? '&' : '?';
          resolvedUrl = `${resolvedUrl}${sep}${encodeURIComponent(name)}=${encodeURIComponent(val)}`;
        }
      } else {
        headersRecord[name] = val;
      }
    }

    // 5. Resolve Body
    let resolvedBody: string | undefined = undefined;
    if (req.body.type !== 'none' && req.body.raw) {
      resolvedBody = this.resolveString(req.body.raw, env);
      if (req.body.type === 'json' && !headersRecord['Content-Type']) {
        headersRecord['Content-Type'] = 'application/json';
      }
    }

    return {
      id: req.id,
      name: req.name,
      method: req.method,
      url: resolvedUrl,
      headers: headersRecord,
      params: paramsRecord,
      body: resolvedBody,
      executionMode: req.executionMode
    };
  }
}
