// Proves the rule-1/3/4/6 lint rules still fire. Each case lints a snippet as if
// it lived at `file` and checks which rule reports it. Run by `pnpm lint`.
import { ESLint } from "eslint";

const cases = [
  ["packages/sim/src/x.ts", 'import { a } from "@city-council/client";\nexport { a };', "no-restricted-imports"],
  ["packages/sim/src/x.ts", 'import { a } from "@city-council/server";\nexport { a };', "no-restricted-imports"],
  ["packages/sim/src/x.ts", 'import { a } from "../../client/src/main";\nexport { a };', "no-restricted-imports"],
  ["packages/client/src/x.ts", 'import { a } from "@city-council/sim/src/index";\nexport { a };', "no-restricted-imports"],
  ["packages/client/src/x.ts", 'import { a } from "../../sim/src/index";\nexport { a };', "no-restricted-imports"],
  ["packages/server/src/x.ts", 'import { a } from "@city-council/sim/src/index";\nexport { a };', "no-restricted-imports"],
  ["packages/sim/src/x.ts", "export const a = Math.random();", "no-restricted-properties"],
  ["packages/sim/src/x.ts", "export const a = Date.now();", "no-restricted-properties"],
  ["packages/sim/src/x.ts", "export const a = performance.now();", "no-restricted-properties"],
  ["packages/sim/src/x.ts", "setTimeout(() => undefined, 1);", "no-restricted-globals"],
  ["packages/sim/src/x.ts", "setInterval(() => undefined, 1);", "no-restricted-globals"],
  ["packages/sim/src/terrain/x.ts", "export const a = Math.sin(1);", "no-restricted-properties"],
  ["packages/sim/src/terrain/x.ts", "export const a = Math.pow(2, 3);", "no-restricted-properties"],
  ["packages/sim/src/terrain/x.ts", "export const a = Math.exp(1);", "no-restricted-properties"],
  ["packages/sim/src/terrain/x.ts", "export const a = Math.log(2);", "no-restricted-properties"],
  ["packages/sim/src/terrain/x.ts", "const { cos } = Math;\nexport const a = cos(1);", "no-restricted-properties"],
  ["packages/sim/src/terrain/x.ts", "export const a = (n: number) => n ** 2;", "no-restricted-syntax"],
  ["packages/sim/src/terrain/x.ts", "export const a = Math.random();", "no-restricted-properties"],
  ["packages/sim/src/terrain/x.ts", "export const a = Date.now();", "no-restricted-properties"],
  ["packages/sim/src/terrain/x.ts", "export const a = [Math.sqrt(2), Math.floor(1.5), Math.imul(3, 4)];", null],
  ["packages/client/src/x.ts", 'import { simInfo } from "@city-council/sim";\nexport const a = [simInfo, Math.random()];', null],
];

const eslint = new ESLint();
let failed = 0;
for (const [file, code, expected] of cases) {
  const [result] = await eslint.lintText(code, { filePath: file });
  const rules = new Set(result.messages.map((m) => m.ruleId));
  const ok = expected === null ? rules.size === 0 : rules.has(expected);
  if (!ok) {
    failed++;
    console.error(`FAIL ${file}: expected ${expected ?? "no errors"}, got [${[...rules].join(", ")}]\n  ${code}`);
  }
}
if (failed > 0) {
  console.error(`${failed} of ${cases.length} lint rule checks failed`);
  process.exit(1);
}
console.log(`lint rule checks: ${cases.length} passed`);
