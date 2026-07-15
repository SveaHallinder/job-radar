import { loadEnvConfig } from "@next/env";

import { getBrowserDiscoveryConfig } from "../lib/job-radar/browser/config";
import { BrowserRuntime } from "../lib/job-radar/browser/runtime";

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const config = getBrowserDiscoveryConfig();
  const runtime = new BrowserRuntime(config.profilePath);
  await runtime.run(async (context) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
    });
    console.log(
      "[job radar linkedin] Complete login in Chromium, then return here and press Enter.",
    );
    await new Promise<void>((resolve) =>
      process.stdin.once("data", () => resolve()),
    );
  });
}

main().catch((error) => {
  console.error("[job radar linkedin] Login setup failed", error);
  process.exitCode = 1;
});
