export { LimitRejectedError, LimiterAbortedError, ShuttingDownError } from '../core/limiter/aimd-limiter';
export { CircuitOpenError } from '../core/breaker/circuit-breaker';

interface CodedOptions {
  cause?: unknown;
}

function errorWithCause(err: Error, options?: CodedOptions): Error {
  if (options && 'cause' in options && (err as { cause?: unknown }).cause === undefined) {
    try {
      (err as { cause?: unknown }).cause = options.cause;
    } catch {
      // ignore
    }
  }
  return err;
}

class NamedError extends Error {
  constructor(name: string, message: string, options?: CodedOptions) {
    super(message);
    this.name = name;
    errorWithCause(this, options);
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

