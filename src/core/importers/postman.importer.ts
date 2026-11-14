import { Collection, HttpMethod, KeyValuePair, RequestItem } from '../models/workspace';

interface PostmanItem {
  name: string;
  item?: PostmanItem[]; // Sub-folder
  request?: {
    method?: string;
    header?: Array<{ key: string; value: string; disabled?: boolean }>;
    url?: string | { raw?: string; host?: string[]; path?: string[]; query?: Array<{ key: string; value: string; disabled?: boolean }> };
    body?: {
      mode?: string;
      raw?: string;
    };
    auth?: {
      type: string;
      bearer?: Array<{ key: string; value: string }>;
      basic?: Array<{ key: string; value: string }>;
      apikey?: Array<{ key: string; value: string }>;
    };
  };
}

export class PostmanImporter {
  static parse(jsonStr: string): { collection: Collection; requests: RequestItem[] } {
    let data: unknown;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      throw new Error('Invalid JSON format for Postman Collection');
    }

    const postman = data as {
      info?: { name?: string; description?: string; _postman_id?: string };
      item?: PostmanItem[];
    };

    if (!postman || !postman.item || !Array.isArray(postman.item)) {
      throw new Error('File does not appear to be a valid Postman Collection (missing item array)');
    }

    const collectionId = `col_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const collectionName = postman.info?.name || 'Imported Postman Collection';

    const collection: Collection = {
      id: collectionId,
      name: collectionName,
      description: postman.info?.description,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const requests: RequestItem[] = [];

    const traverse = (items: PostmanItem[], folderPrefix: string = '') => {
      for (const it of items) {
        if (it.item && Array.isArray(it.item)) {
          // Folder
          const nextPrefix = folderPrefix ? `${folderPrefix} / ${it.name}` : it.name;
          traverse(it.item, nextPrefix);
        } else if (it.request) {
          // Request
          const req = it.request;
          const method = (req.method || 'GET').toUpperCase() as HttpMethod;

          let rawUrl = '';
          const params: KeyValuePair[] = [];

          if (typeof req.url === 'string') {
            rawUrl = req.url;
          } else if (req.url && typeof req.url === 'object') {
            rawUrl = req.url.raw || '';
            if (req.url.query && Array.isArray(req.url.query)) {
              for (const q of req.url.query) {
                if (q.key) {
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

          const headers: KeyValuePair[] = [];
          if (req.header && Array.isArray(req.header)) {
            for (const h of req.header) {
              if (h.key) {
                headers.push({
                  id: Math.random().toString(),
                  key: h.key,
                  value: h.value || '',
                  enabled: !h.disabled
                });
              }
            }
          }

          let bodyType: RequestItem['body']['type'] = 'none';
          let bodyRaw = '';
          if (req.body && req.body.raw) {
            bodyRaw = req.body.raw;
            bodyType = bodyRaw.trim().startsWith('{') || bodyRaw.trim().startsWith('[') ? 'json' : 'raw';
          }

          // Auth
          const authConfig: RequestItem['auth'] = { type: 'none' };
          if (req.auth) {
            if (req.auth.type === 'bearer' && req.auth.bearer) {
              const tokenObj = req.auth.bearer.find(b => b.key === 'token');
              if (tokenObj) {
                authConfig.type = 'bearer';
                authConfig.bearerToken = tokenObj.value;
              }
            } else if (req.auth.type === 'basic' && req.auth.basic) {
              const userObj = req.auth.basic.find(b => b.key === 'username');
              const passObj = req.auth.basic.find(b => b.key === 'password');
              authConfig.type = 'basic';
              authConfig.basicUsername = userObj?.value;
              authConfig.basicPassword = passObj?.value;
            }
          }

          const displayName = folderPrefix ? `[${folderPrefix}] ${it.name}` : it.name;

          requests.push({
            id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            collectionId,
            name: displayName,
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
          });
        }
      }
    };

    traverse(postman.item);

    return { collection, requests };
  }
}
