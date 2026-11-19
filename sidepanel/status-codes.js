// What each HTTP status means, from the backend's side, and where to look.
// title: the short name. backend: what the server is telling you.
// front / back: what to check in the front end and in the backend.

export const CODES = {
  200: { title: 'OK', backend: 'The backend handled the request and sent the data back.' },
  201: { title: 'Created', backend: 'The backend saved the new item.' },
  202: { title: 'Accepted', backend: 'The backend queued the work; it may not be finished yet.' },
  204: { title: 'No content', backend: 'It worked, and there is no body to send back.', front: 'Don\'t try to parse a JSON body from this response.' },
  206: { title: 'Partial content', backend: 'Part of a file was sent (range request), usually video or audio.' },
  301: { title: 'Moved permanently', backend: 'The resource lives at a new URL for good.', front: 'Update the URL in your code or environment file.' },
  302: { title: 'Found (redirect)', backend: 'The backend sent you to another URL, often a login page.', front: 'If an API call redirects, the session may have expired.', back: 'APIs usually should return 401 instead of redirecting to a login page.' },
  304: { title: 'Not modified', backend: 'Nothing changed since the last download, so the browser used its cached copy.' },
  307: { title: 'Temporary redirect', backend: 'Try the same request at another URL (method and body are kept).' },
  308: { title: 'Permanent redirect', backend: 'The endpoint moved for good (method and body are kept).' },
  400: { title: 'Bad request', backend: 'The backend couldn\'t understand the request: missing field, wrong type or malformed JSON.', front: 'Compare the Payload tab with what the API expects. Check Content-Type is application/json.', back: 'Request validation rules and the DTO for this endpoint. The response body usually names the field.' },
  401: { title: 'Unauthorized', backend: 'You didn\'t prove who you are: the token is missing, expired or malformed.', front: 'Check the user is logged in and that your interceptor adds the token header to this URL.', back: 'Auth middleware on this route, token expiry, and the header name it expects.' },
  403: { title: 'Forbidden', backend: 'The backend knows who you are, but this user isn\'t allowed to do this.', front: 'Hide or disable the action for users without the role.', back: 'Role or permission checks for this route, and the user\'s roles.' },
  404: { title: 'Not found', backend: 'There\'s nothing at this URL: wrong route, wrong ID, or the item was deleted.', front: 'Compare the URL with the API docs: base URL, path, plural vs singular, and the ID you passed.', back: 'That the route is registered and the item with this ID exists.' },
  405: { title: 'Method not allowed', backend: 'The URL exists but doesn\'t accept this HTTP method.', front: 'Use the method the API expects (GET, POST, PUT, PATCH or DELETE).', back: 'Which methods the route is registered for.' },
  406: { title: 'Not acceptable', backend: 'The backend can\'t send the format you asked for in the Accept header.' },
  408: { title: 'Request timeout', backend: 'The backend waited too long for the request to arrive.', front: 'Large uploads or a slow network.' },
  409: { title: 'Conflict', backend: 'The request clashes with the current data: duplicate item, or someone changed it first.', front: 'Reload the data and retry, or show the user the conflict.', back: 'Unique constraints and version checks.' },
  410: { title: 'Gone', backend: 'This resource was removed on purpose and won\'t come back.' },
  413: { title: 'Payload too large', backend: 'The request body is bigger than the backend allows.', front: 'Compress or resize the file before uploading.', back: 'Body size limits in the server and any proxy.' },
  415: { title: 'Unsupported media type', backend: 'The backend doesn\'t accept this Content-Type.', front: 'Send JSON with Content-Type: application/json, or FormData for files.' },
  422: { title: 'Unprocessable content', backend: 'The data is well formed but fails a validation rule.', front: 'The Response tab usually lists which fields failed. Show those messages in the form.', back: 'The validation rules for this endpoint.' },
  429: { title: 'Too many requests', backend: 'You hit the rate limit.', front: 'Look for duplicate or looping calls. Debounce search inputs.', back: 'Rate limit settings for this route.' },
  500: { title: 'Internal server error', backend: 'The backend code crashed while handling the request. The request itself may be fine.', front: 'Check the payload for unexpected values (null, empty string, wrong ID) that could trigger the bug.', back: 'The server logs at this time: there\'s an exception with a stack trace.' },
  501: { title: 'Not implemented', backend: 'The backend doesn\'t support this feature yet.' },
  502: { title: 'Bad gateway', backend: 'A proxy or gateway couldn\'t get a valid answer from the real server.', front: 'If you use a dev proxy (proxy.conf.json), check its target.', back: 'Whether the API process is running, and the proxy configuration.' },
  503: { title: 'Service unavailable', backend: 'The backend is down, overloaded or in maintenance.', back: 'Server health, deploys in progress, and resource limits.' },
  504: { title: 'Gateway timeout', backend: 'A proxy gave up waiting for the backend to answer.', front: 'Request less data (pagination, filters).', back: 'Slow queries or calls to other services on this route.' },
};

const CLASS_FALLBACK = {
  2: { title: 'Success', backend: 'The backend handled the request.' },
  3: { title: 'Redirect', backend: 'The backend pointed the browser somewhere else.' },
  4: { title: 'Client error', backend: 'The backend rejected the request as wrong in some way.', front: 'Check the URL, payload and headers.', back: 'The response body and the route\'s checks.' },
  5: { title: 'Server error', backend: 'The backend failed while handling the request.', back: 'The server logs at this time.' },
};

export const FAILED = { title: 'Never reached the backend', backend: 'No response came back: CORS, the server is down, DNS, offline, or an ad blocker.', front: 'Open the browser console for a CORS message. Check the API URL and that you\'re online.', back: 'That the server is running and sends Access-Control-Allow-Origin for your dev origin.' };
export const ABORTED = { title: 'Cancelled', backend: 'The page cancelled the request before the backend answered.', front: 'Usually switchMap cancelling an older request, or a component destroyed mid-request. Normally harmless.' };

export function meaning(status, statusText) {
  if (statusText === 'aborted') return ABORTED;
  if (status === 0) return FAILED;
  if (status == null) return null;
  return CODES[status] || CLASS_FALLBACK[String(status)[0]] || { title: `Status ${status}`, backend: '' };
}

// Short version for the status-code breakdown at the top of the list.
export const SHORT = {
  200: 'Backend sent the data', 201: 'Saved', 202: 'Queued', 204: 'Done, no body', 206: 'Part of a file',
  301: 'Moved for good', 302: 'Redirected', 304: 'Served from cache', 307: 'Redirected', 308: 'Moved for good',
  400: 'Request data is wrong', 401: 'Not logged in or token expired', 403: 'Not allowed for this user',
  404: 'Wrong URL or ID', 405: 'Wrong HTTP method', 408: 'Request too slow', 409: 'Clashes with current data',
  413: 'Upload too large', 415: 'Wrong Content-Type', 422: 'Failed validation', 429: 'Rate limited',
  500: 'Backend code crashed', 502: 'Proxy got no answer', 503: 'Backend down', 504: 'Backend too slow',
  failed: 'Never reached the backend', aborted: 'Cancelled by the page',
  js: 'Errors in your front-end code', ng: 'Angular framework errors', warn: 'Warnings',
};
export const shortMeaning = (k) => SHORT[k] || meaning(Number(k))?.title || '';
