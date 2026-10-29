/** Local YYYY-MM-DD key for a date in the given IANA timezone. */
export function dayKey(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Consecutive days with activity ending today (or yesterday, if today has none yet). */
export function computeStreak(activity: Date[], now: Date, timeZone: string): number {
  const days = new Set(activity.map((d) => dayKey(d, timeZone)));
  const cursor = new Date(now);
  if (!days.has(dayKey(cursor, timeZone))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let n = 0;
  while (days.has(dayKey(cursor, timeZone))) {
    n++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return n;
}

/** Remaining whole seconds of a timer that ends at `endsAt` (ms epoch). */
export function remainingSeconds(endsAt: number, now: number): number {
  return Math.max(0, Math.round((endsAt - now) / 1000));
}
