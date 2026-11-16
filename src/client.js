// Thin client for the URL2Pin public API (https://url2pin.com, API keys from My account).
// Every call returns { ok, status, json } and never throws on an HTTP error, so the tools can turn
// any failure into a plain sentence for the assistant instead of a stack trace.

export const DEFAULT_API_URL = 'https://csv2pin-backend.onrender.com';
export const VERSION = '0.1.0';
const REQUEST_TIMEOUT_MS = 60_000;

export function createClient({ apiKey, apiUrl = DEFAULT_API_URL, fetchImpl = globalThis.fetch }) {
  const base = String(apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          'x-api-key': String(apiKey || ''),
          'Content-Type': 'application/json',
          'User-Agent': `url2pin-mcp/${VERSION}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, status: 0, json: { error: `Could not reach URL2Pin (${e?.message || e}).`, code: 'network' } };
    }
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json: json && typeof json === 'object' ? json : {} };
  }

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
  };
}
