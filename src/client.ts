import {
  ApiError,
  apiErrorFor,
  ConfigurationError,
  NoSlotAvailableError,
  type Operation,
  ProtocolError,
  SolveTimeoutError,
  type SurSolverError,
  TransportError,
} from './errors.js';
import { fetchTransport, systemClock } from './transport.js';
import type {
  ClientOptions,
  Clock,
  HttpRequest,
  HttpResponse,
  ProxyMode,
  RequestOptions,
  ServiceInfo,
  Solution,
  SolveOptions,
  SolveResult,
  Task,
  TaskResult,
  TaskTypeCatalog,
  TaskTypeInfo,
  Transport,
} from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://api.sursolver.com';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_SOLVE_TIMEOUT_MS = 210_000;
export const DEFAULT_MAX_SUBMIT_RETRIES = 1;
/** Upper bound of the random delay added to a submit retry, so parallel callers spread out. */
export const SUBMIT_RETRY_JITTER_MS = 1_000;

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Typed reads of catalog entries; a missing or mistyped field is a ProtocolError. */
function entryReader(operation: Operation) {
  const fail = (key: string, expected: string): ProtocolError =>
    new ProtocolError(operation, `catalog field ${key} is not ${expected}`);
  return {
    object(value: unknown): JsonObject {
      if (!isJsonObject(value)) throw new ProtocolError(operation, 'a catalog entry is not an object');
      return value;
    },
    text(entry: JsonObject, key: string): string {
      const value = entry[key];
      if (typeof value !== 'string') throw fail(key, 'a string');
      return value;
    },
    optionalText(entry: JsonObject, key: string): string | null {
      const value = entry[key] ?? null;
      if (value !== null && typeof value !== 'string') throw fail(key, 'a string or null');
      return value;
    },
    integer(entry: JsonObject, key: string): number {
      const value = entry[key];
      if (typeof value !== 'number' || !Number.isInteger(value)) throw fail(key, 'an integer');
      return value;
    },
    texts(entry: JsonObject, key: string): string[] {
      const value = entry[key];
      if (!isStringList(value)) throw fail(key, 'a list of strings');
      return value;
    },
    groups(entry: JsonObject, key: string): string[][] {
      const value = entry[key];
      if (!Array.isArray(value) || !value.every(isStringList)) throw fail(key, 'a list of string lists');
      return value;
    },
  };
}

function positiveMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError(`${name} must be a positive number of milliseconds`);
  }
  return value;
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError('baseUrl is not a valid URL');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS[url.hostname] === true;
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new ConfigurationError('baseUrl must use https:// (plain http:// only for localhost)');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ConfigurationError('baseUrl must not carry credentials, a query or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Client for the SurSolver solver API. The API key travels only in request bodies and never
 * appears in errors, logs or `util.inspect` output.
 */
export class SurSolver {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #requestTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #solveTimeoutMs: number;
  readonly #maxSubmitRetries: number;
  readonly #appId: string | undefined;
  readonly #userAgent: string;
  readonly #transport: Transport;
  readonly #clock: Clock;
  readonly #random: () => number;

  constructor(apiKey: string, options: ClientOptions = {}) {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new ConfigurationError('apiKey must be a non-empty string');
    }
    if (apiKey.trim() !== apiKey) {
      throw new ConfigurationError('apiKey has leading or trailing whitespace');
    }
    this.#apiKey = apiKey;
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#requestTimeoutMs = positiveMs(
      'requestTimeoutMs',
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.#pollIntervalMs = positiveMs('pollIntervalMs', options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.#solveTimeoutMs = positiveMs('solveTimeoutMs', options.solveTimeoutMs, DEFAULT_SOLVE_TIMEOUT_MS);
    const retries = options.maxSubmitRetries ?? DEFAULT_MAX_SUBMIT_RETRIES;
    if (!Number.isInteger(retries) || retries < 0) {
      throw new ConfigurationError('maxSubmitRetries must be a non-negative integer');
    }
    this.#maxSubmitRetries = retries;
    const appId = options.appId?.trim();
    this.#appId = appId === undefined || appId === '' ? undefined : appId;
    const suffix = options.userAgentSuffix;
    if (suffix !== undefined && !/^[\x20-\x7E]+$/.test(suffix)) {
      throw new ConfigurationError('userAgentSuffix must be printable ASCII');
    }
    this.#userAgent = suffix === undefined ? `sursolver-node/${VERSION}` : `sursolver-node/${VERSION} ${suffix}`;
    this.#transport = options.transport ?? fetchTransport();
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
  }

  /** Submits a task. The task is charged once this resolves. Never retried automatically. */
  async createTask(task: Task, options: RequestOptions = {}): Promise<string> {
    const payload: JsonObject = { clientKey: this.#apiKey, task };
    if (this.#appId !== undefined) payload.appId = this.#appId;
    const body = await this.#solverCall('createTask', '/createTask', payload, options.signal);
    const taskId = body.taskId;
    if (typeof taskId !== 'string' || taskId === '') {
      throw new ProtocolError('createTask', 'errorId 0 without a taskId');
    }
    return taskId;
  }

  /** Reads a task's state once. A terminal failure throws `TaskFailedError`. */
  async getTaskResult(taskId: string, options: RequestOptions = {}): Promise<TaskResult> {
    const body = await this.#solverCall(
      'getTaskResult',
      '/getTaskResult',
      { clientKey: this.#apiKey, taskId },
      options.signal,
      taskId,
    );
    if (body.status === 'processing') return { status: 'processing' };
    if (body.status === 'ready') {
      if (!isJsonObject(body.solution)) {
        throw new ProtocolError('getTaskResult', 'status ready without a solution object');
      }
      return { status: 'ready', solution: body.solution as Solution };
    }
    throw new ProtocolError('getTaskResult', `unknown status ${JSON.stringify(body.status)}`);
  }

  /**
   * The cash balance in USD, as the JSON number the API sends. Display it; do not do money
   * arithmetic on it (the dashboard's `GET /v1/balance` has the exact decimal).
   */
  async getBalance(options: RequestOptions = {}): Promise<number> {
    const body = await this.#solverCall(
      'getBalance',
      '/getBalance',
      { clientKey: this.#apiKey },
      options.signal,
    );
    if (typeof body.balance !== 'number' || !Number.isFinite(body.balance)) {
      throw new ProtocolError('getBalance', 'errorId 0 without a numeric balance');
    }
    return body.balance;
  }

  /**
   * Creates a task and polls it until it is ready, failed, or the deadline passes.
   *
   * - `createTask` is resubmitted only after `ERROR_NO_SLOT_AVAILABLE` (nothing was created),
   *   at most `maxSubmitRetries` times; any other submit failure is thrown at once.
   * - Polls that fail at the transport level or with `ERROR_INTERNAL_ERROR` are retried until
   *   the deadline; any other error ends the call and carries the task id.
   * - On the deadline a `SolveTimeoutError` is thrown; the task may still finish.
   * - Aborting `signal` rejects with `signal.reason`; the task id was already passed to
   *   `onTaskCreated`.
   */
  async solve(task: Task, options: SolveOptions = {}): Promise<SolveResult> {
    const pollIntervalMs = positiveMs('pollIntervalMs', options.pollIntervalMs, this.#pollIntervalMs);
    const solveTimeoutMs = positiveMs('solveTimeoutMs', options.solveTimeoutMs, this.#solveTimeoutMs);
    const { signal } = options;
    const requestOptions: RequestOptions = signal === undefined ? {} : { signal };
    signal?.throwIfAborted();
    const deadline = this.#clock.now() + solveTimeoutMs;

    let taskId: string;
    for (let retries = 0; ; retries += 1) {
      try {
        taskId = await this.createTask(task, requestOptions);
        break;
      } catch (error) {
        if (!(error instanceof NoSlotAvailableError) || retries >= this.#maxSubmitRetries) throw error;
        const jitter = Math.floor(this.#random() * SUBMIT_RETRY_JITTER_MS);
        await this.#clock.sleep(pollIntervalMs + jitter, signal);
      }
    }
    options.onTaskCreated?.(taskId);

    for (;;) {
      let lastError: SurSolverError | undefined;
      try {
        const result = await this.getTaskResult(taskId, requestOptions);
        if (result.status === 'ready') return { taskId, solution: result.solution };
      } catch (error) {
        const transient =
          error instanceof TransportError ||
          (error instanceof ApiError && error.code === 'ERROR_INTERNAL_ERROR');
        if (!transient) throw error;
        lastError = error;
      }
      await this.#clock.sleep(pollIntervalMs, signal);
      if (this.#clock.now() >= deadline) throw new SolveTimeoutError(taskId, solveTimeoutMs, lastError);
    }
  }

  /** The public task-type catalog: accepted names, fields, proxy modes and result keys. */
  async listTaskTypes(options: RequestOptions = {}): Promise<TaskTypeCatalog> {
    const data = await this.#catalogCall('listTaskTypes', '/v1/task-types', options.signal);
    const { task_types: taskTypes, error_codes: errorCodes } = data;
    if (!Array.isArray(taskTypes) || !Array.isArray(errorCodes)) {
      throw new ProtocolError('listTaskTypes', 'data without task_types and error_codes arrays');
    }
    const read = entryReader('listTaskTypes');
    if (!errorCodes.every((code) => typeof code === 'string')) {
      throw new ProtocolError('listTaskTypes', 'error_codes is not a list of strings');
    }
    return {
      taskTypes: taskTypes.map((raw): TaskTypeInfo => {
        const entry = read.object(raw);
        return {
          pageSlug: read.optionalText(entry, 'page_slug'),
          displayName: read.text(entry, 'display_name'),
          taskType: read.text(entry, 'task_type'),
          taskTypeProxyless: read.optionalText(entry, 'task_type_proxyless'),
          aliases: read.texts(entry, 'aliases'),
          proxy: read.text(entry, 'proxy') as ProxyMode,
          required: read.groups(entry, 'required'),
          anyOf: read.groups(entry, 'any_of'),
          optional: read.texts(entry, 'optional'),
          solutionKeys: read.texts(entry, 'solution_keys'),
        };
      }),
      errorCodes,
    };
  }

  /** Active services with their current USD price per task (decimal strings). */
  async listServices(options: RequestOptions = {}): Promise<ServiceInfo[]> {
    const data = await this.#catalogCall('listServices', '/v1/services', options.signal);
    if (!Array.isArray(data.services)) {
      throw new ProtocolError('listServices', 'data without a services array');
    }
    const read = entryReader('listServices');
    return data.services.map((raw): ServiceInfo => {
      const entry = read.object(raw);
      return {
        id: read.integer(entry, 'id'),
        slug: read.text(entry, 'slug'),
        displayName: read.text(entry, 'display_name'),
        pricePerRequest: read.text(entry, 'price_per_request'),
        status: read.text(entry, 'status'),
        avgLatencyMs: entry.avg_latency_ms === null ? null : read.integer(entry, 'avg_latency_ms'),
      };
    });
  }

  /** Never reveals the key: `JSON.stringify(client)` and logs show only the base URL. */
  toJSON(): { baseUrl: string } {
    return { baseUrl: this.#baseUrl };
  }

  async #send(operation: Operation, request: HttpRequest): Promise<{ response: HttpResponse; json: unknown }> {
    let response: HttpResponse;
    try {
      response = await this.#transport(request);
    } catch (error) {
      if (request.signal?.aborted === true) throw request.signal.reason;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      const reason = timedOut ? `request timed out after ${request.timeoutMs} ms` : 'connection failed';
      throw new TransportError(operation, reason, { cause: error });
    }
    let json: unknown;
    try {
      json = response.body === '' ? undefined : JSON.parse(response.body);
    } catch {
      json = undefined;
    }
    if (response.status !== 200) {
      const envelope = isJsonObject(json) && isJsonObject(json.error) ? json.error : {};
      const serverCode = typeof envelope.code === 'string' ? envelope.code : undefined;
      const retryAfter = envelope.retry_after_seconds;
      throw new TransportError(operation, `HTTP ${response.status}${serverCode === undefined ? '' : ` (${serverCode})`}`, {
        status: response.status,
        ...(serverCode === undefined ? {} : { serverCode }),
        ...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {}),
      });
    }
    return { response, json };
  }

  #request(method: 'GET' | 'POST', path: string, signal: AbortSignal | undefined, body?: string): HttpRequest {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.#userAgent };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return {
      method,
      url: `${this.#baseUrl}${path}`,
      headers,
      timeoutMs: this.#requestTimeoutMs,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  /** POST to a solver endpoint; returns the `errorId: 0` body or throws the classified error. */
  async #solverCall(
    operation: Operation,
    path: string,
    payload: JsonObject,
    signal: AbortSignal | undefined,
    taskId?: string,
  ): Promise<JsonObject> {
    const request = this.#request('POST', path, signal, JSON.stringify(payload));
    const { json } = await this.#send(operation, request);
    if (!isJsonObject(json) || !Number.isInteger(json.errorId)) {
      const what = json === undefined ? 'not JSON' : 'not the solver envelope';
      throw new TransportError(operation, `HTTP 200 body is ${what}`, { status: 200 });
    }
    if (json.errorId === 0) return json;
    if (json.errorId !== 1) throw new ProtocolError(operation, `errorId ${String(json.errorId)}`);
    if (typeof json.errorCode !== 'string') {
      throw new ProtocolError(operation, 'errorId 1 without a string errorCode');
    }
    const supported = Array.isArray(json.supportedUserAgents)
      ? json.supportedUserAgents.filter((entry): entry is string => typeof entry === 'string')
      : [];
    throw apiErrorFor(operation, {
      code: json.errorCode,
      description: typeof json.errorDescription === 'string' ? json.errorDescription : '',
      taskId,
      supportedUserAgents: supported,
    });
  }

  /** GET a public catalog endpoint; returns `data` of a `{success: true, data}` envelope. */
  async #catalogCall(operation: Operation, path: string, signal: AbortSignal | undefined): Promise<JsonObject> {
    const { json } = await this.#send(operation, this.#request('GET', path, signal));
    if (!isJsonObject(json) || json.success !== true || !isJsonObject(json.data)) {
      throw new TransportError(operation, 'HTTP 200 body is not the API envelope', { status: 200 });
    }
    return json.data;
  }
}
