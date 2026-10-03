import Fastify from 'fastify';
import { EluGuard } from '../../src';
import { eluGuardFastify } from '../../src/fastify';

const app = Fastify();

// One guard per protected dependency - never one guard for the whole server.
const paymentsGuard = new EluGuard({
  limiter: { minConcurrency: 5, maxConcurrency: 100 },
  breaker: { failureThreshold: 0.5, minimumRequests: 10 },
  timeoutMs: 3000,
});

async function chargeCard(): Promise<{ id: string }> {
  return { id: 'ch_1' }; // stand-in for the real payments client call
}

async function start() {
  // Registered inside an encapsulated scope, so admission control applies to
  // the routes that front payments and to nothing else. (The plugin uses
  // fastify-plugin, so the hooks land on the scope it is registered into.)
  await app.register(async (scope) => {
    await scope.register(eluGuardFastify(paymentsGuard));

    scope.get('/payments/charge', async () => chargeCard());
    scope.get('/stats', async () => paymentsGuard.stats());
  });

  // Unprotected route: a request here cannot be rejected because payments is
  // unhealthy, and a failure here cannot trip the payments breaker.
  app.get('/health', async () => ({ ok: true }));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port });
  console.log(`Fastify example listening on http://localhost:${port}`);
}

// Graceful shutdown: stops the ELU sampler and rejects queued callers.
async function shutdown() {
  await app.close();
  await paymentsGuard.stop();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());

start();

