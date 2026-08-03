// TZ pinned AWAY from UTC on purpose (B-8): if a timezone-less local
// datetime ever slips back into the accepted union, the assertions below
// would break differently per host — this pin makes the failure mode
// deterministic. The rejection assertions themselves are TZ-independent.
process.env.TZ = 'America/Sao_Paulo';

import { z } from 'zod';
import {
  isoDateParam,
  parseQuery,
  yearMonthQueryShape,
} from './query-validation.js';
import {
  InvalidParamError,
  MissingParamError,
} from '../errors/index.js';
import { registerPriceVersionRequestSchema } from '../controllers/prices/price-view-schemas.js';

describe('isoDateParam (B-8: no server-TZ-dependent instants)', () => {
  it('MUST accept date-only and offset-carrying datetimes', () => {
    for (const value of [
      '2026-06-01',
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00Z',
      '2026-06-01T00:00:00-03:00',
    ]) {
      const parsed = isoDateParam.safeParse(value);

      expect({ value, ok: parsed.success }).toEqual({ value, ok: true });
    }
  });

  it('MUST REJECT a timezone-less local datetime — new Date() would read it in the SERVER timezone', () => {
    for (const value of [
      '2026-06-01T00:00:00',
      '2026-06-01T00:00:00.000',
      '2026-06-01T12:30:00',
    ]) {
      const parsed = isoDateParam.safeParse(value);

      expect({ value, ok: parsed.success }).toEqual({ value, ok: false });
    }
  });

  it('MUST keep rejecting ISO-shaped impossible dates', () => {
    expect(isoDateParam.safeParse('2026-02-30').success).toBe(false);
  });
});

describe('effective_from (POST /prices) mirrors the same TZ rule', () => {
  const body = (effectiveFrom: string) => ({
    model: 'openai/gpt-5-mini',
    token_type: 'input',
    price_brl_per_million: '2.75',
    effective_from: effectiveFrom,
  });

  it('MUST accept date-only and offset-carrying datetimes', () => {
    expect(
      registerPriceVersionRequestSchema.safeParse(body('2026-06-01')).success,
    ).toBe(true);
    expect(
      registerPriceVersionRequestSchema.safeParse(
        body('2026-06-01T00:00:00-03:00'),
      ).success,
    ).toBe(true);
  });

  it('MUST REJECT a timezone-less local datetime — it would shift the immutable stamp boundary per host', () => {
    expect(
      registerPriceVersionRequestSchema.safeParse(body('2026-06-01T00:00:00'))
        .success,
    ).toBe(false);
  });
});

describe('yearMonthQueryShape + parseQuery (C-3: strict, house error mapping)', () => {
  const schema = z.strictObject(yearMonthQueryShape);

  it('MUST parse the calendar address from query strings', () => {
    const result = parseQuery(schema, { year: '2026', month: '6' });

    expect(result).toEqual({ ok: true, value: { year: 2026, month: 6 } });
  });

  it('MUST answer an absent required param as MissingParamError (house rule)', () => {
    const missingYear = parseQuery(schema, { month: '6' });
    const missingMonth = parseQuery(schema, { year: '2026' });

    expect(missingYear).toEqual({
      ok: false,
      response: { statusCode: 400, body: new MissingParamError('year') },
    });
    expect(missingMonth).toEqual({
      ok: false,
      response: { statusCode: 400, body: new MissingParamError('month') },
    });
  });

  it('MUST answer a malformed param as InvalidParamError on ITS name', () => {
    for (const [query, param] of [
      [{ year: 'abc', month: '6' }, 'year'],
      [{ year: '2026', month: '13' }, 'month'],
      [{ year: '1969', month: '6' }, 'year'],
    ] as const) {
      expect(parseQuery(schema, query)).toEqual({
        ok: false,
        response: { statusCode: 400, body: new InvalidParamError(param) },
      });
    }
  });

  it('MUST answer an unknown param as 400 on the unknown name — never silently ignored', () => {
    expect(parseQuery(schema, { year: '2026', month: '6', foo: 'x' })).toEqual({
      ok: false,
      response: { statusCode: 400, body: new InvalidParamError('foo') },
    });
  });
});
