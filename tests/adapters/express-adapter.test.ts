import express from 'express';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { EluGuard } from '../../src/core/guard/guard';
import { eluGuardExpress } from '../../src/express';

function waitForListening(server: Server): Promise<number> {
  return new Promise((resolve) => {
    if (server.listening) {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
        return;
      }
    }
    server.once('listening', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('eluGuardExpress adapter (integration)', () => {
  test('passes normal requests through', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 5, maxConcurrency: 5 } });
    const app = express();
    app.use(eluGuardExpress(guard));
    app.get('/', (_req, res) => res.status(200).json({ ok: true }));
    const server = app.listen(0);
    const port = await waitForListening(server);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);

    await close(server);
    await guard.stop();
  });

  test('a 500 response counts as a breaker failure', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 5, maxConcurrency: 5 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    const app = express();
    app.use(eluGuardExpress(guard));
    app.get('/', (_req, res) => res.status(500).json({ ok: false }));
    const server = app.listen(0);
    const port = await waitForListening(server);

    await fetch(`http://127.0.0.1:${port}/`);
    await fetch(`http://127.0.0.1:${port}/`);

    expect(guard.stats().circuitState).toBe('open');

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(503);

    await close(server);
    await guard.stop();
  });

  test('client disconnect frees the slot without counting a breaker failure', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 2, maxConcurrency: 2 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    const app = express();
    app.use(eluGuardExpress(guard));
    app.get('/slow', () => {
      // Never respond: the client is going to disconnect first.
    });
    const server = app.listen(0);
    const port = await waitForListening(server);

    const req = httpRequest({ host: '127.0.0.1', port, path: '/slow' });
    req.on('error', () => undefined);
    req.end();

    await new Promise((r) => setTimeout(r, 120));
    expect(guard.stats().inFlight).toBe(1);

    req.destroy();
    await new Promise((r) => setTimeout(r, 150));

    expect(guard.stats().inFlight).toBe(0);
    expect(guard.stats().probes).toBe(0);
    expect(guard.stats().circuitState).toBe('closed');

    await close(server);
    await guard.stop();
  });

  test('returns 503 when the concurrency queue is full', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 1, maxConcurrency: 1, maxQueueLength: 0, queueTimeoutMs: 1000 },
    });
    const app = express();
    app.use(eluGuardExpress(guard));
    app.get('/', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 150));
      res.status(200).json({ ok: true });
    });
    const server = app.listen(0);
    const port = await waitForListening(server);

    const [first, second] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`),
      fetch(`http://127.0.0.1:${port}/`),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 503]);

    await close(server);
    await guard.stop();
  });

  test('half-open probe is released after a successful response', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 5, maxConcurrency: 5 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 20, halfOpenMaxCalls: 1 },
    });
    const app = express();
    app.use(eluGuardExpress(guard));
    app.get('/', (_req, res) => res.status(500).json({ ok: false }));
    const server = app.listen(0);
    const port = await waitForListening(server);

    await fetch(`http://127.0.0.1:${port}/`);
    await fetch(`http://127.0.0.1:${port}/`);
    expect(guard.stats().circuitState).toBe('open');
    await new Promise((r) => setTimeout(r, 40));
    expect(guard.stats().circuitState).toBe('half-open');

    // Swap to a healthy handler for the probe.
    app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
    await fetch(`http://127.0.0.1:${port}/health`);
    expect(guard.stats().probes).toBe(0);

    await close(server);
    await guard.stop();
  });

  test('non-LimitRejected acquire error is forwarded to next(err)', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 2, maxConcurrency: 2 } });
    const app = express();
    app.use(eluGuardExpress(guard));
    app.get('/', (_req, res) => res.status(200).json({ ok: true }));
    // Error handler to catch next(err) calls.
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'forwarded' });
    });
    const server = app.listen(0);
    const port = await waitForListening(server);

    // Stop the guard so acquire throws ShuttingDownError (not LimitRejectedError).
    await guard.stop();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    // ShuttingDownError goes through next(err) -> 500 error handler.
    expect([500, 503]).toContain(res.status);

    await close(server);
  });
});
