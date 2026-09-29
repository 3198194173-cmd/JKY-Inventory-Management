import { subtractQuantity } from "./decimal";
export type DailyValue = { date: string; quantity: string; unitName: string };
export function nextDate(date: string): string {
  const day = new Date(date + "T00:00:00Z"); day.setUTCDate(day.getUTCDate() + 1); return day.toISOString().slice(0,10);
}
export function comparableDates(dates: string[]): string[] {
  const existing = new Set(dates);
  return [...existing].filter(date => existing.has(nextDate(date))).sort().reverse();
}
export function dailySales(values: DailyValue[], dates: string[], currentUnit?: string): Record<string, string | null> {
  const byDate = new Map(values.map(value => [value.date, value]));
  return Object.fromEntries(dates.map(date => {
    const before = byDate.get(date), after = byDate.get(nextDate(date));
    return [date, before && after && before.unitName === after.unitName && (!currentUnit || before.unitName === currentUnit) ? subtractQuantity(before.quantity, after.quantity) : null];
  }));
}
