import {
  CircuitOpenError,
  ConcurrencyLimitError,
  GuardAbortedError,
  GuardTimeoutError,
  LimitRejectedError,
  LimiterAbortedError,
  ShuttingDownError,
} from '../../src/errors';

describe('error classes', () => {
  test('carry their default messages and names', () => {
    expect(new ConcurrencyLimitError()).toMatchObject({
      name: 'ConcurrencyLimitError',
      message: 'Concurrency limit reached',
    });
    expect(new GuardTimeoutError()).toMatchObject({
      name: 'GuardTimeoutError',
      message: 'Guard operation timed out',
    });
    expect(new GuardAbortedError()).toMatchObject({
      name: 'GuardAbortedError',
      message: 'Guard operation aborted',
    });
  });

  test('accept a custom message', () => {
    expect(new GuardTimeoutError('too slow').message).toBe('too slow');
  });

  test('carry cause through to the built-in Error cause', () => {
    const cause = new Error('downstream blew up');
    for (const err of [
      new ConcurrencyLimitError('limited', { cause }),
      new GuardTimeoutError('timed out', { cause }),
      new GuardAbortedError('aborted', { cause }),
    ]) {
      expect(err).toBeInstanceOf(Error);
      expect(err.cause).toBe(cause);
    }
  });

  test('leave cause unset when no options are given', () => {
    expect(new GuardTimeoutError().cause).toBeUndefined();
  });

  test('re-export the limiter and breaker error classes unchanged', () => {
    expect(new LimitRejectedError().message).toBe('Concurrency limit reached');
    expect(new ShuttingDownError().message).toBe('Guard is shutting down');
    expect(new LimiterAbortedError().message).toBe('Aborted while waiting for a slot');
    expect(new CircuitOpenError().message).toBe('Circuit is open');
  });
});
