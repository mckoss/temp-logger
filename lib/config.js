export function numberOption(value, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = true } = {}) {
  if (value === undefined) return fallback;
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number)) || number < min || number > max) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return number;
}

export function timeRange(query, duration) {
  const to = numberOption(query.to, 'to', Date.now());
  const from = numberOption(query.from, 'from', Math.max(0, to - duration));
  if (from > to) throw new Error('from must be less than or equal to to');
  return { from, to };
}
