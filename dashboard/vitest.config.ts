import path from "path";
import { defineConfig } from "vitest/config";

// instructions.test.ts imports client/pari-client.ts directly (a sibling
// package outside dashboard/, with no node_modules of its own) to compare
// the ported builders against it field-for-field. This alias redirects that
// file's bare `@solana/web3.js` import to dashboard's own installed copy so
// the cross-directory import resolves at test-run time. Test-only; does not
// affect `next build` or any runtime bundle.
export default defineConfig({
  resolve: {
    alias: {
      "@solana/web3.js": path.resolve(
        __dirname,
        "node_modules/@solana/web3.js",
      ),
    },
  },
});
