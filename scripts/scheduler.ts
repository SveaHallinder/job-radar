import { setTimeout as wait } from "node:timers/promises";

import { loadEnvConfig } from "@next/env";

import { getNextStockholmRun } from "../lib/job-radar/schedule";
import { syncJobs } from "../lib/job-radar/sync";

loadEnvConfig(process.cwd());

async function runScheduler(): Promise<never> {
  console.info("[job radar] scheduler started for 08:00 and 16:00 Europe/Stockholm");

  while (true) {
    const now = new Date();
    const nextRun = getNextStockholmRun(now);
    console.info(`[job radar] next sync ${nextRun.toISOString()}`);
    await wait(Math.max(0, nextRun.getTime() - now.getTime()));

    try {
      const summary = await syncJobs();
      console.info("[job radar] scheduled sync complete", {
        status: summary.status,
        fetched: summary.fetched,
        accepted: summary.accepted,
        newJobs: summary.newJobs,
        sourceErrors: summary.sourceErrors,
      });
    } catch (error) {
      console.error("[job radar] scheduled sync failed", error);
    }
  }
}

runScheduler().catch((error: unknown) => {
  console.error("[job radar] scheduler stopped", error);
  process.exitCode = 1;
});
