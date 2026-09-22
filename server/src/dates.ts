// Timezone-aware local-date helpers. Dates are plain 'YYYY-MM-DD' strings
// computed in the configured local timezone, so "today" and streaks follow
// the user's local day, not UTC.

export function localDate(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function todayString(tz: string): string {
  return localDate(new Date(), tz);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isYesterday(today: string, prev: string): boolean {
  return addDays(today, -1) === prev;
}

export function nowIso(): string {
  return new Date().toISOString();
}