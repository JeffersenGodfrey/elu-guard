import Fastify from 'fastify';
import { connect } from 'node:net';
import { EluGuard } from '../../src/core/guard/guard';
import { eluGuardFastify } from '../../src/fastify';

describe('eluGuardFastify adapter (integration)', () => {
  test('passes normal requests through', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 5, maxConcurrency: 5 } });
    const app = Fastify();
    await app.register(eluGuardFastify(guard));
    app.get('/', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);

    await app.close();
    await guard.stop();
  });

  test('a 500 response counts as a breaker failure and later requests get 503', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 5, maxConcurrency: 5 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    const app = Fastify();
    await app.register(eluGuardFastify(guard));
    app.get('/', async (_req, reply) => reply.code(500).send({ ok: false }));

    await app.inject({ method: 'GET', url: '/' });
    await app.inject({ method: 'GET', url: '/' });

    expect(guard.stats().circuitState).toBe('open');

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(503);

    await app.close();
    await guard.stop();
  });

  test('returns 503 when the concurrency queue is full', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 1, maxConcurrency: 1, maxQueueLength: 0, queueTimeoutMs: 1000 },
    });
    const app = Fastify();
    await app.register(eluGuardFastify(guard));
    app.get('/', async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    const [first, second] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`),
      fetch(`http://127.0.0.1:${port}/`),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 503]);

    await app.close();
    await guard.stop();
  });

  test('non-LimitRejected acquire error is rethrown as a 500', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 2, maxConcurrency: 2 } });
    const app = Fastify();
    await app.register(eluGuardFastify(guard));
    app.get('/', async () => ({ ok: true }));

    // Stop the guard so acquire throws ShuttingDownError (not LimitRejectedError).
    await guard.stop();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(500);

    await app.close();
  });

  test('client disconnect frees the slot without counting a breaker failure', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 2, maxConcurrency: 2 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    const app = Fastify();
    await app.register(eluGuardFastify(guard));
    app.get('/slow', async () => {
      await new Promise((r) => setTimeout(r, 400)); // outlives the client
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write('GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');

    await new Promise((r) => setTimeout(r, 120));
    expect(guard.stats().inFlight).toBe(1);

    socket.destroy();
    await new Promise((r) => setTimeout(r, 200));

    expect(guard.stats().inFlight).toBe(0);
    expect(guard.stats().probes).toBe(0);
    expect(guard.stats().circuitState).toBe('closed');

    await app.close();
    await guard.stop();
  });

  test('a disconnect during a half-open probe does not wedge the circuit', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 2, maxConcurrency: 2 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 20, halfOpenMaxCalls: 1 },
    });
    const app = Fastify();
    await app.register(eluGuardFastify(guard));
    let mode: 'fail' | 'hang' | 'ok' = 'fail';
    app.get('/', async (_req, reply) => {
      if (mode === 'fail') return reply.code(500).send({ ok: false });
      if (mode === 'hang') await new Promise((r) => setTimeout(r, 400));
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    await app.inject({ method: 'GET', url: '/' });
    await app.inject({ method: 'GET', url: '/' });
    expect(guard.stats().circuitState).toBe('open');

    await new Promise((r) => setTimeout(r, 40));
    expect(guard.stats().circuitState).toBe('half-open');

    mode = 'hang';
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    await new Promise((r) => setTimeout(r, 120));
    expect(guard.stats().probes).toBe(1);

    socket.destroy();
    await new Promise((r) => setTimeout(r, 200));

    expect(guard.stats().probes).toBe(0);
    expect(guard.stats().circuitState).toBe('half-open');

    mode = 'ok';
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(guard.stats().circuitState).toBe('closed');
    expect(guard.stats().probes).toBe(0);

    await app.close();
    await guard.stop();
  });
});
