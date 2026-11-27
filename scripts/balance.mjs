// `pnpm balance` (M3-21, PRD "Balance checks"): runs each standard city of
// packages/sim/test/balance/cities.ts for ten game years and prints a line a
// game year. One Node process a city, side by side; their tables come out in
// the cities' order, the same on every run. How long each took goes to
// stderr, so stdout can be saved and compared with a run after a change:
//
//   pnpm balance > before.txt
//   pnpm balance --set demand.arrivalsPerYearAtFullDemand=30000 > after.txt
//   diff before.txt after.txt
//
// Arguments: `--city <name>` (repeat it, or give names with commas) runs only
// those cities; `--years <n>` and `--set <file.path=value>` (repeat it) pass
// through to run.ts, which explains them.

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runner = fileURLToPath(new URL("../packages/sim/test/balance/run.ts", import.meta.url));
const hook = pathToFileURL(fileURLToPath(new URL("./ts-hook.mjs", import.meta.url))).href;
const register = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(hook)});`;
const CITIES = ["new-town", "homes", "balanced", "industry-lost", "rezoned"];

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const cities = [];
const pass = [];
for (let k = 0; k < args.length; k++) {
  if (args[k] === "--city") cities.push(...(args[++k] ?? "").split(",").filter(Boolean));
  else pass.push(args[k]);
}
for (const city of cities) {
  if (!CITIES.includes(city)) {
    console.error(`--city must be one of ${CITIES.join(", ")}, not ${JSON.stringify(city)}`);
    process.exit(2);
  }
}

/** Runs one city and resolves with its output, its exit code and the seconds it took. */
function run(city) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", register, runner, "--city", city, ...pass], { cwd: root });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ city, out, err, code: code ?? 1, seconds: Number(process.hrtime.bigint() - started) / 1e9 }));
  });
}

const results = await Promise.all((cities.length > 0 ? cities : CITIES).map(run));
let failed = false;
for (const { city, out, err, code, seconds } of results) {
  process.stdout.write(out + "\n");
  if (err) process.stderr.write(err);
  if (code !== 0) failed = true;
  process.stderr.write(`${city}: ${code === 0 ? "done" : `failed with exit code ${code}`} in ${seconds.toFixed(1)} s\n\n`);
}
process.exit(failed ? 1 : 0);
