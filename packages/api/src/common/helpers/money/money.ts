/**
 * Money is NEVER represented as floats (CLAUDE.md working agreement).
 *
 * Units:
 * - Prices are integer MICRO-CENTAVOS per million tokens (µ¢/M).
 *   1 R$ = 100 centavos; 1 centavo = 1_000_000 µ¢; so 1 R$ = 1e8 µ¢.
 *   µ¢ resolution (1e-8 R$) is fine enough to register contracted prices
 *   derived from US$ × PTAX × markup without loss at any realistic scale.
 * - Stamped costs are integer µ¢. Line-level cost keeps full µ¢ precision;
 *   only displayed/billed totals are rounded (half-up, 2 decimal places),
 *   per T5.
 *
 * All intermediate products use BigInt (tokens × price exceeds 2^53), and
 * every value that leaves this module is asserted to fit MAX_SAFE_INTEGER,
 * where integers are exact as IEEE doubles (safe to store in MongoDB and
 * to $sum in aggregations). 2^53 µ¢ ≈ R$ 90 million — asserted, not assumed.
 */

export const MICROCENTS_PER_CENT = 1_000_000;
export const MICROCENTS_PER_BRL = 100_000_000;
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const assertSafeInteger = (value: bigint, label: string): number => {
  if (value < 0n) {
    throw new Error(`Money error: ${label} must not be negative`);
  }

  if (value > MAX_SAFE) {
    throw new Error(
      `Money error: ${label} exceeds MAX_SAFE_INTEGER (${value.toString()})`,
    );
  }

  return Number(value);
};

const assertNonNegativeInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Money error: ${label} must be a non-negative safe integer, got ${value}`,
    );
  }
};

const halfUpDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator / 2n) / denominator;

/**
 * Parses a decimal BRL string (dot decimal separator, up to 8 fraction
 * digits) into integer micro-centavos. String input only — never floats.
 */
export const brlToMicrocents = (value: string): number => {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value.trim());

  if (!match) {
    throw new Error(
      `Money error: invalid BRL amount "${value}" (expected e.g. "12.3456", up to 8 decimal places)`,
    );
  }

  const [, integerPart, fractionPart = ''] = match;
  const paddedFraction = fractionPart.padEnd(8, '0');

  const microcents =
    BigInt(integerPart) * BigInt(MICROCENTS_PER_BRL) + BigInt(paddedFraction);

  return assertSafeInteger(microcents, `BRL amount "${value}"`);
};

/**
 * Cost of `tokens` at `priceMicrocentsPerMillion`, in integer µ¢,
 * rounded half-up at the µ¢ (1e-8 R$). Deterministic and reproducible.
 */
export const costMicrocents = (
  tokens: number,
  priceMicrocentsPerMillion: number,
): number => {
  assertNonNegativeInteger(tokens, 'tokens');
  assertNonNegativeInteger(priceMicrocentsPerMillion, 'price (µ¢/M)');

  const product = BigInt(tokens) * BigInt(priceMicrocentsPerMillion);
  const microcents = halfUpDiv(product, BigInt(TOKENS_PER_PRICE_UNIT));

  return assertSafeInteger(microcents, 'cost (µ¢)');
};

export const sumMicrocents = (values: number[]): number => {
  let total = 0n;

  for (const value of values) {
    assertNonNegativeInteger(value, 'µ¢ value');
    total += BigInt(value);
  }

  return assertSafeInteger(total, 'µ¢ sum');
};

/** Displayed centavos (half-up at the centavo) for a µ¢ amount. */
export const microcentsToDisplayCents = (microcents: number): number => {
  assertNonNegativeInteger(microcents, 'µ¢ value');

  return Number(halfUpDiv(BigInt(microcents), BigInt(MICROCENTS_PER_CENT)));
};

const centsToBrlString = (cents: number): string => {
  const integerPart = Math.trunc(cents / 100);
  const fractionPart = cents % 100;

  return `${integerPart}.${String(fractionPart).padStart(2, '0')}`;
};

/** Display rule (T5): totals rounded half-up to 2 decimal places. */
export const formatBrlFromMicrocents = (microcents: number): string =>
  centsToBrlString(microcentsToDisplayCents(microcents));

/**
 * Largest-remainder reconciliation (T5: "as partes exibidas fecham com o
 * total exibido"): given exact part costs in µ¢, produces displayed cents
 * per part that sum EXACTLY to the displayed total (half-up of the exact
 * sum). Ties break deterministically by lowest index.
 */
export const reconcileDisplayCents = (
  partsMicrocents: number[],
): { totalCents: number; partsCents: number[] } => {
  const totalCents = microcentsToDisplayCents(sumMicrocents(partsMicrocents));

  const floors = partsMicrocents.map((microcents) =>
    Math.trunc(microcents / MICROCENTS_PER_CENT),
  );
  const remainders = partsMicrocents.map(
    (microcents) => microcents % MICROCENTS_PER_CENT,
  );

  let deficit = totalCents - floors.reduce((sum, cents) => sum + cents, 0);

  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const partsCents = [...floors];

  for (const { index } of order) {
    if (deficit <= 0) break;

    partsCents[index] += 1;
    deficit -= 1;
  }

  return { totalCents, partsCents };
};

export const formatBrlFromCents = (cents: number): string => {
  assertNonNegativeInteger(cents, 'cents value');

  return centsToBrlString(cents);
};

/**
 * Exact BRL string, full µ¢ precision (T5: full precision at line level —
 * only totals get display rounding). Trailing zeros trimmed to 2 decimals
 * minimum: 2_625_000_000 µ¢ → "26.25", 715_000 µ¢ → "0.00715".
 */
export const formatBrlExactFromMicrocents = (microcents: number): string => {
  assertNonNegativeInteger(microcents, 'µ¢ value');

  const integerPart = Math.trunc(microcents / MICROCENTS_PER_BRL);
  const fraction = String(microcents % MICROCENTS_PER_BRL).padStart(8, '0');
  const trimmedFraction = fraction.replace(/0+$/, '').padEnd(2, '0');

  return `${integerPart}.${trimmedFraction}`;
};
