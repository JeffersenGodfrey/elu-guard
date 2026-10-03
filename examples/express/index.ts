import express from 'express';
import { EluGuard } from '../../src';
import { eluGuardExpress } from '../../src/express';

const app = express();

// One guard per protected dependency. Do NOT wrap the whole server in a single
// guard: Stripe, your database and your queue are separate failure domains, and
// each needs its own breaker and its own limiter. A guard per dependency is what
// makes "Stripe is down" different from "this service is down".
const paymentsGuard = new EluGuard({
  limiter: { minConcurrency: 5, maxConcurrency: 100 },
  breaker: { failureThreshold: 0.5, minimumRequests: 10 },
  timeoutMs: 3000,
});

const inventoryGuard = new EluGuard({ timeoutMs: 1000 });

async function chargeCard(): Promise<{ id: string }> {
  return { id: 'ch_1' }; // stand-in for the real payments client call
}

async function lookupItem(id: string, signal?: AbortSignal): Promise<{ id: string }> {
  void signal; // a real client hands this to fetch/axios so the work really stops
  return { id }; // stand-in for the real inventory client call
}

// Placement 1: the adapter guards *this route* - the edge that fronts payments.
// Admission control here answers 503 when payments is open/overloaded instead
// of piling up, and a 5xx from the handler is what trips the breaker.
app.get(
  '/payments/charge',
  eluGuardExpress(paymentsGuard),
  async (_req, res) => {
    const charge = await chargeCard();
    res.json(charge);
  },
);

// Placement 2: no adapter - just wrap the downstream call where it happens.
// Use this inside your own service code; use the adapter for inbound routes.
app.get('/inventory/:id', async (req, res) => {
  try {
    const item = await inventoryGuard.execute(({ signal }) => lookupItem(req.params.id, signal));
    res.json(item);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/stats', (_req, res) =>
  res.json({ payments: paymentsGuard.stats(), inventory: inventoryGuard.stats() }),
);

// Graceful shutdown: stops the ELU sampler and rejects queued callers.
process.on('SIGTERM', () => {
  void Promise.all([paymentsGuard.stop(), inventoryGuard.stop()]).then(() => process.exit(0));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Express example listening on http://localhost:${port}`));

