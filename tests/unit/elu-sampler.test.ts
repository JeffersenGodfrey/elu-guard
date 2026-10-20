import { EluSampler } from '../../src/core/elu/elu-sampler';

describe('EluSampler', () => {
  test('starts at 0 before the first sample', () => {
    const sampler = new EluSampler({ intervalMs: 20 });
    expect(sampler.current).toBe(0);
    sampler.stop();
  });

  test('reports a numeric ELU sample in [0, 1] after starting', (done) => {
    const sampler = new EluSampler({ intervalMs: 20 });
    const unsubscribe = sampler.onSample((elu) => {
      expect(typeof elu).toBe('number');
      expect(elu).toBeGreaterThanOrEqual(0);
      expect(elu).toBeLessThanOrEqual(1);
      unsubscribe();
      sampler.stop();
      done();
    });
    sampler.start();
  });

  test('stop() halts further sampling', (done) => {
    const sampler = new EluSampler({ intervalMs: 15 });
    let sampleCount = 0;
    sampler.onSample(() => {
      sampleCount++;
    });
    sampler.start();
    setTimeout(() => {
      sampler.stop();
      const countAtStop = sampleCount;
      setTimeout(() => {
        expect(sampleCount).toBe(countAtStop);
        done();
      }, 40);
    }, 20);
  });

  test('multiple listeners can subscribe independently and unsubscribe cleanly', (done) => {
    const sampler = new EluSampler({ intervalMs: 15 });
    let aCalls = 0;
    let bCalls = 0;
    const unsubA = sampler.onSample(() => aCalls++);
    sampler.onSample(() => {
      bCalls++;
      if (bCalls === 1) {
        unsubA();
      }
      if (bCalls === 2) {
        expect(aCalls).toBe(1);
        sampler.stop();
        done();
      }
    });
    sampler.start();
  });

  test('start() creates exactly one timer across two start() calls', () => {
    const spy = jest.spyOn(global, 'setInterval');
    try {
      const sampler = new EluSampler({ intervalMs: 15 });
      try {
        sampler.start();
        sampler.start();
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        sampler.stop();
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('calls unref() on the sampling timer when available', () => {
    const unref = jest.fn();
    const spy = jest.spyOn(global, 'setInterval').mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    try {
      const sampler = new EluSampler({ intervalMs: 15 });
      try {
        sampler.start();
        expect(unref).toHaveBeenCalledTimes(1);
      } finally {
        sampler.stop();
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('starts without throwing when the timer has no unref()', () => {
    const spy = jest.spyOn(global, 'setInterval').mockReturnValue({} as unknown as NodeJS.Timeout);
    try {
      const sampler = new EluSampler({ intervalMs: 15 });
      try {
        expect(() => sampler.start()).not.toThrow();
      } finally {
        sampler.stop();
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('uses the default interval when no options are given', () => {
    const spy = jest.spyOn(global, 'setInterval');
    try {
      const sampler = new EluSampler();
      try {
        expect(sampler.current).toBe(0);
        sampler.start();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toBe(1000);
      } finally {
        sampler.stop();
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('stop() before start() is safe', () => {
    const sampler = new EluSampler({ intervalMs: 20 });
    expect(() => sampler.stop()).not.toThrow();
  });
});
