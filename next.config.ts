import type { NextConfig } from "next";

import { securityHeaders } from "./lib/security-headers";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  // Ship only the files `next start` needs at runtime (a pruned
  // node_modules + a server.js entrypoint) into `.next/standalone` so the
  // Docker image doesn't carry the full dev node_modules tree.
  // See the Dockerfile for how the standalone output is consumed.
  output: "standalone",

  // Don't advertise the framework to anyone scanning for version-specific bugs.
  poweredByHeader: false,

  // The dev-mode "N" badge sits bottom-left, exactly over the sidebar's
  // "Sign out" button. scripts/launch-local.sh runs `next dev`, so hide it.
  devIndicators: false,

  /**
   * Baseline security headers for EVERY response, including the ones the proxy
   * never sees: `_next/static/*` and `favicon.ico` are excluded by the proxy's
   * matcher, so without this they would ship bare — and a JS chunk served
   * without `nosniff` is exactly the kind of thing a content-type confusion
   * attack wants.
   *
   * Deliberately no `Content-Security-Policy` here. The real policy is
   * nonce-based and therefore has to be built per request in proxy.ts; a second
   * static CSP header would be INTERSECTED with it by the browser, and the
   * intersection of "nonce-abc" and a nonce-less policy blocks every script on
   * the site. One CSP, one place.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: Object.entries(securityHeaders({ isDev })).map(([key, value]) => ({
          key,
          value,
        })),
      },
    ];
  },
};

export default nextConfig;
