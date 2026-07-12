/** @type {import('next').NextConfig} */
const nextConfig = {
  // Security headers (codex-review-final.md P2: "Missing CSP and
  // clickjacking headers"). Applied to every route.
  //
  // CSP is intentionally minimal here: only `frame-ancestors 'none'`, which
  // blocks this page from being framed by another site (clickjacking) and
  // does not touch script-src/style-src/connect-src at all -- so it cannot
  // break Next.js's inline hydration runtime or the wallet-adapter modal
  // (Phantom/Solflare popups are separate windows, unaffected by
  // frame-ancestors either way). ponytail: a fuller CSP (locked-down
  // script-src/connect-src) was not attempted -- verifying it doesn't break
  // the wallet-adapter's inline script usage needs an interactive browser
  // session to click through the connect flow, which this dispatch's
  // toolset (Bash + curl only) can't do. Upgrade path: add script-src/
  // connect-src directives once someone can click-verify the wallet modal
  // against them (see /security/csp in docs, or dev-server + browser check).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
