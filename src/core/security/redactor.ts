import { HeaderPair } from '../models/debugger';
import { KeyValuePair } from '../models/workspace';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
  'token',
  'x-auth-token',
  'sec-websocket-key'
]);

export class Redactor {
  static redactHeaderValue(name: string, value: string): string {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      if (value.length <= 8) return '********';
      return `${value.slice(0, 4)}...[REDACTED]`;
    }
    return value;
  }

  static redactHeaderPairs(headers: HeaderPair[]): HeaderPair[] {
    return headers.map(h => ({
      name: h.name,
      value: this.redactHeaderValue(h.name, h.value)
    }));
  }

  static redactKeyValuePairs(pairs: KeyValuePair[]): KeyValuePair[] {
    return pairs.map(p => ({
      ...p,
      value: this.redactHeaderValue(p.key, p.value)
    }));
  }

  static redactUrl(urlStr: string): string {
    try {
      const parsed = new URL(urlStr);
      const sensitiveParams = ['token', 'key', 'apiKey', 'api_key', 'secret', 'password', 'auth'];
      for (const param of sensitiveParams) {
        if (parsed.searchParams.has(param)) {
          parsed.searchParams.set(param, '[REDACTED]');
        }
      }
      return parsed.toString();
    } catch {
      return urlStr;
    }
  }
}
