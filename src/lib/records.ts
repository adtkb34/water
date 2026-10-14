export function asRecords(items: readonly object[]): Record<string, unknown>[] {
  return items.map((item) => ({ ...item }) as Record<string, unknown>);
}
