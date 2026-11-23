// Lets Node run the sim's TypeScript as it stands, for `pnpm balance`
// (scripts/balance.mjs). The sources import each other without a file
// extension, as the bundler resolution in tsconfig.base.json allows; Node
// needs one, so a relative import Node cannot find is tried again with
// `.ts`, then as a folder's `index.ts`. Node's own type stripping does the
// rest (`--experimental-transform-types`, Node 22).

/** Node's module resolve hook. */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.startsWith(".") || /\.[a-z]+$/i.test(specifier)) throw error;
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      return next(`${specifier}/index.ts`, context);
    }
  }
}
