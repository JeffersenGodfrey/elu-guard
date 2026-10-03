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
});
