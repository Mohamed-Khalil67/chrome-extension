---
name: chrome-devtools-network
description: Guide for capturing and analyzing HTTP requests using the Chrome DevTools Network API, HAR inspection, and response content retrieval.
---

# Chrome DevTools Network Engineering

## Lifecycle & Capturing
- Requests are delivered via `chrome.devtools.network.onRequestFinished`.
- Access response bodies asynchronously using `request.getContent((content, encoding) => {})`.
- Retrieve headers from `request.request.headers` and `request.response.headers`.
- Calculate accurate latencies using `request.time`.

## Status Classification
1. **Transport Failure**: Status 0 or negative, `_error` in HAR.
2. **HTTP Error**: Status >= 400.
3. **Application Failure**: HTTP 200/201 but response JSON contains error flags (e.g. `success === false` or `errors` array).
