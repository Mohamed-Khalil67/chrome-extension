import { HttpMethod, KeyValuePair, RequestItem } from '../models/workspace';

export class CurlImporter {
  static parse(curlCmd: string): Partial<RequestItem> {
    if (!curlCmd || !curlCmd.trim()) {
      throw new Error('cURL command is empty');
    }

    // Normalize command line line-breaks
    const cleanCmd = curlCmd.replace(/\\\r?\n/g, ' ').trim();

    let method: HttpMethod = 'GET';
    let url = '';
    const headers: KeyValuePair[] = [];
    let rawBody = '';
    let bodyType: RequestItem['body']['type'] = 'none';

    // Regex tokenization respecting quotes
    const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    const tokens: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(cleanCmd)) !== null) {
      if (match[1] !== undefined) {
        tokens.push(match[1]);
      } else if (match[2] !== undefined) {
        tokens.push(match[2]);
      } else {
        tokens.push(match[0]);
      }
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;

      if (token === '-X' || token === '--request') {
        const next = tokens[++i];
        if (next) method = next.toUpperCase() as HttpMethod;
      } else if (token === '-H' || token === '--header') {
        const headerStr = tokens[++i];
        if (headerStr) {
          const colonIdx = headerStr.indexOf(':');
          if (colonIdx > 0) {
            const key = headerStr.slice(0, colonIdx).trim();
            const val = headerStr.slice(colonIdx + 1).trim();
            headers.push({
              id: Math.random().toString(),
              key,
              value: val,
              enabled: true
            });
          }
        }
      } else if (
        token === '-d' ||
        token === '--data' ||
        token === '--data-raw' ||
        token === '--data-binary'
      ) {
        const bodyContent = tokens[++i];
        if (bodyContent !== undefined) {
          rawBody = bodyContent;
          bodyType = bodyContent.trim().startsWith('{') || bodyContent.trim().startsWith('[') ? 'json' : 'raw';
          if (method === 'GET') method = 'POST';
        }
      } else if (token.startsWith('http://') || token.startsWith('https://')) {
        url = token;
      }
    }

    if (!url) {
      // Look for any token that looks like a path or url
      for (const t of tokens) {
        if (t.includes('localhost') || t.startsWith('/')) {
          url = t;
          break;
        }
      }
    }

    if (!url) {
      throw new Error('Could not find a valid URL in the cURL command');
    }

    return {
      name: `${method} ${url.split('?')[0]?.split('/').pop() || 'Request'}`,
      method,
      url,
      headers,
      params: [],
      auth: { type: 'none' },
      body: {
        type: bodyType,
        raw: rawBody
      },
      executionMode: 'inspected-page'
    };
  }
}
