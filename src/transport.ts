import type { Clock, HttpRequest, HttpResponse, Transport } from './types.js';

/**
 * The default transport: global `fetch` with a per-request timeout. Redirects are not followed,
 * so a request body carrying the API key is never replayed to another location.
 */
export function fetchTransport(fetchImpl: typeof fetch = globalThis.fetch): Transport {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      redirect: 'manual',
      signal,
    };
    if (request.body !== undefined) init.body = request.body;
    const response = await fetchImpl(request.url, init);
    const body = await response.text();
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
