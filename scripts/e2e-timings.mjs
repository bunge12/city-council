// Brings the `seconds` in e2e/projects.json up to date from CI logs, so
// scripts/e2e-shard.mjs deals spec files out by what they take now.
//
//   gh run view <run id> --log | node scripts/e2e-timings.mjs
//   gh run view <run id> --log | node scripts/e2e-timings.mjs --write
//
// It reads the `e2e file seconds: {...}` lines that e2e/file-times-reporter.ts
// prints at the end of each runner's run, and prints each chromium file's old
// and new seconds. With --write it saves them. A file no log timed (its runner
// was cancelled, say) keeps its old figure, and is listed.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const path = new URL("../e2e/projects.json", import.meta.url);
const projects = JSON.parse(readFileSync(path, "utf8"));
const walkthrough = new RegExp(projects.walkthrough);
const chromium = readdirSync(new URL("../e2e/", import.meta.url))
  .filter((f) => f.endsWith(".spec.ts") && !walkthrough.test(f) && !projects.roads.includes(f))
  .sort();

const logs = readFileSync(0, "utf8");
const measured = {};
for (const [, json] of logs.matchAll(/e2e file seconds: (\{.*\})/g)) Object.assign(measured, JSON.parse(json));
if (Object.keys(measured).length === 0) {
  console.error("no `e2e file seconds:` lines in the input: pipe in the logs of a CI run's e2e jobs");
  process.exit(1);
}

const seconds = {};
const untimed = [];
for (const f of chromium) {
  const old = projects.seconds[f];
  const now = measured[f];
  if (now === undefined) untimed.push(f);
  if (now !== undefined || old !== undefined) seconds[f] = now ?? old;
  console.log(`${f.padEnd(32)} ${String(old ?? "-").padStart(5)} -> ${String(seconds[f] ?? "-").padStart(5)}`);
}
if (untimed.length > 0) console.log(`not timed by these logs, kept as they were: ${untimed.join(" ")}`);

if (process.argv.includes("--write")) {
  projects.seconds = seconds;
  writeFileSync(path, `${JSON.stringify(projects, null, 2)}\n`);
  console.log("written to e2e/projects.json; say which CI run they came from in its `_about`");
}
