// Time helpers. Pure. tzOffsetMin is minutes EAST of UTC (local = utc + offset; NZDT = 780), a fixed
// offset: a DST change inside a span is not modelled.
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** UTC hour of day, 0-23. */
export function utcHour(ms: number): number {
  return mod(Math.floor(ms / HOUR_MS), 24);
}

/** Local hour of day, 0-23. */
export function localHour(ms: number, tzOffsetMin: number): number {
  return utcHour(ms + tzOffsetMin * 60_000);
}

/** Local calendar day as a day number since 1970-01-01 (local). */
export function localDay(ms: number, tzOffsetMin: number): number {
  return Math.floor((ms + tzOffsetMin * 60_000) / DAY_MS);
}

/** UTC ms of the local midnight that starts the day containing ms. */
export function localDayStart(ms: number, tzOffsetMin: number): number {
  return localDay(ms, tzOffsetMin) * DAY_MS - tzOffsetMin * 60_000;
}

/** UTC ms of the start of the clock hour containing ms. */
export function hourStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Index of the local clock hour containing ms (hours since the epoch, shifted by the zone offset). */
export function localHourIndex(ms: number, tzOffsetMin: number): number {
  return Math.floor((ms + tzOffsetMin * 60_000) / HOUR_MS);
}

/**
 * Active hours: the number of distinct local clock hours (UTC when tzOffsetMin is 0 or omitted)
 * that contain at least one timestamp. A request counts in the hour of its timestamp; idle hours do not.
 */
export function activeHours(tsList: number[], tzOffsetMin = 0): number {
  const hours = new Set<number>();
  for (const ts of tsList) hours.add(localHourIndex(ts, tzOffsetMin));
  return hours.size;
}
