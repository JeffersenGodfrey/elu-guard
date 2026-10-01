import type { IncomingMessage, ServerResponse } from 'node:http';
import { EluGuard } from '../../core/guard/guard';
import { LimitRejectedError } from '../../core/limiter/aimd-limiter';

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export function eluGuardHttp(guard: EluGuard, handler: HttpHandler): HttpHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const admission = guard.breaker.tryAcquire();
    if (admission.kind === 'reject') {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Service temporarily unavailable (circuit open)' }));
      return;
    }
    const releaseProbe = admission.kind === 'probe' ? admission.release : null;

    try {
      await guard.limiter.acquire();
    } catch (err) {
      if (releaseProbe) releaseProbe();
      if (err instanceof LimitRejectedError) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Service overloaded, try again shortly' }));
        return;
      }
      throw err;
    }

    let settled = false;
    const settle = (outcome: 'success' | 'failure' | 'abort') => {
      if (settled) return;
      settled = true;
      guard.limiter.release();
      if (releaseProbe) releaseProbe();
      // A client disconnect says nothing about the dependency, so it records no
      // outcome at all; only a completed 5xx counts as a failure.
      if (outcome === 'success') guard.breaker.recordSuccess();
      else if (outcome === 'failure') guard.breaker.recordFailure();
    };

    res.on('finish', () => settle(res.statusCode < 500 ? 'success' : 'failure'));
    // 'close' also fires after a normal finish; `settled` keeps that harmless.
    res.on('close', () => settle('abort'));

    await handler(req, res);
  };
}
