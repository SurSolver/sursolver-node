// Node-specific behaviour the language-neutral scenarios cannot cover: the real fetch transport
// against a local HTTP server, real-clock cancellation and redaction of the client object.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SurSolver, TransportError } from '../src/index.js';

const KEY = 'sur_00000000000000000000000000000000';
const TASK = { type: 'TurnstileTokenProxyLess', websiteURL: 'https://example.com/', websiteKey: 'k', userAgent: 'ua' };

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
    server?.closeAllConnections();
  });
  server = undefined;
});

async function listen(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

describe('fetch transport', () => {
  it('sends the key only in the JSON body with the SDK user agent', async () => {
    let seen: { headers: IncomingMessage['headers']; url: string | undefined; body: string } | undefined;
    const baseUrl = await listen((req, body, res) => {
      seen = { headers: req.headers, url: req.url, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errorId: 0, taskId: 'tsk_4f7a9c1e2b8d3a6f5c0e9d21', status: 'idle' }));
    });
    const taskId = await new SurSolver(KEY, { baseUrl }).createTask(TASK);
    expect(taskId).toBe('tsk_4f7a9c1e2b8d3a6f5c0e9d21');
    expect(seen?.url).toBe('/createTask');
    expect(seen?.headers['user-agent']).toMatch(/^sursolver-node\/\d+\.\d+\.\d+$/);
    expect(seen?.headers['content-type']).toBe('application/json');
    expect(JSON.stringify(seen?.headers)).not.toContain(KEY);
    expect(JSON.parse(seen?.body ?? '{}')).toEqual({ clientKey: KEY, task: TASK });
  });

  it('turns a request timeout into a TransportError', async () => {
    // A real 100 ms wait: the behaviour under test is fetch's own AbortSignal.timeout, which a
    // fake clock cannot drive.
    const baseUrl = await listen(() => {
      // never answers
    });
    const error = await new SurSolver(KEY, { baseUrl, requestTimeoutMs: 100 }).getBalance().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toContain('timed out after 100 ms');
    expect((error as TransportError).mayHaveCreatedTask).toBe(false);
  });

  it('does not follow a redirect, so the key is never replayed elsewhere', async () => {
    let redirectedHits = 0;
    const baseUrl = await listen((req, _body, res) => {
      if (req.url === '/elsewhere') {
        redirectedHits += 1;
        res.end('{}');
        return;
      }
      res.writeHead(307, { location: '/elsewhere' });
      res.end();
    });
    const error = await new SurSolver(KEY, { baseUrl }).createTask(TASK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).status).toBe(307);
    expect((error as TransportError).mayHaveCreatedTask).toBe(true);
    expect(redirectedHits).toBe(0);
  });
});

describe('cancellation with the real clock', () => {
  it('rejects with the signal reason once the task exists, and has already reported the task id', async () => {
    const controller = new AbortController();
    const baseUrl = await listen((req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/createTask') {
        res.end(JSON.stringify({ errorId: 0, taskId: 'tsk_4f7a9c1e2b8d3a6f5c0e9d21', status: 'idle' }));
        return;
      }
      // Cancel while the first poll is answered: the client is then either reading this
      // response or waiting the 10 s poll interval; both must end with the signal reason.
      res.end(JSON.stringify({ errorId: 0, status: 'processing' }));
      controller.abort();
    });
    const created: string[] = [];
    const error = await new SurSolver(KEY, { baseUrl, pollIntervalMs: 10_000 })
      .solve(TASK, { signal: controller.signal, onTaskCreated: (taskId) => created.push(taskId) })
      .catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
    expect(created).toEqual(['tsk_4f7a9c1e2b8d3a6f5c0e9d21']);
  });

  it('sends nothing when the signal is already aborted', async () => {
    let hits = 0;
    const baseUrl = await listen((_req, _body, res) => {
      hits += 1;
      res.end();
    });
    const controller = new AbortController();
    controller.abort();
    await expect(new SurSolver(KEY, { baseUrl }).solve(TASK, { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(hits).toBe(0);
  });
});

describe('redaction', () => {
  it('keeps the key out of inspect and JSON output', () => {
    const client = new SurSolver(KEY);
    expect(inspect(client, { showHidden: true, depth: 5 })).not.toContain(KEY);
    expect(JSON.stringify(client)).toBe('{"baseUrl":"https://api.sursolver.com"}');
  });
});
