// Records keyed by data (session ids, tool names, paths). A null-prototype object has no inherited keys,
// so "constructor" or "__proto__" behave like any other key.
export const dict = <V>(): Record<string, V> => Object.create(null) as Record<string, V>;

export function dictOf<V>(entries: Iterable<[string, V]>): Record<string, V> {
  const d = dict<V>();
  for (const [k, v] of entries) d[k] = v;
  return d;
}

/** Adds `n` to a number counter made by `dict`. */
export function bump(d: Record<string, number>, key: string, n = 1): void {
  d[key] = (d[key] ?? 0) + n;
}
