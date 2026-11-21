// Small checks shared by the balance loaders that list every problem with a
// file (M3-01). Each returns messages naming the field, so a bad edit says
// where it is.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is a finite number from 0 to 1. */
export function isShare(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** How far a list of shares may be from adding to 1, for decimals like 0.1 that floats hold inexactly. */
export const SHARE_SLACK = 1e-9;

/** Problems with `value` as shares keyed by `keys`: every key present, each a share, no other key, adding to 1. */
export function shareProblems(value: unknown, keys: readonly string[], where: string): string[] {
  if (!isRecord(value)) return [`${where} must be an object`];
  const errors: string[] = [];
  let sum = 0;
  for (const key of keys) {
    const v = value[key];
    if (!(key in value)) errors.push(`${where}.${key} is missing`);
    else if (!isShare(v)) errors.push(`${where}.${key} must be a share from 0 to 1`);
    else sum += v;
  }
  errors.push(...unknownKeys(value, keys, where));
  if (errors.length === 0 && Math.abs(sum - 1) > SHARE_SLACK) errors.push(`${where} must add to 1, not ${sum}`);
  return errors;
}

/** A problem for each key of `value` not in `keys`. Keys starting with an underscore are words for people. */
export function unknownKeys(value: Record<string, unknown>, keys: readonly string[], where: string): string[] {
  return Object.keys(value)
    .filter((key) => !keys.includes(key) && !key.startsWith("_"))
    .map((key) => `${where} has an unknown field "${key}"`);
}

/** How a number field is bounded. */
export interface NumberRule {
  /** The least it may be. */
  min: number;
  /** The most it may be; no limit when left out. */
  max?: number;
  /** True when it must be a whole number. */
  whole?: boolean;
  /** True when it may not equal `min`. */
  aboveMin?: boolean;
}

/** The problem with `value` as a number under `rule`, or null. A missing field is a problem. */
export function numberProblem(record: Record<string, unknown>, key: string, rule: NumberRule, where: string): string | null {
  const name = where === "" ? key : `${where}.${key}`;
  if (!(key in record)) return `${name} is missing`;
  const v = record[key];
  const max = rule.max ?? Number.POSITIVE_INFINITY;
  const ok =
    typeof v === "number" &&
    Number.isFinite(v) &&
    (rule.whole !== true || Number.isSafeInteger(v)) &&
    (rule.aboveMin === true ? v > rule.min : v >= rule.min) &&
    v <= max;
  if (ok) return null;
  const kind = rule.whole === true ? "a whole number" : "a number";
  const low = rule.aboveMin === true ? `above ${rule.min}` : `at least ${rule.min}`;
  return `${name} must be ${kind} ${low}${rule.max === undefined ? "" : ` and at most ${rule.max}`}`;
}

/** Problems with the fields of `record` under `rules`, and with any field it has that `rules` does not name. */
export function numberProblems(record: unknown, rules: Readonly<Record<string, NumberRule>>, where: string): string[] {
  if (!isRecord(record)) return [`${where} must be an object`];
  const errors: string[] = [];
  for (const [key, rule] of Object.entries(rules)) {
    const problem = numberProblem(record, key, rule, where);
    if (problem) errors.push(problem);
  }
  errors.push(...unknownKeys(record, Object.keys(rules), where === "" ? "the file" : where));
  return errors;
}
