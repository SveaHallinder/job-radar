import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  outputFileTracingExcludes: {
    "/*": ["node_modules/playwright/**", "node_modules/playwright-core/**"],
  },
};

export default nextConfig;
