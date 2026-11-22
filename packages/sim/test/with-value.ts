/** Runs `body` with `key` of `record` set to `value`, and puts it back after. For a test that changes one balance number. */
export function withValue<T extends object, K extends keyof T, R>(record: T, key: K, value: T[K], body: () => R): R {
  const was = record[key];
  record[key] = value;
  try {
    return body();
  } finally {
    record[key] = was;
  }
}
