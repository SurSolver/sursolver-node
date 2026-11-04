// Runs the vendored language-neutral conformance scenarios (conformance/README.md) against the
// client with a scripted fake transport, a virtual clock and a fixed random source.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect, isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  AuthenticationError,
  type ClientOptions,
  type Clock,
  ConfigurationError,
  type HttpRequest,
  type HttpResponse,
  InsufficientBalanceError,
  InvalidTaskError,
  NoSlotAvailableError,
  ProtocolError,
  SolveTimeoutError,
  SurSolver,
  type SurSolverError,
  TaskFailedError,
  TaskNotFoundError,
  TransportError,
} from '../src/index.js';

const ROOT = join(import.meta.dirname, '..');
const SCENARIO_DIR = join(ROOT, 'conformance', 'scenarios');
const RECORDED_DIR = join(ROOT, 'conformance', 'recorded');
const TEST_API_KEY = 'sur_00000000000000000000000000000000';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface ScriptEntry {
  expect: { method: string; path: string; headers?: Record<string, Json>; json?: Json; noQuery?: boolean };
  respond?: { respondFrom?: string; status?: number; headers?: Record<string, string>; json?: Json; text?: string };
  fail?: 'connection_reset' | 'request_timeout' | 'connection_closed_no_response';
}

interface Scenario {
  name: string;
  random?: number;
  client?: {
    apiKey?: string;
    baseUrl?: string;
    requestTimeoutMs?: number;
    pollIntervalMs?: number;
    solveTimeoutMs?: number;
    maxSubmitRetries?: number;
    appId?: string;
    userAgentSuffix?: string;
  };
  script: ScriptEntry[];
  call: { method: string; args?: JsonObject; cancelAfterSleeps?: number };
  expect?: {
    sleeps?: number[];
    outcome?: { ok?: Json; error?: JsonObject };
    outcomeSubset?: { pointer: string; length?: number; equals?: Json }[];
    redaction?: boolean;
    lastTaskId?: string;
  };
}

const ERROR_CLASSES: Record<string, new (...args: never[]) => SurSolverError> = {
  ConfigurationError,
  ApiError,
  AuthenticationError,
  InvalidTaskError,
  InsufficientBalanceError,
  NoSlotAvailableError,
  TaskNotFoundError,
  TaskFailedError,
  SolveTimeoutError,
  TransportError,
  ProtocolError,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Typed results back to wire spelling (camelCase → snake_case); solution contents stay raw. */
function toWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWire);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      key === 'solution' ? entry : toWire(entry),
    ]),
  );
}

