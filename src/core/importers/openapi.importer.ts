import YAML from 'yaml';
import {
  Collection,
  CollectionFolder,
  CollectionNode,
  CollectionRequest,
  HttpMethod,
  KeyValuePair,
  RequestItem
} from '../models/workspace';

interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: 'query' | 'header' | 'path' | 'cookie';
    required?: boolean;
    schema?: { default?: unknown; example?: unknown; type?: string };
  }>;
  requestBody?: {
    content?: {
      'application/json'?: {
        schema?: Record<string, unknown>;
        example?: unknown;
      };
    };
  };
}

export class OpenApiImporter {
  static parse(content: string): { collection: Collection; requests: RequestItem[] } {
    if (!content || !content.trim()) {
      throw new Error('OpenAPI content is empty');
    }

    let spec: Record<string, unknown>;
    try {
      // Try JSON first
      spec = JSON.parse(content);
    } catch {
      try {
        // Fallback to YAML
        spec = YAML.parse(content) as Record<string, unknown>;
      } catch (yamlErr: unknown) {
        throw new Error(`Failed to parse OpenAPI document as JSON or YAML: ${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}`);
      }
    }

    if (!spec || typeof spec !== 'object') {
      throw new Error('Invalid OpenAPI document structure');
    }

    const info = (spec.info as { title?: string; description?: string }) || {};
    const collectionId = `col_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const collectionName = info.title || 'OpenAPI Import';

    // Determine base URL
    let baseUrl = '{{baseUrl}}';
    if (Array.isArray(spec.servers) && spec.servers.length > 0) {
      const s = spec.servers[0] as { url?: string };
      if (s && s.url && s.url !== '/') {
        baseUrl = s.url.replace(/\/$/, '');
      }
    } else if (typeof spec.host === 'string') {
      const scheme = Array.isArray(spec.schemes) && spec.schemes.length > 0 ? spec.schemes[0] : 'https';
      baseUrl = `${scheme}://${spec.host}${typeof spec.basePath === 'string' ? spec.basePath.replace(/\/$/, '') : ''}`;
    }

    const allRequests: RequestItem[] = [];
    const folderGroups = new Map<string, CollectionRequest[]>();
    const rootRequests: CollectionRequest[] = [];

    const paths = (spec.paths as Record<string, Record<string, OpenApiOperation>>) || {};
    const validMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

    for (const [pathStr, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;

      for (const [methodKey, op] of Object.entries(pathItem)) {
        const lowerMethod = methodKey.toLowerCase();
        if (!validMethods.has(lowerMethod)) continue;

        const method = lowerMethod.toUpperCase() as HttpMethod;
        const summary = op.summary || op.operationId || `${method} ${pathStr}`;

        // Determine Folder: tag first, then logical path segment
        let folderName: string | null = null;
        if (Array.isArray(op.tags) && op.tags.length > 0 && op.tags[0]?.trim()) {
          folderName = op.tags[0].trim();
        } else {
          // Path grouping: e.g. /api/v1/users/{id} -> 'Users'
          const segments = pathStr.split('/').filter(s => s && !s.startsWith('{') && !s.startsWith(':'));
          const meaningful = segments.filter(s => !['api', 'v1', 'v2', 'v3'].includes(s.toLowerCase()));
          if (meaningful.length > 0) {
            const raw = meaningful[0]!;
            folderName = raw.charAt(0).toUpperCase() + raw.slice(1);
          }
        }

        // Path / URL
        let finalPath = pathStr;
        const params: KeyValuePair[] = [];
        const headers: KeyValuePair[] = [];

        if (Array.isArray(op.parameters)) {
          for (const p of op.parameters) {
            const defaultVal = p.schema?.default !== undefined ? String(p.schema.default) : (p.schema?.example !== undefined ? String(p.schema.example) : '');
            if (p.in === 'query') {
              params.push({
                id: Math.random().toString(),
                key: p.name,
                value: defaultVal,
                enabled: true
              });
            } else if (p.in === 'header') {
              headers.push({
                id: Math.random().toString(),
                key: p.name,
                value: defaultVal,
                enabled: true
              });
            } else if (p.in === 'path') {
              finalPath = finalPath.replace(`{${p.name}}`, defaultVal || `:${p.name}`);
            }
          }
        }

        // Body
        let bodyType: RequestItem['body']['type'] = 'none';
        let bodyRaw = '';

        if (op.requestBody?.content?.['application/json']) {
          bodyType = 'json';
          const jsonContent = op.requestBody.content['application/json'];
          if (jsonContent.example !== undefined) {
            bodyRaw = JSON.stringify(jsonContent.example, null, 2);
          } else if (jsonContent.schema) {
            const props = (jsonContent.schema.properties as Record<string, { type?: string; example?: unknown }>) || {};
            const mockObj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(props)) {
              mockObj[k] = v.example !== undefined ? v.example : (v.type === 'number' ? 0 : (v.type === 'boolean' ? true : 'string'));
            }
            bodyRaw = Object.keys(mockObj).length > 0 ? JSON.stringify(mockObj, null, 2) : '{}';
          }
          headers.push({ id: Math.random().toString(), key: 'Content-Type', value: 'application/json', enabled: true });
        }

        const fullUrl = `${baseUrl}${finalPath.startsWith('/') ? finalPath : '/' + finalPath}`;

        const reqItem: RequestItem = {
          id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          collectionId,
          name: summary,
          method,
          url: fullUrl,
          headers,
          params,
          auth: { type: 'none' },
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

        if (folderName) {
          if (!folderGroups.has(folderName)) {
            folderGroups.set(folderName, []);
          }
          folderGroups.get(folderName)!.push(reqNode);
        } else {
          rootRequests.push(reqNode);
        }
      }
    }

    if (allRequests.length === 0) {
      throw new Error('No valid API path operations found in OpenAPI specification');
    }

    const treeNodes: CollectionNode[] = [];

    // Add folder groups
    for (const [fName, fRequests] of folderGroups.entries()) {
      const folderNode: CollectionFolder = {
        id: `fld_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        name: fName,
        type: 'folder',
        children: fRequests
      };
      treeNodes.push(folderNode);
    }

    // Add root requests
    treeNodes.push(...rootRequests);

    const collection: Collection = {
      id: collectionId,
      name: collectionName,
      description: info.description,
      children: treeNodes,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    return { collection, requests: allRequests };
  }
}
