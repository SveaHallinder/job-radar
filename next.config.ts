import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  outputFileTracingExcludes: {
    // playwright: local-only browser discovery. pglite: local-only dev DB
    // fallback (production always sets DATABASE_URL and uses Neon). Neither is
    // ever imported on the hosted path, so keep both out of the bundle.
    "/*": [
      "node_modules/playwright/**",
      "node_modules/playwright-core/**",
      "node_modules/@electric-sql/**",
    ],
  },
};

export default nextConfig;
