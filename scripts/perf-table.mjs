// Prints the perf run's figures as a Markdown table, beside the same figures
// from the last perf run on main (issue #225). .github/workflows/perf.yml
// writes it to the job summary of a pull request's run.
//
//   node scripts/perf-table.mjs <this run's folder> [<main's folder>]
//
// Each folder holds the JSON files the perf specs write to
// test-results/perf/ (perfFigures in e2e/measure.ts), in any subfolder:
// `{ title, figures: { label: value } }`. A figure on one side only shows a
// dash on the other. CI runners draw in software and differ in speed by up
// to two times (issue #152), so a change shows a cost to look into, not a
// verdict: the table says which machine each side ran on when it can.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every figures file under `dir`, by file name. */
function read(dir) {
  const out = new Map();
  if (!dir || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data && typeof data.figures === "object") out.set(entry.name.replace(/\.json$/, ""), data);
    } catch {
      console.error(`skipped ${path}: not a figures file`);
    }
  }
  return out;
}

/** The machines the folder's runners named (machine.txt, one per runner), each once. */
function machine(dir) {
  if (!dir || !existsSync(dir)) return null;
  const names = new Set();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === "machine.txt") names.add(readFileSync(join(entry.parentPath ?? entry.path, entry.name), "utf8").trim());
  }
  return names.size > 0 ? [...names].join("; ") : null;
}

const [currentDir, baseDir] = process.argv.slice(2);
if (!currentDir) {
  console.error("usage: node scripts/perf-table.mjs <this run's folder> [<main's folder>]");
  process.exit(1);
}
const current = read(currentDir);
const base = read(baseDir);

const fmt = (v) => (v === undefined ? "–" : String(v));
const change = (now, then) => {
  if (now === undefined || then === undefined || then === 0) return "";
  const pct = Math.round(((now - then) / then) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
};

const lines = ["## Perf figures", ""];
if (base.size === 0) lines.push("No figures from a perf run on `main` to compare with.", "");
const here = machine(currentDir);
const there = machine(baseDir);
if (here || there) lines.push(`This run: ${here ?? "unknown machine"}. Main: ${there ?? "unknown machine"}.`, "");
lines.push(
  "Drawn in software on CI runners, which differ in speed by up to two times (#152). A change is a cost to look into, not a verdict.",
  "",
);
if (current.size === 0) lines.push("This run wrote no figures: see its logs.", "");

for (const name of [...new Set([...current.keys(), ...base.keys()])].sort()) {
  const now = current.get(name);
  const then = base.get(name);
  lines.push(`### ${now?.title ?? then?.title ?? name}`, "", "| Figure | main | this run | change |", "| --- | ---: | ---: | ---: |");
  const labels = [...new Set([...Object.keys(then?.figures ?? {}), ...Object.keys(now?.figures ?? {})])];
  for (const label of labels) {
    const a = then?.figures[label];
    const b = now?.figures[label];
    lines.push(`| ${label} | ${fmt(a)} | ${fmt(b)} | ${change(b, a)} |`);
  }
  lines.push("");
}
console.log(lines.join("\n"));
