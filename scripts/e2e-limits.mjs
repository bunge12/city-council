// What scripts/check-e2e-timeouts.mjs and scripts/e2e-shard.mjs both need
// to know about e2e time limits (issue #228): the limit each test in a spec
// file sets, and the --global-timeout a CI runner's Playwright run gets.

/** A number written in the source: digits with `_` separators, or a product of them. */
export function literal(text) {
  const t = text.trim();
  if (!/^[\d_]+(\s*\*\s*[\d_]+)*$/.test(t)) return null;
  return t.split("*").reduce((n, part) => n * Number(part.trim().replaceAll("_", "")), 1);
}

/** Playwright's default test timeout in playwright.config.ts, in milliseconds. */
export function configTimeoutMs(config) {
  const ms = literal(/^ {2}timeout: ([\d_]+),/m.exec(config)?.[1] ?? "");
  if (ms === null) throw new Error("playwright.config.ts has no top-level `timeout: N,`");
  return ms;
}

/**
 * The milliseconds of each test limit a spec file sets, with its line. `ms`
 * is null for a limit the check cannot read: one that is not a number or a
 * `const` set to one in the same file, a timeout of 0 (none at all), or one
 * set through `test.describe.configure`. `test.slow()` in any form triples
 * the timeout in force, which is counted as the file's longest other limit.
 * `named` gives the milliseconds of constants a spec may import, by name:
 * the perf project's `PERF_TEST_TIMEOUT` (`namedLimits`).
 */
export function timeouts(source, defaultMs, named = {}) {
  const found = [];
  const slows = [];
  source.split("\n").forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(/\b(?!window\b|globalThis\b|self\b)\w+\.setTimeout\(([^)]*)\)?/g)) {
      const arg = m[1] ?? "";
      let ms = literal(arg);
      if (ms === null && Object.hasOwn(named, arg.trim())) ms = named[arg.trim()];
      else if (ms === null && /^\s*[A-Za-z_$][\w$]*\s*$/.test(arg)) {
        const def = new RegExp(`\\bconst ${arg.trim()}\\s*(?::\\s*number\\s*)?=\\s*([^;]+);`).exec(source);
        ms = def ? literal(def[1] ?? "") : null;
      }
      found.push({ line: i + 1, ms: ms === 0 ? null : ms, text: m[0] });
    }
    if (/\b\w+\.slow\(/.test(line)) slows.push(i + 1);
  });
  for (const m of source.matchAll(/\bdescribe\.configure\(([^)]*)\)/g)) {
    if (/\btimeout\b/.test(m[1] ?? "")) {
      found.push({ line: source.slice(0, m.index).split("\n").length, ms: null, text: "test.describe.configure({ timeout })" });
    }
  }
  const longest = Math.max(defaultMs, ...found.map((f) => f.ms ?? 0));
  for (const line of slows) found.push({ line, ms: 3 * longest, text: "test.slow()" });
  return found;
}

/** The longest any one test in the file may run, in milliseconds, or Infinity when a limit cannot be read. */
export function longestTestMs(source, defaultMs, named = {}) {
  return Math.max(defaultMs, ...timeouts(source, defaultMs, named).map((t) => t.ms ?? Infinity));
}

/** The name the perf specs give their one time limit (e2e/measure.ts). */
export const PERF_LIMIT_NAME = "PERF_TEST_TIMEOUT";

/** The limits a spec may name rather than write, from e2e/projects.json, for `timeouts`. */
export const namedLimits = (projects) => ({ [PERF_LIMIT_NAME]: projects.perfLimit.testMinutes * 60_000 });

/**
 * The --global-timeout for a runner planned at `plannedSeconds`, whose
 * longest test may run `longestMs` and is tried `attempts` times: `timesPlan`
 * times its plan, no less than `minMinutes`, and no less than its plan plus
 * every attempt of its longest test, so a test that times out still gets
 * its retry.
 */
export function globalTimeoutMs(projects, plannedSeconds, longestMs, attempts) {
  const { timesPlan, minMinutes } = projects.globalTimeout;
  return Math.ceil(Math.max(timesPlan * plannedSeconds * 1000, minMinutes * 60_000, plannedSeconds * 1000 + attempts * longestMs));
}

/** How many times a test in the project runs when it fails on CI: the perf project does not retry (playwright.config.ts). */
export const attemptsOf = (project) => (project === "perf" ? 1 : 2);
