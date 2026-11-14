// Minimal runtime error listener for inspected page

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    try {
      chrome.runtime.sendMessage({
        type: 'FRONTEND_LENS_RUNTIME_ERROR',
        data: {
          message: event.message || 'JavaScript runtime error',
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error?.stack
        }
      }).catch(() => {});
    } catch {}
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason;
      chrome.runtime.sendMessage({
        type: 'FRONTEND_LENS_RUNTIME_ERROR',
        data: {
          message: reason instanceof Error ? reason.message : `Unhandled Promise Rejection: ${String(reason)}`,
          stack: reason instanceof Error ? reason.stack : undefined
        }
      }).catch(() => {});
    } catch {}
  });
}
