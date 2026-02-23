/**
 * args.ts — Shared canonical argument serialization utility.
 */
export function canonicalizeArgs(args: unknown): string {
  try {
    return JSON.stringify(args, (_key, value: unknown) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value as object).sort().reduce((sorted: Record<string, unknown>, key) => {
          sorted[key] = (value as Record<string, unknown>)[key];
          return sorted;
        }, {});
      }
      return value;
    });
  } catch {
    return String(args);
  }
}
