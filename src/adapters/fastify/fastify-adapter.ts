import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { EluGuard } from '../../core/guard/guard';
import { LimitRejectedError } from '../../core/limiter/aimd-limiter';

const SLOT_SETTLE = Symbol('eluGuardSettle');

type SettleOutcome = 'success' | 'failure' | 'abort';
type Settle = (outcome: SettleOutcome) => void;

function buildPlugin(guard: EluGuard): FastifyPluginAsync {
  return async function eluGuardPlugin(fastify: FastifyInstance) {
    fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const admission = guard.breaker.tryAcquire();
      if (admission.kind === 'reject') {
        reply.code(503).send({ error: 'Service temporarily unavailable (circuit open)' });
        return reply;
      }
      try {
        await guard.limiter.acquire();
      } catch (err) {
        if (admission.kind === 'probe') admission.release();
        if (err instanceof LimitRejectedError) {
          reply.code(503).send({ error: 'Service overloaded, try again shortly' });
          return reply;
        }
        throw err;
      }

      const releaseProbe = admission.kind === 'probe' ? admission.release : null;
      let settled = false;
      const settle: Settle = (outcome) => {
        if (settled) return;
        settled = true;
        guard.limiter.release();
        if (releaseProbe) releaseProbe();
        // A client disconnect says nothing about the dependency, so it records
        // no outcome at all; only a completed 5xx counts as a failure.
        if (outcome === 'success') guard.breaker.recordSuccess();
        else if (outcome === 'failure') guard.breaker.recordFailure();
      };
      (request as unknown as Record<symbol, unknown>)[SLOT_SETTLE] = settle;

      // Reply-level events rather than the onRequestAbort hook: the hook only
      // exists from fastify 4.10, while the published peer range starts at 4.0.
      // A response that never completed (`writableEnded === false`) means the
      // client went away, which must free the slot without booking a failure.
      const onReplyDone = () => {
        if (reply.raw.writableEnded === false) settle('abort');
        else settle(reply.statusCode < 500 ? 'success' : 'failure');
      };
      reply.raw.once('close', onReplyDone);
      if (reply.raw.destroyed) onReplyDone(); // the client was already gone
    });

    fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
      const settle = (request as unknown as Record<symbol, unknown>)[SLOT_SETTLE] as Settle | undefined;
      if (!settle) return;
      if (reply.raw.writableEnded === false) settle('abort');
      else settle(reply.statusCode < 500 ? 'success' : 'failure');
    });
  };
}

export function eluGuardFastify(guard: EluGuard): FastifyPluginAsync {
  return fp(buildPlugin(guard), { name: 'elu-guard-fastify' });
}
