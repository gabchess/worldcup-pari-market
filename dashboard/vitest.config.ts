import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// instructions.test.ts imports client/pari-client.ts directly (a sibling
// package outside dashboard/, with no node_modules of its own) to compare
// the ported builders against it field-for-field. This alias redirects that
// file's bare `@solana/web3.js` import to dashboard's own installed copy so
// the cross-directory import resolves at test-run time. Test-only; does not
// affect `next build` or any runtime bundle.
//
// `react()` (added for TxButton/DepositPanel regression tests,
// codex-review-final.md P1 fixes) enables JSX/TSX transform for component
// tests. The jsdom environment itself is NOT set globally here -- it's
// opted into per-file via a `// @vitest-environment jsdom` pragma in
// TxButton.test.tsx/DepositPanel.test.tsx only. A global jsdom environment
// breaks the PDA-derivation lib tests: jsdom's vm-context gives Node's
// `Buffer` a stale `Uint8Array` prototype link, which fails the strict
// `instanceof Uint8Array` checks @noble/curves/@noble/hashes use inside
// @solana/web3.js's `findProgramAddressSync` (surfaces as "Unable to find a
// viable program address nonce"). The two files that need jsdom carry a
// one-line `Object.setPrototypeOf(Buffer.prototype, Uint8Array.prototype)`
// fix -- but this is NOT scoped to just that file's own test run.
// `Buffer.prototype` is a single object shared by the whole worker process,
// so the mutation is visible to every other test file that subsequently
// runs in the same worker, for the lifetime of that worker. This is
// harmless here: every test file in this project that touches Buffer wants
// the SAME corrected prototype link, so nothing in this repo depends on
// the original (stale) one. TxButton.test.tsx restores the prototype in an
// `afterAll` once its own suite finishes, so the mutation doesn't outlive
// the file that introduced it, even though the object it mutates is
// process-global rather than file-scoped.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@solana/web3.js",
        replacement: path.resolve(__dirname, "node_modules/@solana/web3.js"),
      },
      // Mirrors tsconfig.json's "@/*" -> "./src/*" path mapping (Next.js
      // reads that directly; Vite/Vitest need it spelled out explicitly).
      // Needed the moment a test imports a component that uses "@/..."
      // imports -- TxButton.tsx/DepositPanel.tsx already did before this
      // fix, just untested until the new regression tests exercised them.
      { find: /^@\//, replacement: path.resolve(__dirname, "src") + "/" },
    ],
  },
});
