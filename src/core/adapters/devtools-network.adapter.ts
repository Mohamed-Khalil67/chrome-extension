import { CapturedNetworkRequest, HeaderPair, StatusClassification } from '../models/debugger';

export class DevToolsNetworkAdapter {
  static classifyStatus(
    status: number,
    body?: string,
    mimeType?: string
  ): { classification: StatusClassification; appErrorMessage?: string } {
    if (status === 0 || status < 0) {
      return { classification: 'transport-error' };
    }

    if (status >= 500) {
      return { classification: 'server-error' };
    }

    if (status >= 400) {
      return { classification: 'client-error' };
    }

    if (status >= 300) {
      return { classification: 'redirect' };
    }

    // HTTP 2xx: check for application-level failure in JSON
    if (body && (mimeType?.includes('json') || body.trim().startsWith('{'))) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') {
          if (parsed.success === false) {
            return {
              classification: 'app-failure',
              appErrorMessage: typeof parsed.message === 'string' ? parsed.message : 'Operation returned success=false'
            };
          }
          if (parsed.error !== undefined && parsed.error !== null && parsed.error !== false) {
            const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || 'Application error payload detected';
            return {
              classification: 'app-failure',
              appErrorMessage: String(msg)
            };
          }
          if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
            return {
              classification: 'app-failure',
              appErrorMessage: parsed.errors[0]?.message || 'GraphQL/API errors returned'
            };
          }
        }
      } catch {
        // Not valid JSON, ignore
      }
    }

    return { classification: 'success' };
  }

  static async adaptHarRequest(
    req: chrome.devtools.network.Request,
    tabId: number
  ): Promise<CapturedNetworkRequest> {
    const rawReq = req.request;
    const rawRes = req.response;

    const requestHeaders: HeaderPair[] = (rawReq.headers || []).map(h => ({
      name: h.name,
      value: h.value
    }));

    const responseHeaders: HeaderPair[] = (rawRes.headers || []).map(h => ({
      name: h.name,
      value: h.value
    }));

    let pathname = '';
    try {
      pathname = new URL(rawReq.url).pathname;
    } catch {
      pathname = rawReq.url;
    }

    // Determine resource type (Fetch, XHR, etc.)
    const initiatorType = (req as unknown as { _resourceType?: string })._resourceType || '';
    let resourceType = 'Fetch';
    if (initiatorType) {
      resourceType = initiatorType.toUpperCase();
    } else if (rawRes.content.mimeType?.includes('json')) {
      resourceType = 'Fetch';
    } else if (rawRes.content.mimeType?.includes('html')) {
      resourceType = 'Doc';
    }

    // Retrieve response body asynchronously
    const responseBody = await new Promise<string | undefined>(resolve => {
      try {
        req.getContent((content: string | null) => {
          resolve(content ?? undefined);
        });
      } catch {
        resolve(undefined);
      }
    });

    const isJson =
      rawRes.content.mimeType?.includes('json') ||
      (responseBody ? responseBody.trim().startsWith('{') || responseBody.trim().startsWith('[') : false);

    const { classification, appErrorMessage } = this.classifyStatus(
      rawRes.status,
      responseBody,
      rawRes.content.mimeType
    );

    return {
      id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      tabId,
      timestamp: Date.now(),
      method: rawReq.method,
      url: rawReq.url,
      pathname,
      resourceType,
      status: rawRes.status,
      statusText: rawRes.statusText || '',
      duration: Math.round(req.time || 0),
      size: rawRes.bodySize > 0 ? rawRes.bodySize : rawRes.content.size || 0,
      mimeType: rawRes.content.mimeType || 'unknown',
      requestHeaders,
      responseHeaders,
      requestPayload: rawReq.postData?.text,
      responseBody,
      isJson,
      statusClassification: classification,
      applicationErrorMessage: appErrorMessage
    };
  }
}