/** README rule: keys compare lowercased without underscores, except inside a solution. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.toLowerCase().replaceAll('_', ''),
      key === 'solution' ? entry : normalize(entry),
    ]),
  );
}

function pointerGet(root: unknown, pointer: string): unknown {
  let current = root;
  for (const raw of pointer.split('/').slice(1)) {
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    current = Array.isArray(current) ? current[Number(segment)] : (current as Record<string, unknown>)[segment];
  }
  return current;
}

function transportFailure(kind: NonNullable<ScriptEntry['fail']>): Error {
  if (kind === 'request_timeout') return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  if (kind === 'connection_reset') return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
}

function scriptedResponse(respond: NonNullable<ScriptEntry['respond']>): HttpResponse {
  if (respond.respondFrom !== undefined) {
    const fixture = JSON.parse(readFileSync(join(RECORDED_DIR, respond.respondFrom), 'utf8'));
    const body = fixture.response.body_is_json ? JSON.stringify(fixture.response.body) : String(fixture.response.body ?? '');
    return { status: respond.status ?? fixture.response.status, headers: fixture.response.headers, body };
  }
  const body = respond.json !== undefined ? JSON.stringify(respond.json) : (respond.text ?? '');
  return { status: respond.status ?? 200, headers: respond.headers ?? {}, body };
}

function headerMatches(expected: Json, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  if (isObject(expected) && typeof expected.matches === 'string') return new RegExp(expected.matches).test(actual);
  return expected === actual;
}

async function runScenario(scenario: Scenario): Promise<void> {
  const requests: HttpRequest[] = [];
  const harnessFailures: string[] = [];
  let step = 0;
  const transport = async (request: HttpRequest): Promise<HttpResponse> => {
    requests.push(request);
    const entry = scenario.script[step];
    step += 1;
    const url = new URL(request.url);
    const problem =
      entry === undefined
        ? `unexpected request ${request.method} ${url.pathname}`
        : entry.expect.method !== request.method || entry.expect.path !== url.pathname
          ? `request ${step}: expected ${entry.expect.method} ${entry.expect.path}, got ${request.method} ${url.pathname}`
          : entry.expect.noQuery === true && url.search !== ''
            ? `request ${step}: unexpected query string`
            : entry.expect.json !== undefined && !isDeepStrictEqual(JSON.parse(request.body ?? 'null'), entry.expect.json)
              ? `request ${step}: body ${request.body} does not equal ${JSON.stringify(entry.expect.json)}`
              : Object.entries(entry.expect.headers ?? {}).find(
                    ([name, value]) => !headerMatches(value, request.headers[name.toLowerCase()]),
                  )
                ? `request ${step}: header mismatch ${JSON.stringify(request.headers)}`
                : undefined;
    if (problem !== undefined || entry === undefined) {
      harnessFailures.push(problem ?? 'unexpected request');
      throw new Error(`harness: ${problem}`);
    }
    if (entry.fail !== undefined) throw transportFailure(entry.fail);
    return scriptedResponse(entry.respond ?? { status: 200 });
  };

  const controller = new AbortController();
  const sleeps: number[] = [];
  let now = 0;
  const clock: Clock = {
    now: () => now,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      now += ms;
      if (scenario.call.cancelAfterSleeps === sleeps.length) controller.abort();
      signal?.throwIfAborted();
    },
  };

  const c = scenario.client ?? {};
  const options: ClientOptions = { transport, clock, random: () => scenario.random ?? 0 };
  if (c.baseUrl !== undefined) options.baseUrl = c.baseUrl;
  if (c.requestTimeoutMs !== undefined) options.requestTimeoutMs = c.requestTimeoutMs;
  if (c.pollIntervalMs !== undefined) options.pollIntervalMs = c.pollIntervalMs;
  if (c.solveTimeoutMs !== undefined) options.solveTimeoutMs = c.solveTimeoutMs;
  if (c.maxSubmitRetries !== undefined) options.maxSubmitRetries = c.maxSubmitRetries;
  if (c.appId !== undefined) options.appId = c.appId;
  if (c.userAgentSuffix !== undefined) options.userAgentSuffix = c.userAgentSuffix;
  const apiKey = c.apiKey ?? TEST_API_KEY;

  const createdIds: string[] = [];
  let result: unknown;
  let error: unknown;
  try {
    const client = new SurSolver(apiKey, options);
    const args = scenario.call.args ?? {};
    switch (scenario.call.method) {
      case 'construct':
        break;
      case 'createTask':
        result = await client.createTask(args.task as never);
        break;
      case 'getTaskResult':
        result = await client.getTaskResult(args.taskId as string);
        break;
      case 'getBalance':
        result = await client.getBalance();
        break;
      case 'listTaskTypes':
        result = await client.listTaskTypes();
        break;
      case 'listServices':
        result = await client.listServices();
        break;
      case 'solve':
        result = await client.solve(args.task as never, {
          signal: controller.signal,
          onTaskCreated: (taskId) => createdIds.push(taskId),
          ...(typeof args.pollIntervalMs === 'number' ? { pollIntervalMs: args.pollIntervalMs } : {}),
          ...(typeof args.solveTimeoutMs === 'number' ? { solveTimeoutMs: args.solveTimeoutMs } : {}),
        });
        break;
      default:
        throw new Error(`unknown call ${scenario.call.method}`);
    }
  } catch (caught) {
    error = caught;
  }

  expect(harnessFailures).toEqual([]);
  expect(step, 'every scripted request is consumed').toBe(scenario.script.length);
  const expectations = scenario.expect ?? {};
  if (expectations.sleeps !== undefined) expect(sleeps).toEqual(expectations.sleeps);
  if (expectations.lastTaskId !== undefined) expect(createdIds.at(-1)).toBe(expectations.lastTaskId);

  const expectedError = expectations.outcome?.error;
  if (expectedError === undefined) {
    if (error !== undefined) throw error;
    if (expectations.outcome !== undefined && 'ok' in expectations.outcome) {
      expect(normalize(toWire(result))).toEqual(normalize(expectations.outcome.ok));
    }
    for (const check of expectations.outcomeSubset ?? []) {
      const value = pointerGet(toWire(result), check.pointer);
      if (check.length !== undefined) expect((value as unknown[]).length).toBe(check.length);
      if (check.equals !== undefined) expect(normalize(value)).toEqual(normalize(check.equals));
    }
  } else {
    expect(error, 'the call should have failed').toBeDefined();
    if (expectedError.type === 'Cancelled') {
      expect(error).toBe(controller.signal.reason);
    } else {
      const ExpectedClass = ERROR_CLASSES[expectedError.type as string];
      expect((error as object).constructor, `error ${String(error)}`).toBe(ExpectedClass);
      const e = error as Record<string, unknown> & Error;
      for (const field of ['operation', 'code', 'retryable', 'taskId', 'status', 'serverCode', 'retryAfterSeconds', 'mayHaveCreatedTask']) {
        if (field in expectedError) expect(e[field], field).toEqual(expectedError[field]);
      }
      if ('supportedUserAgents' in expectedError) expect(e.supportedUserAgents).toEqual(expectedError.supportedUserAgents);
      if ('lastErrorType' in expectedError) {
        const last = e.lastError as object | undefined | null;
        expect(last == null ? null : last.constructor.name).toBe(expectedError.lastErrorType);
      }
      const rendered = `${String(error)}\n${inspect(error, { depth: 5 })}`;
      for (const text of (expectedError.messageIncludes as string[] | undefined) ?? []) expect(rendered).toContain(text);
      for (const text of (expectedError.messageExcludes as string[] | undefined) ?? []) expect(rendered).not.toContain(text);
    }
  }

  if (expectations.redaction === true) {
    for (const request of requests) {
      expect(request.url).not.toContain(apiKey);
      expect(Object.values(request.headers).join('\n')).not.toContain(apiKey);
      expect(request.body?.split(apiKey).length).toBe(2);
      expect((JSON.parse(request.body ?? '{}') as JsonObject).clientKey).toBe(apiKey);
    }
    if (error !== undefined) expect(`${String(error)}\n${inspect(error, { depth: 5 })}`).not.toContain(apiKey);
  }
}

const files = readdirSync(SCENARIO_DIR).filter((name) => name.endsWith('.json')).sort();

describe('conformance', () => {
  it('finds the vendored scenarios', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    const scenario = JSON.parse(readFileSync(join(SCENARIO_DIR, file), 'utf8')) as Scenario;
    it(scenario.name, () => runScenario(scenario));
  }
});
