import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { EluGuard } from '../../src/core/guard/guard';
import { eluGuardHttp } from '../../src/adapters/http/http-adapter';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('eluGuardHttp adapter (integration)', () => {
  test('passes normal requests through and returns 200', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 5, maxConcurrency: 5 } });
    const server = createServer(
      eluGuardHttp(guard, (_req, res) => {
        res.statusCode = 200;
        res.end('ok');
      })
    );
    const port = await listen(server);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    await close(server);
    await guard.stop();
  });

  test('returns 503 once the concurrency queue is full', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 1, maxConcurrency: 1, maxQueueLength: 0, queueTimeoutMs: 1000 },
    });
    const server = createServer(
      eluGuardHttp(guard, async (_req, res) => {
        await new Promise((r) => setTimeout(r, 150));
        res.statusCode = 200;
        res.end('ok');
      })
    );
    const port = await listen(server);

    const [first, second] = await Promise.all([fetch(`http://127.0.0.1:${port}/`), fetch(`http://127.0.0.1:${port}/`)]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 503]);

    await close(server);
    await guard.stop();
  });

  test('returns 503 once the breaker is open, without calling the handler', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 5, maxConcurrency: 5 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    let handlerCalls = 0;
    const server = createServer(
      eluGuardHttp(guard, (_req, res) => {
        handlerCalls++;
        res.statusCode = 500;
        res.end('error');
      })
    );
    const port = await listen(server);

    await fetch(`http://127.0.0.1:${port}/`);
    await fetch(`http://127.0.0.1:${port}/`);
    expect(guard.stats().circuitState).toBe('open');

    const callsBeforeThirdRequest = handlerCalls;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(503);
    expect(handlerCalls).toBe(callsBeforeThirdRequest); // handler was never invoked

    await close(server);
    await guard.stop();
  });

  test('client disconnect frees the slot without counting a breaker failure', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 2, maxConcurrency: 2 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    let handlerStarted = false;
    const server = createServer(
      eluGuardHttp(guard, () => {
        // Never respond: the client is going to disconnect first.
        handlerStarted = true;
      })
    );
    const port = await listen(server);

    const req = httpRequest({ host: '127.0.0.1', port, path: '/' });
    req.on('error', () => undefined);
    req.end();

    await new Promise((r) => setTimeout(r, 80));
    expect(handlerStarted).toBe(true);
    expect(guard.stats().inFlight).toBe(1);

    req.destroy();
    await new Promise((r) => setTimeout(r, 120));

    expect(guard.stats().inFlight).toBe(0);
    expect(guard.stats().probes).toBe(0);
    // A client giving up says nothing about the dependency.
    expect(guard.stats().circuitState).toBe('closed');

    await close(server);
    await guard.stop();
  });
});
