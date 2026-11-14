export type StatusClassification =
  | 'success'
  | 'redirect'
  | 'client-error'
  | 'server-error'
  | 'app-failure'
  | 'transport-error';

export interface HeaderPair {
  name: string;
  value: string;
}

export interface CapturedNetworkRequest {
  id: string;
  tabId: number;
  timestamp: number;
  method: string;
  url: string;
  pathname: string;
  resourceType: string;
  status: number;
  statusText: string;
  duration: number;
  size: number;
  mimeType: string;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  requestPayload?: string;
  responseBody?: string;
  isJson: boolean;
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
