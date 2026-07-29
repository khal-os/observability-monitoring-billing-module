import { clampWindowToQuietPeriod } from './quiet-period.js';

const QUIET_MS = 900_000; // 15 min
const NOW = new Date('2026-07-29T12:00:00.000Z');
const SAFE_TO = new Date('2026-07-29T11:45:00.000Z'); // now − quiet period

describe('clampWindowToQuietPeriod (decision 61 on the windowed path)', () => {
  it('passes a fully-settled window through unchanged', () => {
    const window = {
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-02T00:00:00.000Z'),
    };

    expect(clampWindowToQuietPeriod(window, QUIET_MS, NOW)).toEqual({
      window,
      clamped: false,
    });
  });

  it('clamps a window ending inside the quiet zone to now − quiet period', () => {
    const window = {
      from: new Date('2026-07-29T00:00:00.000Z'),
      to: new Date('2026-07-30T00:00:00.000Z'),
    };

    expect(clampWindowToQuietPeriod(window, QUIET_MS, NOW)).toEqual({
      window: { from: window.from, to: SAFE_TO },
      clamped: true,
    });
  });

  it('returns null for a window entirely inside the quiet zone — in-flight traces would freeze partial stamps', () => {
    const window = {
      from: new Date('2026-07-29T11:50:00.000Z'),
      to: new Date('2026-07-29T12:00:00.000Z'),
    };

    expect(clampWindowToQuietPeriod(window, QUIET_MS, NOW)).toBeNull();
  });

  it('treats a window ending exactly at the safe bound as settled (half-open contract)', () => {
    const window = {
      from: new Date('2026-07-29T11:00:00.000Z'),
      to: SAFE_TO,
    };

    expect(clampWindowToQuietPeriod(window, QUIET_MS, NOW)).toEqual({
      window,
      clamped: false,
    });
  });
});
