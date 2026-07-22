import { FakeTraceSourceClient } from './fake-trace-source-client.js';
import { sourceTraceSchema } from './source-trace-schema.js';

const WINDOW_1 = {
  from: new Date('2026-06-01T00:00:00.000Z'),
  to: new Date('2026-06-15T00:00:00.000Z'),
};

const WINDOW_2 = {
  from: new Date('2026-06-15T00:00:00.000Z'),
  to: new Date('2026-07-01T00:00:00.000Z'),
};

const makeSut = () => {
  const sut = new FakeTraceSourceClient();

  return { sut };
};

describe('FakeTraceSourceClient', () => {
  describe('fetchTraces()', () => {
    it('MUST return only traces whose startedAt falls inside the half-open window', async () => {
      const { sut } = makeSut();

      const windowOne = await sut.fetchTraces(WINDOW_1);
      const windowTwo = await sut.fetchTraces(WINDOW_2);

      expect(windowOne.map((trace) => trace.traceId).sort()).toEqual([
        'trace-w1-001',
        'trace-w1-002',
        'trace-w1-003',
        'trace-w1-004',
        'trace-w1-005',
        'trace-w1-006',
      ]);
      expect(windowTwo.map((trace) => trace.traceId).sort()).toEqual([
        'trace-w2-001',
        'trace-w2-002',
        'trace-w2-003',
      ]);
    });

    it('MUST compose adjacent windows without overlap or gaps', async () => {
      const { sut } = makeSut();

      const all = await sut.fetchTraces({
        from: WINDOW_1.from,
        to: WINDOW_2.to,
      });
      const split = [
        ...(await sut.fetchTraces(WINDOW_1)),
        ...(await sut.fetchTraces(WINDOW_2)),
      ];

      expect(split.map((trace) => trace.traceId).sort()).toEqual(
        all.map((trace) => trace.traceId).sort(),
      );
    });

    it('MUST parse timestamps into Date instances (BSON-safe at the boundary)', async () => {
      const { sut } = makeSut();

      const traces = await sut.fetchTraces(WINDOW_1);

      for (const trace of traces) {
        expect(trace.startedAt).toBeInstanceOf(Date);
        expect(trace.finishedAt).toBeInstanceOf(Date);

        for (const span of trace.spans) {
          expect(span.startedAt).toBeInstanceOf(Date);
          expect(span.finishedAt).toBeInstanceOf(Date);
        }
      }
    });

    it('MUST carry the PoC edge cases in the fixtures', async () => {
      const { sut } = makeSut();

      const windowOne = await sut.fetchTraces(WINDOW_1);

      const errorTrace = windowOne.find(
        (trace) => trace.traceId === 'trace-w1-005',
      );
      expect(errorTrace?.status).toBe('error');
      expect(
        errorTrace?.spans.some(
          (span) => span.status === 'error' && span.errorMessage,
        ),
      ).toBe(true);

      const noSessionTrace = windowOne.find(
        (trace) => trace.traceId === 'trace-w1-004',
      );
      expect(noSessionTrace?.sessionId).toBeUndefined();

      const unpricedModelTrace = windowOne.find(
        (trace) => trace.traceId === 'trace-w1-006',
      );
      expect(unpricedModelTrace?.model).toBe('meta/llama-4-scout');
    });

    it('MUST preserve fixture order — same-session traces arrive shuffled', async () => {
      const { sut } = makeSut();

      const windowOne = await sut.fetchTraces(WINDOW_1);
      const checkoutSession = windowOne
        .filter((trace) => trace.sessionId === 'sess-checkout-001')
        .map((trace) => trace.traceId);

      expect(checkoutSession).toEqual([
        'trace-w1-002',
        'trace-w1-003',
        'trace-w1-001',
      ]);
    });
  });

  describe('sourceTraceSchema', () => {
    it('MUST reject malformed fixtures instead of ingesting garbage', () => {
      expect(() =>
        sourceTraceSchema.parse({ traceId: 'broken' }),
      ).toThrow();

      expect(() =>
        sourceTraceSchema.parse({
          traceId: 'trace-x',
          type: 'chat',
          channel: 'web',
          startedAt: 'not-a-date',
          finishedAt: '2026-06-01T00:00:00.000Z',
          status: 'ok',
          tokens: {},
          input: '',
          output: '',
          spans: [],
        }),
      ).toThrow();
    });
  });
});
