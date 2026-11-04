/** The client call an error belongs to; `solve()` reports the inner call that failed. */
export type Operation = 'createTask' | 'getTaskResult' | 'getBalance' | 'listTaskTypes' | 'listServices';

/** Base class of every error this package throws. Cancellation stays the caller's `signal.reason`. */
export class SurSolverError extends Error {
  readonly operation: Operation | undefined;

  constructor(message: string, operation?: Operation, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.operation = operation;
  }
}

/** The client was built with an unusable option. Nothing was sent. */
export class ConfigurationError extends SurSolverError {}

export interface TransportErrorDetails {
  status?: number;
  serverCode?: string;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * No usable answer: connection failure, request timeout, a non-200 status, or a body that is
 * not the API's envelope. It says nothing about the task.
 */
export class TransportError extends SurSolverError {
  /** HTTP status, when a response was received. */
  readonly status: number | undefined;
  /** `error.code` of the API's internal envelope (e.g. `internal_error`), when present. */
  readonly serverCode: string | undefined;
  /** `error.retry_after_seconds` of the internal envelope, when present. */
  readonly retryAfterSeconds: number | undefined;
  /**
   * `true` for `createTask`: the request may have been accepted and charged before the answer
   * was lost. Check `getBalance()` before deciding to submit again; the API has no idempotency.
   */
  readonly mayHaveCreatedTask: boolean;

  constructor(operation: Operation, reason: string, details: TransportErrorDetails = {}) {
    const mayHaveCreatedTask = operation === 'createTask';
    const note = mayHaveCreatedTask
      ? ' The task may have been created and charged; check getBalance() before submitting again.'
      : '';
    super(
      `${operation} failed: ${reason}.${note}`,
      operation,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.status = details.status;
    this.serverCode = details.serverCode;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.mayHaveCreatedTask = mayHaveCreatedTask;
  }
}

/** HTTP 200 JSON whose shape the API contract does not allow. */
export class ProtocolError extends SurSolverError {
  constructor(operation: Operation, detail: string) {
    super(`${operation} returned an unexpected response: ${detail}`, operation);
  }
}

export interface ApiErrorDetails {
  code: string;
  description: string;
  taskId?: string | undefined;
  supportedUserAgents?: readonly string[] | undefined;
}

/** The API answered `errorId: 1`. Subclasses group the codes callers act on. */
export class ApiError extends SurSolverError {
  /** The `errorCode` exactly as sent, including codes newer than this package. */
  readonly code: string;
  /** The API's `errorDescription`. */
  readonly description: string;
  /** Whether resubmitting unchanged can succeed (only `ERROR_NO_SLOT_AVAILABLE`). */
  readonly retryable: boolean;
  /** The task the error belongs to, for `getTaskResult` and `solve()` after acceptance. */
  readonly taskId: string | undefined;
  /** Accepted `userAgent` values sent with `ERROR_WRONG_USERAGENT`; empty otherwise. */
  readonly supportedUserAgents: readonly string[];

  constructor(operation: Operation, details: ApiErrorDetails) {
    const task = details.taskId === undefined ? '' : ` (task ${details.taskId})`;
    super(`${details.code}: ${details.description}${task}`, operation);
    this.code = details.code;
    this.description = details.description;
    this.retryable = details.code === 'ERROR_NO_SLOT_AVAILABLE';
    this.taskId = details.taskId;
    this.supportedUserAgents = Object.freeze([...(details.supportedUserAgents ?? [])]);
  }
}

/** `ERROR_WRONG_CLIENT_KEY` or `ERROR_KEY_DOES_NOT_EXIST`: fix the API key. */
export class AuthenticationError extends ApiError {}

/**
 * `createTask` refused the task itself: `ERROR_INVALID_REQUEST`, `ERROR_TYPE_NOT_SUPPORTED` or
 * `ERROR_WRONG_USERAGENT` (see `supportedUserAgents`). Nothing was created or charged.
 */
export class InvalidTaskError extends ApiError {}

/** `ERROR_ZERO_BALANCE`: the balance or plan cannot cover the task. Nothing was charged. */
export class InsufficientBalanceError extends ApiError {}

/**
 * `ERROR_NO_SLOT_AVAILABLE`: the account's open tasks fill its thread limit, or the service is
 * briefly not admitting work. Nothing was created; submitting again later is safe.
 */
export class NoSlotAvailableError extends ApiError {}

/** `ERROR_TASK_NOT_FOUND`: unknown task id, or one owned by another account. */
export class TaskNotFoundError extends ApiError {}

/**
 * The task ended without a result: `ERROR_FAILED`, `ERROR_TASK_TIMEOUT`, `ERROR_TASK_EXPIRED`,
 * or `ERROR_WRONG_USERAGENT` after acceptance. Final for this task; a failed task's charge is
 * returned once by the API.
 */
export class TaskFailedError extends ApiError {}

/**
 * `solve()` reached its deadline. The task may still finish and stays charged: poll it with
 * `getTaskResult(error.taskId)` if you still need the result.
 */
export class SolveTimeoutError extends SurSolverError {
  readonly taskId: string;
  /** The last poll's transient failure, when the final poll before the deadline failed. */
  readonly lastError: SurSolverError | undefined;

  constructor(taskId: string, timeoutMs: number, lastError?: SurSolverError) {
    super(
      `task ${taskId} was not ready within ${timeoutMs} ms; it may still finish and stays charged`,
      'getTaskResult',
      lastError === undefined ? undefined : { cause: lastError },
    );
    this.taskId = taskId;
    this.lastError = lastError;
  }
}

const TASK_FAILURE_CODES: Readonly<Record<string, true>> = {
  ERROR_FAILED: true,
  ERROR_TASK_TIMEOUT: true,
  ERROR_TASK_EXPIRED: true,
  ERROR_WRONG_USERAGENT: true,
};

type ApiErrorClass = new (operation: Operation, details: ApiErrorDetails) => ApiError;

const CLASS_BY_CODE: Readonly<Record<string, ApiErrorClass>> = {
  ERROR_WRONG_CLIENT_KEY: AuthenticationError,
  ERROR_KEY_DOES_NOT_EXIST: AuthenticationError,
  ERROR_INVALID_REQUEST: InvalidTaskError,
  ERROR_TYPE_NOT_SUPPORTED: InvalidTaskError,
  ERROR_WRONG_USERAGENT: InvalidTaskError,
  ERROR_ZERO_BALANCE: InsufficientBalanceError,
  ERROR_NO_SLOT_AVAILABLE: NoSlotAvailableError,
  ERROR_TASK_NOT_FOUND: TaskNotFoundError,
};

/** The error class for an `errorId: 1` answer: it depends on the operation and the code. */
export function apiErrorFor(operation: Operation, details: ApiErrorDetails): ApiError {
  if (operation === 'getTaskResult' && TASK_FAILURE_CODES[details.code] === true) {
    return new TaskFailedError(operation, details);
  }
  const ErrorClass = CLASS_BY_CODE[details.code] ?? ApiError;
  return new ErrorClass(operation, details);
}
