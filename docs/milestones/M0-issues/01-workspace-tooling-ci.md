# M0-01: Workspace, tooling and CI

Milestone: M0 Foundation and terrain. Spec: [M0.md](../M0.md). Depends on: none.

## Goal

An empty project that builds, lints, tests and runs in CI, with the package boundary enforced from the first commit.

## Scope

- pnpm workspace with `packages/sim`, `packages/client` and an empty `packages/server`
- TypeScript in strict mode across all three, with project references
- Vite for the client, with a placeholder page that imports one function from `sim`
- Vitest for `sim`, with one passing test
- ESLint with a rule that fails when `sim` imports from `client` or `server`, and when either imports from `sim` other than through its entry file
- ESLint bans `Math.random`, `Date.now`, `performance.now`, `setTimeout` and `setInterval` inside `packages/sim`
- Playwright installed, with one smoke test that loads the placeholder page
- GitHub Actions workflow that runs lint, unit tests, build and the smoke test on every pull request
- Scripts `dev`, `test`, `lint`, `e2e` and `build` at the root, matching `CLAUDE.md`
- Node version pinned in `.nvmrc`, `.node-version` and `package.json` engines

## Out of scope

- Any game code
- Deployment, which is issue 11

## Done when

- [ ] `pnpm install && pnpm lint && pnpm test && pnpm build && pnpm e2e` passes on a clean clone
- [ ] CI is green on the pull request
- [ ] A test commit that imports `client` from `sim` fails lint, shown in the pull request description
