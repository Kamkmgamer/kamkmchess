/** Clocks render as m:ss at every size, even when the minutes exceed 59. */
export function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1_000));
  return Math.floor(total / 60) + ':' + (total % 60).toString().padStart(2, '0');
}
