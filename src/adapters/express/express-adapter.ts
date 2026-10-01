import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { EluGuard } from '../../core/guard/guard';
import { LimitRejectedError } from '../../core/limiter/aimd-limiter';

export function eluGuardExpress(guard: EluGuard): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const admission = guard.breaker.tryAcquire();
    if (admission.kind === 'reject') {
      res.status(503).json({ error: 'Service temporarily unavailable (circuit open)' });
      return;
    }
    const releaseProbe = admission.kind === 'probe' ? admission.release : null;

    try {
      await guard.limiter.acquire();
    } catch (err) {
      if (releaseProbe) releaseProbe();
      if (err instanceof LimitRejectedError) {
        res.status(503).json({ error: 'Service overloaded, try again shortly' });
        return;
      }
      next(err);
      return;
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

    next();
  };
}
