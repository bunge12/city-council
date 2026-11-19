// Appends a run's budget rows to the history file on the `budget-history`
// branch (issue #232), leaving out any job of a run the file already has,
// so "Re-run failed jobs" on main, which downloads the first attempt's
// artifacts again, does not add the same rows twice.
//
//   node scripts/budget-append.mjs <history.jsonl> <rows.jsonl>...
//
// Prints how many rows it appended.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [history, ...files] = process.argv.slice(2);
if (!history) {
  console.error("usage: node scripts/budget-append.mjs <history.jsonl> <rows.jsonl>...");
  process.exit(2);
}
const lines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "") : []);
const key = (row) => `${row.run}\u0000${row.job}`;
const seen = new Set(lines(history).map((l) => key(JSON.parse(l))));
const fresh = files.flatMap(lines).filter((l) => !seen.has(key(JSON.parse(l))));
if (fresh.length > 0) appendFileSync(history, `${fresh.join("\n")}\n`);
console.log(fresh.length);
