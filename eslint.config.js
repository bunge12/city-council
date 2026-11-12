// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const SIM_ENTRY_ONLY =
  "Import the sim only through its public entry, `@city-council/sim`. See CLAUDE.md rule 1.";
const SIM_IS_HEADLESS =
  "packages/sim must not import from client or server. See CLAUDE.md rule 1.";
const NO_CLOCK = "Sim code never reads the clock. See CLAUDE.md rule 3.";
const NO_TIMERS = "No timers inside packages/sim. The sim advances on a fixed tick. See CLAUDE.md rule 3.";
const NO_MATH_RANDOM =
  "No Math.random in packages/sim. Use the seeded generator in state. See CLAUDE.md rule 4.";

const UI_IS_A_VIEW =
  "UI components read sim state through the SimMirror's read-only copy and change it only by sending commands. See CLAUDE.md rules 2 and 8.";

/** Sim exports that make, write or step a state. UI components may not import them. */
const UI_WRITES_STATE = [
  "SimState",
  "createState",
  "submit",
  "step",
  "replay",
  "migrateState",
  "deserialize",
  "serialize",
  "seedRng",
  "nextU32",
  "nextInt",
  "nextFloat",
  "COMMANDS",
];

const INEXACT_MATH =
  "Terrain code uses only +, -, *, /, Math.sqrt, Math.floor and integer operations, which round the same in every engine. See CLAUDE.md rule 6.";

/** Clock, timer and randomness bans for all of packages/sim. */
const SIM_RESTRICTED_PROPERTIES = [
  { object: "Math", property: "random", message: NO_MATH_RANDOM },
  { object: "Date", property: "now", message: NO_CLOCK },
  { object: "performance", property: "now", message: NO_CLOCK },
  { object: "globalThis", property: "setTimeout", message: NO_TIMERS },
  { object: "globalThis", property: "setInterval", message: NO_TIMERS },
  { object: "globalThis", property: "performance", message: NO_CLOCK },
  { object: "self", property: "setTimeout", message: NO_TIMERS },
  { object: "self", property: "setInterval", message: NO_TIMERS },
  { object: "window", property: "setTimeout", message: NO_TIMERS },
  { object: "window", property: "setInterval", message: NO_TIMERS },
];

/**
 * Math functions whose results engines may round differently. Banned where
 * output is recomputed from a seed on every machine. abs, min, max, sign,
 * floor, ceil, round, trunc, fround, imul, clz32 and sqrt are exact.
 */
const INEXACT_MATH_FUNCTIONS = [
  "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "cbrt", "cos", "cosh",
  "exp", "expm1", "hypot", "log", "log10", "log1p", "log2", "pow", "sin", "sinh",
  "tan", "tanh", "f16round",
];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "playwright-report/**", "test-results/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
  },

  // Rule 1: the sim imports nothing from client or server.
  {
    files: ["packages/sim/**/*.{ts,js}"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@city-council/client",
                "@city-council/client/*",
                "@city-council/server",
                "@city-council/server/*",
                "**/client",
                "**/client/**",
                "**/server",
                "**/server/**",
              ],
              message: SIM_IS_HEADLESS,
            },
          ],
        },
      ],
      // Rules 3 and 4: no clock, no timers, no unseeded randomness.
      "no-restricted-properties": ["error", ...SIM_RESTRICTED_PROPERTIES],
      "no-restricted-globals": [
        "error",
        { name: "setTimeout", message: NO_TIMERS },
        { name: "setInterval", message: NO_TIMERS },
        { name: "performance", message: NO_CLOCK },
      ],
    },
  },

  // Rule 6: terrain is rebuilt from the seed on every machine, so only exact
  // operations. This block repeats the sim bans because a later
  // no-restricted-properties setting replaces an earlier one.
  {
    files: ["packages/sim/src/terrain/**/*.{ts,js}"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...SIM_RESTRICTED_PROPERTIES,
        ...INEXACT_MATH_FUNCTIONS.map((property) => ({ object: "Math", property, message: INEXACT_MATH })),
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "BinaryExpression[operator='**']", message: INEXACT_MATH },
        { selector: "AssignmentExpression[operator='**=']", message: INEXACT_MATH },
      ],
    },
  },

  // Rule 1: client and server reach the sim only through its entry file.
  {
    files: ["packages/client/**/*.{ts,tsx,js}", "packages/server/**/*.{ts,js}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@city-council/sim/*", "**/sim", "**/sim/**", "!@city-council/sim"],
              message: SIM_ENTRY_ONLY,
            },
          ],
        },
      ],
    },
  },

  // Rule 2 and 8: the UI is a view. Components read state through the
  // mirror's read-only copy and change it only by sending commands, so they
  // may not import the writable state type, anything that makes or steps a
  // state, or the worker's host and save code. This block repeats the entry
  // rule because a later no-restricted-imports setting replaces an earlier one.
  {
    files: ["packages/client/src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@city-council/sim",
              importNames: UI_WRITES_STATE,
              message: UI_IS_A_VIEW,
            },
          ],
          patterns: [
            {
              group: ["@city-council/sim/*", "**/sim", "**/sim/**", "!@city-council/sim"],
              message: SIM_ENTRY_ONLY,
            },
            {
              group: ["**/protocol/host", "**/protocol/worker", "**/save/saver", "**/save/store", "**/save/load"],
              message: UI_IS_A_VIEW,
            },
          ],
        },
      ],
    },
  },

  {
    files: ["packages/client/**/*.{ts,tsx,js}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      "packages/server/**/*.{ts,js}",
      "packages/client/soak/**/*.ts",
      "packages/client/vitest.soak.config.ts",
      "*.{js,ts}",
      "e2e/**/*.ts",
      "scripts/**/*.{js,mjs}",
    ],
    languageOptions: { globals: globals.node },
  },
);
