import {
  Collection,
  CollectionFolder,
  CollectionNode,
  CollectionRequest,
  Environment,
  HttpMethod,
  KeyValuePair,
  RequestItem
} from '../models/workspace';

interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: {
    method?: string;
    header?: Array<{ key: string; value: string; disabled?: boolean; type?: string }>;
    url?: string | {
      raw?: string;
      protocol?: string;
      host?: string[] | string;
      path?: string[] | string;
      query?: Array<{ key: string; value: string; disabled?: boolean }>;
    };
    urlObject?: {
      protocol?: string;
      host?: string[] | string;
      path?: string[] | string;
      query?: Array<{ key: string; value: string; disabled?: boolean }>;
    };
    body?: {
      mode?: string;
      raw?: string;
      urlencoded?: Array<{ key: string; value: string; disabled?: boolean }>;
      formdata?: Array<{ key: string; value: string; disabled?: boolean }>;
    };
    auth?: {
      type: string;
      bearer?: unknown;
      basic?: unknown;
      apikey?: unknown;
    };
  };
}

/**
 * Safely extracts a string value from an auth field that might be
 * an array of {key, value}, an object with basicConfig, an object with key/val, or a string.
 */
function extractAuthValue(container: unknown, targetKey: string): string | undefined {
  if (!container) return undefined;
  if (typeof container === 'string') return container;
  if (Array.isArray(container)) {
    const found = container.find((item: unknown) => {
      return item && typeof item === 'object' && (item as Record<string, unknown>).key === targetKey;
    }) as { value?: string } | undefined;
    return found ? found.value : undefined;
  }
  if (typeof container === 'object') {
    const obj = container as Record<string, unknown>;
    if (obj[targetKey] !== undefined) return String(obj[targetKey]);
    if (Array.isArray(obj.basicConfig)) {
      const found = obj.basicConfig.find((item: unknown) => {
        return item && typeof item === 'object' && (item as Record<string, unknown>).key === targetKey;
      }) as { value?: string } | undefined;
      if (found) return found.value;
    }
  }
  return undefined;
}

