// Fails if the Node version files disagree. `.nvmrc` is read by nvm and CI,
// `.node-version` by nodenv, fnm, asdf and others. Run by `pnpm lint`.
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8").trim();
const nvmrc = read(".nvmrc");
const nodeVersion = read(".node-version");

if (nvmrc !== nodeVersion) {
  console.error(`FAIL .nvmrc says ${nvmrc} but .node-version says ${nodeVersion}. Keep them the same.`);
  process.exit(1);
}
console.log(`Node version files agree on ${nvmrc}.`);
