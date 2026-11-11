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
      "no-restricted-properties": [
        "error",
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
      ],
      "no-restricted-globals": [
        "error",
        { name: "setTimeout", message: NO_TIMERS },
        { name: "setInterval", message: NO_TIMERS },
        { name: "performance", message: NO_CLOCK },
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

  {
    files: ["packages/client/**/*.{ts,tsx,js}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["packages/server/**/*.{ts,js}", "*.{js,ts}", "e2e/**/*.ts", "scripts/**/*.{js,mjs}"],
    languageOptions: { globals: globals.node },
  },
);
