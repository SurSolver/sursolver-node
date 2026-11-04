/**
 * A task object: `type` plus that type's fields, exactly as the API documents them. The client
 * sends it verbatim. Browser task types require `userAgent` (the Windows Chrome User-Agent of
 * the client that will use the result); see `listTaskTypes()` for each type's fields.
 */
export interface Task {
  type: string;
  [field: string]: unknown;
}

/**
 * A task's result. Keys differ per type (`token`, `gRecaptchaResponse`, `cf_clearance`,
 * `cookies`, …) and are passed through untouched. Tokens and cookies are single-use.
 */
export type Solution = Record<string, unknown>;

export type TaskResult =
  | { readonly status: 'processing' }
  | { readonly status: 'ready'; readonly solution: Solution };

export interface SolveResult {
  readonly taskId: string;
  readonly solution: Solution;
}

export type ProxyMode = 'none' | 'optional' | 'required';

/** One entry of `GET /v1/task-types`. */
export interface TaskTypeInfo {
  readonly pageSlug: string | null;
  readonly displayName: string;
  /** Canonical name (the proxy-capable one when a ProxyLess twin exists). */
  readonly taskType: string;
  readonly taskTypeProxyless: string | null;
  readonly aliases: readonly string[];
  readonly proxy: ProxyMode;
  /** Groups of accepted spellings; supply one name per group. */
  readonly required: readonly (readonly string[])[];
  /** Alternatives; supply every field of at least one. */
  readonly anyOf: readonly (readonly string[])[];
  readonly optional: readonly string[];
  readonly solutionKeys: readonly string[];
}

export interface TaskTypeCatalog {
  readonly taskTypes: readonly TaskTypeInfo[];
  /** The complete `errorCode` vocabulary of the solver endpoints. */
  readonly errorCodes: readonly string[];
}

/** One entry of `GET /v1/services`. */
export interface ServiceInfo {
  readonly id: number;
  readonly slug: string;
  readonly displayName: string;
  /** USD price per task as a decimal string, e.g. `"0.0006"`. */
  readonly pricePerRequest: string;
  readonly status: string;
  readonly avgLatencyMs: number | null;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Sends one HTTP request. Resolve with any status; reject only when no response arrived
 * (connection failure, timeout, aborted). Must not follow redirects.
 */
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export interface Clock {
  /** Milliseconds; only differences are used. */
  now(): number;
  /** Waits `ms`; rejects with `signal.reason` when the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ClientOptions {
  /** Default `https://api.sursolver.com`. Plain `http://` only for localhost/loopback. */
  baseUrl?: string;
  /** Per HTTP request. Default 30000. */
  requestTimeoutMs?: number;
  /** Between polls in `solve()`. Default 3000 (the documented cadence). */
  pollIntervalMs?: number;
  /** `solve()` deadline. Default 210000 (60 s queue + 120 s processing + slack). */
  solveTimeoutMs?: number;
  /** `solve()` resubmissions after `ERROR_NO_SLOT_AVAILABLE`. Default 1. */
  maxSubmitRetries?: number;
  /** Referral app id sent with every `createTask`. */
  appId?: string;
  /** Appended to the `User-Agent` header `sursolver-node/<version>`. */
  userAgentSuffix?: string;
  /** Replaces the built-in `fetch` transport (proxies, custom TLS, tests). */
  transport?: Transport;
  /** Replaces the real clock (tests). */
  clock?: Clock;
  /** Jitter source in [0, 1). Default `Math.random`. */
  random?: () => number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface SolveOptions extends RequestOptions {
  pollIntervalMs?: number;
  solveTimeoutMs?: number;
  /** Called once with the task id as soon as the task is accepted (and charged). */
  onTaskCreated?: (taskId: string) => void;
}
