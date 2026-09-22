export function mergePage<T>(current: T[], incoming: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...incoming.filter(item => !seen.has(key(item)) && Boolean(seen.add(key(item))))];
}
