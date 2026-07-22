import {
  brlToMicrocents,
  costMicrocents,
  formatBrlExactFromMicrocents,
  formatBrlFromCents,
  formatBrlFromMicrocents,
  microcentsToDisplayCents,
  reconcileDisplayCents,
  sumMicrocents,
} from './money.js';

describe('Money helpers', () => {
  describe('brlToMicrocents()', () => {
    it('MUST convert whole and fractional BRL strings exactly', () => {
      expect(brlToMicrocents('1')).toBe(100_000_000);
      expect(brlToMicrocents('26.25')).toBe(2_625_000_000);
      expect(brlToMicrocents('3.4375')).toBe(343_750_000);
      expect(brlToMicrocents('0.16296')).toBe(16_296_000);
      expect(brlToMicrocents('0.00000001')).toBe(1);
    });

    it('MUST reject floats-in-disguise and malformed strings', () => {
      expect(() => brlToMicrocents('1,50')).toThrow();
      expect(() => brlToMicrocents('1.123456789')).toThrow();
      expect(() => brlToMicrocents('-1')).toThrow();
      expect(() => brlToMicrocents('abc')).toThrow();
      expect(() => brlToMicrocents('')).toThrow();
    });
  });

  describe('costMicrocents()', () => {
    it('MUST compute tokens × price / 1M exactly when it divides evenly', () => {
      // 1M tokens at R$ 26.25/M → exactly R$ 26.25
      expect(costMicrocents(1_000_000, brlToMicrocents('26.25'))).toBe(
        2_625_000_000,
      );
      expect(costMicrocents(0, brlToMicrocents('26.25'))).toBe(0);
    });

    it('MUST round half-up at the micro-centavo', () => {
      // 1 token at 1 µ¢/M → 0.000001 µ¢ → rounds to 0
      expect(costMicrocents(1, 1)).toBe(0);
      // 1 token at 500_000 µ¢/M → 0.5 µ¢ → rounds UP to 1
      expect(costMicrocents(1, 500_000)).toBe(1);
      // 1 token at 499_999 µ¢/M → rounds down to 0
      expect(costMicrocents(1, 499_999)).toBe(0);
      // 3 tokens at 500_000 µ¢/M → 1.5 µ¢ → rounds UP to 2
      expect(costMicrocents(3, 500_000)).toBe(2);
    });

    it('MUST stay exact when the intermediate product exceeds 2^53', () => {
      // 10M tokens at R$ 82.50/M: product = 1e7 × 8.25e9 = 8.25e16 > 2^53,
      // exact cost = R$ 825.00 = 8.25e10 µ¢ (still a safe integer)
      expect(costMicrocents(10_000_000, brlToMicrocents('82.50'))).toBe(
        82_500_000_000,
      );
    });

    it('MUST reject non-integer or negative inputs', () => {
      expect(() => costMicrocents(1.5, 100)).toThrow();
      expect(() => costMicrocents(-1, 100)).toThrow();
      expect(() => costMicrocents(1, 1.5)).toThrow();
      expect(() => costMicrocents(1, -100)).toThrow();
    });

    it('MUST throw when the result exceeds MAX_SAFE_INTEGER', () => {
      expect(() =>
        costMicrocents(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
      ).toThrow(/MAX_SAFE_INTEGER/);
    });
  });

  describe('sumMicrocents()', () => {
    it('MUST sum exactly and reject unsafe values', () => {
      expect(sumMicrocents([])).toBe(0);
      expect(sumMicrocents([1, 2, 3])).toBe(6);
      expect(() => sumMicrocents([1.5])).toThrow();
      expect(() =>
        sumMicrocents([Number.MAX_SAFE_INTEGER, 1]),
      ).toThrow(/MAX_SAFE_INTEGER/);
    });
  });

  describe('display rounding (half-up, 2 decimal places)', () => {
    it('MUST round half-up at the centavo', () => {
      expect(microcentsToDisplayCents(1_000_000)).toBe(1);
      expect(microcentsToDisplayCents(1_499_999)).toBe(1);
      expect(microcentsToDisplayCents(1_500_000)).toBe(2);
      expect(formatBrlFromMicrocents(2_625_000_000)).toBe('26.25');
      expect(formatBrlFromMicrocents(1_500_000)).toBe('0.02');
      expect(formatBrlFromMicrocents(0)).toBe('0.00');
      expect(formatBrlFromCents(105)).toBe('1.05');
    });

    it('MUST format line-level values exactly, never rounding (T5)', () => {
      expect(formatBrlExactFromMicrocents(715_000)).toBe('0.00715');
      expect(formatBrlExactFromMicrocents(2_625_000_000)).toBe('26.25');
      expect(formatBrlExactFromMicrocents(16_296_000)).toBe('0.16296');
      expect(formatBrlExactFromMicrocents(0)).toBe('0.00');
      expect(formatBrlExactFromMicrocents(100_000_000)).toBe('1.00');
    });
  });

  describe('reconcileDisplayCents()', () => {
    it('MUST make displayed parts sum exactly to the displayed total', () => {
      // Three parts of 0.5 centavo each: exact total 1.5 centavos → displays
      // as 2; naive per-part half-up would show 1+1+1 = 3.
      const { totalCents, partsCents } = reconcileDisplayCents([
        500_000, 500_000, 500_000,
      ]);

      expect(totalCents).toBe(2);
      expect(partsCents.reduce((sum, cents) => sum + cents, 0)).toBe(
        totalCents,
      );
    });

    it('MUST distribute to largest remainders first, ties by lowest index', () => {
      const { totalCents, partsCents } = reconcileDisplayCents([
        1_900_000, 1_100_000, 1_900_000,
      ]);

      // exact sum = 4.9 centavos → total displays as 5
      expect(totalCents).toBe(5);
      expect(partsCents).toEqual([2, 1, 2]);
    });

    it('MUST leave exact-centavo parts untouched', () => {
      const { totalCents, partsCents } = reconcileDisplayCents([
        1_000_000, 2_000_000,
      ]);

      expect(totalCents).toBe(3);
      expect(partsCents).toEqual([1, 2]);
    });

    it('MUST handle the empty case', () => {
      const { totalCents, partsCents } = reconcileDisplayCents([]);

      expect(totalCents).toBe(0);
      expect(partsCents).toEqual([]);
    });
  });
});
