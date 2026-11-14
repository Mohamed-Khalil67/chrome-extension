export type StatusClassification =
  | 'success'
  | 'redirect'
  | 'client-error'
  | 'server-error'
  | 'app-failure'
  | 'transport-error';

export type ResourceCategory = 'api' | 'document' | 'asset' | 'other';

export interface HeaderPair {
  name: string;
  value: string;
}

export interface HtmlDiagnosisResult {
  strategy: 'rendered-content' | 'client-shell' | 'undetermined';
  title: string;
  description: string;
  elementCount: number;
  hasRenderedText: boolean;
  detectedShellTags: string[];
}

export interface CapturedNetworkRequest {
  id: string;
  tabId: number;
  timestamp: number;
  method: string;
  url: string;
  pathname: string;
  resourceType: string;
  category: ResourceCategory;
  status: number;
  statusText: string;
  duration: number;
  size: number;
  mimeType: string;
  isCached: boolean;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  requestPayload?: string;
  responseBody?: string;
  isJson: boolean;
  isHtml: boolean;
  htmlDiagnosis?: HtmlDiagnosisResult;
  statusClassification: StatusClassification;
  applicationErrorMessage?: string;
}

export interface CapturedJsError {
  id: string;
  tabId: number;
  timestamp: number;
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
}
