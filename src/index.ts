export { EluSampler } from './core/elu/elu-sampler';
export type { EluSamplerOptions, EluListener } from './core/elu/elu-sampler';

export { AimdLimiter } from './core/limiter/aimd-limiter';
export type { AimdLimiterOptions, LimitChange, LimitChangeListener, LimitChangeReason } from './core/limiter/aimd-limiter';

export { CircuitBreaker } from './core/breaker/circuit-breaker';
export type { CircuitState, CircuitBreakerOptions, Admission } from './core/breaker/circuit-breaker';

import { EluGuard } from './core/guard/guard';
export { EluGuard } from './core/guard/guard';
export type { EluGuardOptions, EluGuardStats, EluGuardEvents, ExecuteOptions, ExecutionContext, RejectedReason } from './core/guard/guard';
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