export class PostmanImporter {
  /**
   * Fetches Postman collection content directly from a URL.
   * If a Postman Documenter public URL is provided, queries Postman's Documenter Gateway API.
   * Otherwise, fetches the direct URL.
   */
  static async fetchFromUrl(url: string): Promise<string> {
    const trimmed = url.trim();
    if (!trimmed) throw new Error('URL cannot be empty');

    // Check if it's a Postman Documenter URL (e.g. https://documenter.getpostman.com/view/5709532/2s93JqTRWN#...)
    const docMatch = trimmed.match(/documenter\.(?:getpostman|postman)\.com\/view\/([^/?#]+)\/([^/?#]+)/i);
    if (docMatch) {
      const userId = docMatch[1];
      const publishedId = docMatch[2];
      const apiUrl = `https://documenter.gw.postman.com/api/collections/${userId}/${publishedId}?segregateAuth=true&versionTag=latest`;
      const res = await fetch(apiUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch Postman documentation from Gateway API (${res.status} ${res.statusText})`);
      }
      return await res.text();
    }

    // Direct HTTP(S) URL fetch
    const res = await fetch(trimmed);
    if (!res.ok) {
      throw new Error(`Failed to fetch URL (${res.status} ${res.statusText})`);
    }
    return await res.text();
  }

  static parse(jsonStr: string): { collection: Collection; requests: RequestItem[]; environment?: Environment } {
    let data: unknown;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      throw new Error('Invalid JSON format for Postman Collection');
    }

    const postman = data as {
      info?: { name?: string; description?: string; _postman_id?: string };
      item?: PostmanItem[];
      variable?: Array<{ key: string; value: string }>;
    };

    if (!postman || !postman.item || !Array.isArray(postman.item)) {
      throw new Error('File does not appear to be a valid Postman Collection (missing item array)');
    }

    const collectionId = `col_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const collectionName = postman.info?.name || 'Imported Postman Collection';

    const allRequests: RequestItem[] = [];

    const parseItems = (items: PostmanItem[]): CollectionNode[] => {
      const nodes: CollectionNode[] = [];

      for (const it of items) {
        // If it contains children items and is a folder
        if (it.item && Array.isArray(it.item) && (it.item.length > 0 || !it.request)) {
          const folderId = `fld_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          const childNodes = parseItems(it.item);
          const folderNode: CollectionFolder = {
            id: folderId,
            name: it.name || 'Folder',
            type: 'folder',
            children: childNodes
          };
          nodes.push(folderNode);
        } else if (it.request) {
          const req = it.request;
          const method = (req.method || 'GET').toUpperCase() as HttpMethod;

          let rawUrl = '';
          const params: KeyValuePair[] = [];

          // 1. URL extraction & reconstruction
          if (typeof req.url === 'string') {
            rawUrl = req.url;
          } else if (req.url && typeof req.url === 'object') {
            rawUrl = req.url.raw || '';
            if (!rawUrl) {
              const protocol = req.url.protocol ? `${req.url.protocol}://` : '';
              const host = Array.isArray(req.url.host) ? req.url.host.join('.') : (req.url.host || '');
              const path = Array.isArray(req.url.path) ? req.url.path.join('/') : (req.url.path || '');
              rawUrl = `${protocol}${host}${path ? (path.startsWith('/') ? path : '/' + path) : ''}`;
            }

            if (req.url.query && Array.isArray(req.url.query)) {
              for (const q of req.url.query) {
                if (q && q.key) {
                  params.push({
                    id: Math.random().toString(),
                    key: q.key,
                    value: q.value || '',
                    enabled: !q.disabled
                  });
                }
              }
            }
          }

          // Fallback to urlObject if present (common in Postman Documenter exports)
          if (!rawUrl && req.urlObject) {
            const u = req.urlObject;
            const protocol = u.protocol ? `${u.protocol}://` : '';
            const host = Array.isArray(u.host) ? u.host.join('.') : (u.host || '');
            const path = Array.isArray(u.path) ? u.path.join('/') : (u.path || '');
            rawUrl = `${protocol}${host}${path ? (path.startsWith('/') ? path : '/' + path) : ''}`;
          }

          // 2. Headers extraction
          const headers: KeyValuePair[] = [];
          if (req.header && Array.isArray(req.header)) {
            for (const h of req.header) {
              if (h && h.key) {
                headers.push({
                  id: Math.random().toString(),
                  key: h.key,
                  value: h.value || '',
                  enabled: !h.disabled
                });
              }
            }
          }

          // 3. Body extraction
          let bodyType: RequestItem['body']['type'] = 'none';
          let bodyRaw = '';
          if (req.body) {
            if (req.body.raw) {
              bodyRaw = req.body.raw;
              bodyType = bodyRaw.trim().startsWith('{') || bodyRaw.trim().startsWith('[') ? 'json' : 'raw';
            } else if (req.body.mode === 'urlencoded' && Array.isArray(req.body.urlencoded)) {
              bodyType = 'raw';
              bodyRaw = req.body.urlencoded.filter(u => !u.disabled).map(u => `${encodeURIComponent(u.key)}=${encodeURIComponent(u.value)}`).join('&');
            } else if (req.body.mode === 'formdata' && Array.isArray(req.body.formdata)) {
              bodyType = 'raw';
              bodyRaw = JSON.stringify(req.body.formdata.filter(f => !f.disabled).reduce((acc, f) => ({ ...acc, [f.key]: f.value }), {}), null, 2);
            }
          }

          // 4. Safe Auth extraction
          const authConfig: RequestItem['auth'] = { type: 'none' };
          if (req.auth) {
            if (req.auth.type === 'bearer') {
              const token = extractAuthValue(req.auth.bearer, 'token');
              if (token) {
                authConfig.type = 'bearer';
                authConfig.bearerToken = token;
              }
            } else if (req.auth.type === 'basic') {
              const username = extractAuthValue(req.auth.basic, 'username');
              const password = extractAuthValue(req.auth.basic, 'password');
              authConfig.type = 'basic';
              authConfig.basicUsername = username;
              authConfig.basicPassword = password;
            } else if (req.auth.type === 'apikey') {
              const key = extractAuthValue(req.auth.apikey, 'key');
              const value = extractAuthValue(req.auth.apikey, 'value');
              if (key && value) {
                authConfig.type = 'bearer';
                authConfig.bearerToken = `${key}: ${value}`;
              }
            }
          }

          const reqItem: RequestItem = {
            id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            collectionId,
            name: it.name || 'Unnamed Request',
            method,
            url: rawUrl,
            headers,
            params,
            auth: authConfig,
            body: {
              type: bodyType,
              raw: bodyRaw
            },
            executionMode: 'inspected-page',
            createdAt: Date.now(),
            updatedAt: Date.now()
          };

          allRequests.push(reqItem);

          const reqNode: CollectionRequest = {
            id: reqItem.id,
            name: reqItem.name,
            type: 'request',
            method: reqItem.method,
            request: reqItem
          };

          nodes.push(reqNode);
        }
      }

      return nodes;
    };

    const treeNodes = parseItems(postman.item);

    const collection: Collection = {
      id: collectionId,
      name: collectionName,
      description: postman.info?.description,
      children: treeNodes,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Extract Environment variables if present in collection
    let environment: Environment | undefined;
    if (postman.variable && Array.isArray(postman.variable) && postman.variable.length > 0) {
      const vars: KeyValuePair[] = [];
      for (const v of postman.variable) {
        if (v && v.key) {
          vars.push({
            id: Math.random().toString(),
            key: v.key,
            value: v.value || '',
            enabled: true
          });
        }
      }
      if (vars.length > 0) {
        environment = {
          id: `env_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          name: `${collectionName} Env`,
          variables: vars,
          isActive: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      }
    }

    return { collection, requests: allRequests, environment };
  }
}
