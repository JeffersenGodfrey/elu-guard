export { LimitRejectedError, LimiterAbortedError, ShuttingDownError } from '../core/limiter/aimd-limiter';
export { CircuitOpenError } from '../core/breaker/circuit-breaker';

interface CodedOptions {
  cause?: unknown;
}

class NamedError extends Error {
  constructor(name: string, message: string, options?: CodedOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = name;
  }
}

export class ConcurrencyLimitError extends NamedError {
  constructor(message = 'Concurrency limit reached', options?: CodedOptions) {
    super('ConcurrencyLimitError', message, options);
  }
}

export class GuardTimeoutError extends NamedError {
  constructor(message = 'Guard operation timed out', options?: CodedOptions) {
    super('GuardTimeoutError', message, options);
  }
}

export class GuardAbortedError extends NamedError {
  constructor(message = 'Guard operation aborted', options?: CodedOptions) {
    super('GuardAbortedError', message, options);
  }
}

export type GuardErrorName =
  | 'CircuitOpenError'
  | 'ConcurrencyLimitError'
  | 'GuardTimeoutError'
  | 'GuardAbortedError'
  | 'ShuttingDownError'
  | 'LimiterAbortedError'
  | 'LimitRejectedError';

