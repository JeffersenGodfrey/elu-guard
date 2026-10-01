export { EluSampler } from './core/elu/elu-sampler';
export type { EluSamplerOptions, EluListener } from './core/elu/elu-sampler';

export { AimdLimiter } from './core/limiter/aimd-limiter';
export type { AimdLimiterOptions, LimitChangeListener } from './core/limiter/aimd-limiter';

export { CircuitBreaker } from './core/breaker/circuit-breaker';
export type { CircuitState, CircuitBreakerOptions, Admission } from './core/breaker/circuit-breaker';

import { EluGuard } from './core/guard/guard';
export { EluGuard } from './core/guard/guard';
export type { EluGuardOptions, EluGuardStats, EluGuardEvents, ExecuteOptions, ExecutionContext } from './core/guard/guard';
export const createGuard = (options?: import('./core/guard/guard').EluGuardOptions) => new EluGuard(options);

export {
  LimitRejectedError,
  LimiterAbortedError,
  ShuttingDownError,
  CircuitOpenError,
  ConcurrencyLimitError,
  GuardTimeoutError,
  GuardAbortedError,
} from './errors';
export type { GuardErrorName } from './errors';

export { eluGuardHttp } from './adapters/http/http-adapter';
export { eluGuardExpress } from './adapters/express/express-adapter';
export { eluGuardFastify } from './adapters/fastify/fastify-adapter';
