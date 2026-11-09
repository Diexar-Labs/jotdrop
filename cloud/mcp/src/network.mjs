// When jotdrop-mcp may say "cannot reach JotDrop Cloud": only for a real network problem. Node's fetch fails with a
// TypeError "fetch failed" (no connection) or "terminated" (the connection broke while reading); a request that took too
// long ends as AbortError or TimeoutError; a proxy in front of the cloud answers 502 to 504. Any other TypeError is a
// programming error or a bad file and must show as an error, never as a missing internet connection.
export function isOffline(error) {
  if (error instanceof TypeError) return error.message === 'fetch failed' || error.message === 'terminated';
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return true;
  return [502, 503, 504].includes(error?.status);
}
