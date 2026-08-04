/**
 * THE client clock (decision 130 — resolves audit B-4/Q1). Single-tenant
 * (invariant 5) means one deployment serves ONE client, and that client
 * has ONE business timezone: the zone whose midnight ends a billing day
 * and whose calendar the operator reads on screen. Billing boundary ≡
 * display zone by construction — B-4 was exactly these two disagreeing
 * (bills cut at UTC midnight, screens rendered UTC−3, so every day's
 * last three local hours were billed under the "wrong" visible day).
 *
 * The zone comes from the REQUIRED `CLIENT_TIMEZONE` env var (IANA name,
 * e.g. 'America/Sao_Paulo'), declared never inferred — same philosophy as
 * the trace source (decision 127): a silent UTC fallback is a wrong bill
 * waiting to happen. Each entry point initializes the clock at boot via
 * its environment-setup; every date-bucketing helper reads it from here.
 *
 * Viewer-independence is deliberate: the server formats display strings
 * in THIS zone, so two operators in different countries see identical
 * screens that agree with the invoice. The viewer's local time is a UX
 * nicety; the client's timezone is a contractual fact.
 *
 * Offsets are computed PER INSTANT through Intl (DST-correct for any IANA
 * zone), so nothing here assumes a fixed offset — Brazil dropped DST in
 * 2019, but the contract accepts any zone a future client lives in.
 */

let activeTimezone: string | null = null;

/** Throws unless `timezone` is an IANA name the runtime's ICU knows. */
export const assertValidTimezone = (timezone: string): void => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(
      `CLIENT_TIMEZONE "${timezone}" is not a valid IANA timezone name ` +
        "(e.g. 'America/Sao_Paulo', 'UTC') — decision 130.",
    );
  }
};

export const initializeClientClock = (timezone: string): void => {
  assertValidTimezone(timezone);
  activeTimezone = timezone;
};

/** Test seams only. Production code never uninitializes the clock. */
export const resetClientClockForTests = (): void => {
  activeTimezone = null;
};

/** The IANA zone name — for $dateTrunc, snapshot recording and labels. */
export const clientTimezone = (): string => {
  if (activeTimezone === null) {
    throw new Error(
      'Client clock not initialized — set CLIENT_TIMEZONE in the client env ' +
        '(required; decision 130) and boot through an entry point that calls ' +
        'initializeClientClock. Refusing to guess a timezone: a fallback ' +
        'zone is a wrong bill.',
    );
  }

  return activeTimezone;
};

const OFFSET_PATTERN = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/;

/**
 * UTC offset of the client zone AT the given instant, in milliseconds
 * (São Paulo → -10_800_000). Per-instant so DST zones are correct on both
 * sides of a transition.
 */
export const clientUtcOffsetMs = (instant: Date): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: clientTimezone(),
    timeZoneName: 'longOffset',
  }).formatToParts(instant);

  const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  const match = OFFSET_PATTERN.exec(raw);

  if (!match) {
    throw new Error(
      `Unparseable zone offset "${raw}" for ${clientTimezone()} — ` +
        'the ICU output changed shape (decision 130).',
    );
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);

  return sign * (hours * 60 + minutes) * 60_000;
};

/**
 * The instant at which the client-zone wall clock reads Y-M-01 00:00:00 —
 * i.e. the UTC moment the client's month M begins. Two-pass offset
 * correction handles DST zones (the offset at the guessed instant may
 * differ from the offset at the answer; one correction converges for
 * every real zone, whose transitions never sit on a month boundary).
 */
export const startOfClientMonth = (year: number, month: number): Date => {
  const wallAsUtc = Date.UTC(year, month - 1, 1);
  const firstGuess = wallAsUtc - clientUtcOffsetMs(new Date(wallAsUtc));

  return new Date(wallAsUtc - clientUtcOffsetMs(new Date(firstGuess)));
};

/** Client-zone calendar components of an instant. */
export const clientCalendarOf = (
  instant: Date,
): { year: number; month: number } => {
  const shifted = new Date(instant.getTime() + clientUtcOffsetMs(instant));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  };
};

/** The instant the client-zone day containing `instant` began. */
export const startOfClientDay = (instant: Date): Date => {
  const wall = new Date(instant.getTime() + clientUtcOffsetMs(instant));
  const wallAsUtc = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate(),
  );
  const firstGuess = wallAsUtc - clientUtcOffsetMs(new Date(wallAsUtc));

  return new Date(wallAsUtc - clientUtcOffsetMs(new Date(firstGuess)));
};

/**
 * The client-day start `days` CALENDAR days away from a client-day start —
 * stepped in wall-clock space, so a DST transition (23h/25h day) never
 * drifts the ladder off the client midnights the rollup buckets sit on.
 */
export const addClientDays = (dayStart: Date, days: number): Date => {
  const wall = new Date(dayStart.getTime() + clientUtcOffsetMs(dayStart));
  const target = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate() + days,
  );
  const firstGuess = target - clientUtcOffsetMs(new Date(target));

  return new Date(target - clientUtcOffsetMs(new Date(firstGuess)));
};
