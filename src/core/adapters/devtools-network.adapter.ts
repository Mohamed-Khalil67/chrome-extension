import { HtmlInspector } from '../diagnostics/html-inspector';
import { CapturedNetworkRequest, HeaderPair, ResourceCategory, StatusClassification } from '../models/debugger';

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

    // HTTP 304 Not Modified is a successful cache validation, not an error or redirect
    if (status === 304) {
      return { classification: 'success' };
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

  static categorizeResource(
    resourceType: string,
    mimeType: string,
    url: string
  ): ResourceCategory {
    const resType = resourceType.toLowerCase();
    const mime = mimeType.toLowerCase();
    const lowerUrl = url.toLowerCase();

    // 1. Documents
    if (resType === 'document' || mime.includes('text/html') || (!mime && lowerUrl.endsWith('.html'))) {
      return 'document';
    }

    // 2. Assets (Scripts, Stylesheets, Fonts, Images, Media, Vite internal assets)
    const assetTypes = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'font', 'imageset']);
    if (assetTypes.has(resType)) {
      return 'asset';
    }

    const assetExts = ['.js', '.mjs', '.ts', '.css', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.mp4'];
    const hasAssetExt = assetExts.some(ext => lowerUrl.includes(ext));
    if (hasAssetExt || lowerUrl.includes('/@vite/') || lowerUrl.includes('/node_modules/')) {
      return 'asset';
    }

    if (mime.includes('javascript') || mime.includes('css') || mime.includes('image/') || mime.includes('font/')) {
      return 'asset';
    }

    // 3. API (XHR, Fetch, JSON, GraphQL)
    if (resType === 'xhr' || resType === 'fetch') {
      return 'api';
    }

    if (mime.includes('json') || mime.includes('graphql') || mime.includes('xml')) {
      return 'api';
    }

    return 'other';
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

    // Native Chrome DevTools resource type metadata
    const initiatorType = (req as unknown as { _resourceType?: string })._resourceType || '';
    const mimeType = rawRes.content.mimeType || '';
    const category = this.categorizeResource(initiatorType, mimeType, rawReq.url);

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
      mimeType.includes('json') ||
      (responseBody ? responseBody.trim().startsWith('{') || responseBody.trim().startsWith('[') : false);

    const isHtml = category === 'document' || mimeType.includes('html') || (responseBody ? responseBody.trim().startsWith('<!DOCTYPE') || responseBody.trim().startsWith('<html') : false);

    const htmlDiagnosis = isHtml && responseBody ? HtmlInspector.analyze(responseBody) : undefined;

    const { classification, appErrorMessage } = this.classifyStatus(
      rawRes.status,
      responseBody,
      mimeType
    );

    // Cache status detection
    const isCached =
      rawRes.status === 304 ||
      (rawRes as unknown as { _fromCache?: boolean })._fromCache === true ||
      (rawRes as unknown as { _fromDiskCache?: boolean })._fromDiskCache === true ||
      (req.time === 0 && rawRes.status !== 0);

    return {
      id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      tabId,
      timestamp: Date.now(),
      method: rawReq.method,
      url: rawReq.url,
      pathname,
      resourceType: initiatorType ? initiatorType.toUpperCase() : (category === 'document' ? 'Doc' : (category === 'api' ? 'Fetch' : 'Asset')),
      category,
      status: rawRes.status,
      statusText: rawRes.statusText || (rawRes.status === 304 ? 'Not Modified' : ''),
      duration: Math.round(req.time || 0),
      size: rawRes.bodySize > 0 ? rawRes.bodySize : rawRes.content.size || 0,
      mimeType: mimeType || 'unknown',
      isCached,
      requestHeaders,
      responseHeaders,
      requestPayload: rawReq.postData?.text,
      responseBody,
      isJson,
      isHtml,
      htmlDiagnosis,
      statusClassification: classification,
      applicationErrorMessage: appErrorMessage
    };
  }
}
