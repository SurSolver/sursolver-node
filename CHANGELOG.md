# Changelog

## 0.1.0 — unreleased

First release. Tested against the SDK specification revision in `SPEC_VERSION` (catalog of
2026-11-04).

- `SurSolver` client: `createTask`, `getTaskResult`, `getBalance`, `listTaskTypes`,
  `listServices` and the `solve()` helper (3 s polling, 210 s deadline, `onTaskCreated`,
  `AbortSignal` cancellation).
- Typed errors: `AuthenticationError`, `InvalidTaskError` (with `supportedUserAgents`),
  `InsufficientBalanceError`, `NoSlotAvailableError`, `TaskNotFoundError`, `TaskFailedError`,
  `ApiError`, `TransportError` (with `mayHaveCreatedTask`), `ProtocolError`,
  `SolveTimeoutError`, `ConfigurationError`.
- `TaskType` and `ERROR_CODES` constants generated from the public catalog.
- ESM and CommonJS builds with type declarations; no runtime dependencies.
