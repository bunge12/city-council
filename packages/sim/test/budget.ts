// Helpers for the benches' time budgets (issue #231).

/**
 * The message for a check that holds a time to a budget. The mark tells
 * `scripts/budget-retry.mjs` that the failure may be a pause of the runner,
 * so it runs the file once more; a failure without it fails the run at once.
 */
export const budget = (name: string): string => `[budget] ${name}`;

/**
 * A full garbage collection, run before each held case so the garbage the
 * setup or the case before it left is not collected inside this case's runs.
 * A collection the case itself causes on every call still shows. The bench
 * runs with `--expose-gc` (vitest.config.ts).
 */
export function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("the benches need node's --expose-gc, set in vitest.config.ts");
  gc();
}
