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

    // The half-open allowance is 1, so the probe below is the only call that
    // can be admitted until it is handed back.
    mode = 'hang';
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    await new Promise((r) => setTimeout(r, 120));
    expect(guard.stats().probes).toBe(1);

    socket.destroy();
    await new Promise((r) => setTimeout(r, 200));

    // Leaking this reservation would leave the breaker rejecting every request
    // forever while looking "recoverable".
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
