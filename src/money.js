// All amounts are stored as integer cents to avoid floating point drift.
export function toCents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function fmt(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}
