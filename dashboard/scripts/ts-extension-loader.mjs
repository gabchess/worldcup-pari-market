// Minimal Node ESM resolve hook for devnet-verify.mts.
// dashboard/src/lib/*.ts uses extensionless relative imports
// (e.g. `from "./pari"`) -- correct for tsconfig's "moduleResolution":
// "bundler" (what Next.js/webpack/vitest already use, and what next build's
// own tsc already type-checks against), but Node's native ESM loader
// requires explicit extensions. Rather than edit those already-shipped
// files' import style just to satisfy this one ad-hoc verifier script, this
// hook retries a failed relative-specifier resolution with ".ts" appended.
// Registered via scripts/register-ts-loader.mjs.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND" && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      return await nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
