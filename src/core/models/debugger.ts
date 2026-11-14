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

export interface BoxDimensions {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  border: { top: number; right: number; bottom: number; left: number };
  padding: { top: number; right: number; bottom: number; left: number };
}

export interface InspectedElementData {
  tagName: string;
  id: string;
  selector: string;
  classes: string[];
  dimensions: BoxDimensions;
  computedStyles: {
    display: string;
    position: string;
    overflow: string;
    flexDirection?: string;
    gridTemplateColumns?: string;
    zIndex: string;
    boxSizing: string;
  };
  warnings: string[];
  attributes: Record<string, string>;
}

export interface DebuggerSession {
  tabId: number;
  requests: CapturedNetworkRequest[];
  selectedRequestId?: string;
  inspectedElement?: InspectedElementData;
}
