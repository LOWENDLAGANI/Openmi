/** Next UTC midnight, the reset point for daily quotas. */
export function nextUtcMidnight(from: Date = new Date()): string {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1),
  ).toISOString();
}

export function todayUtc(from: Date = new Date()): string {
  return from.toISOString().slice(0, 10);
}
