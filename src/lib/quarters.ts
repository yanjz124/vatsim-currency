export interface Quarter {
  year: number;
  q: 1 | 2 | 3 | 4;
  /** Inclusive start, UTC epoch ms. */
  start: number;
  /** Exclusive end, UTC epoch ms. */
  end: number;
  /** e.g. "Q3 2026" */
  label: string;
  /** e.g. "2026-Q3" — stable key */
  key: string;
}

export function makeQuarter(year: number, q: number): Quarter {
  // Normalise out-of-range quarters (e.g. q=0 → Q4 of previous year).
  const idx = year * 4 + (q - 1);
  const y = Math.floor(idx / 4);
  const qq = (idx - y * 4 + 1) as 1 | 2 | 3 | 4;
  const startMonth = (qq - 1) * 3;
  return {
    year: y,
    q: qq,
    start: Date.UTC(y, startMonth, 1),
    end: Date.UTC(y, startMonth + 3, 1),
    label: `Q${qq} ${y}`,
    key: `${y}-Q${qq}`,
  };
}

export function quarterOf(ms: number): Quarter {
  const d = new Date(ms);
  return makeQuarter(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) + 1);
}

export function shiftQuarter(qtr: Quarter, n: number): Quarter {
  return makeQuarter(qtr.year, qtr.q + n);
}

export function quarterFromKey(key: string): Quarter | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key);
  return m ? makeQuarter(Number(m[1]), Number(m[2])) : null;
}

/** Most recent `n` quarters, newest first, starting with the one containing `now`. */
export function recentQuarters(n: number, now = Date.now()): Quarter[] {
  const cur = quarterOf(now);
  return Array.from({ length: n }, (_, i) => shiftQuarter(cur, -i));
}

/** Hours of [start, end) that fall inside [winStart, winEnd). */
export function overlapHours(start: number, end: number, winStart: number, winEnd: number): number {
  const a = Math.max(start, winStart);
  const b = Math.min(end, winEnd);
  return b > a ? (b - a) / 3_600_000 : 0;
}

export function formatDateUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
