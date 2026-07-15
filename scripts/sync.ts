import { loadEnvConfig } from "@next/env";

import { syncJobs } from "../lib/job-radar/sync";

loadEnvConfig(process.cwd());

try {
  const summary = await syncJobs();
  console.info("[job radar] sync complete", {
    status: summary.status,
    fetched: summary.fetched,
    accepted: summary.accepted,
    rejected: summary.rejected,
    newJobs: summary.newJobs,
    updatedJobs: summary.updatedJobs,
    sourceErrors: summary.sourceErrors,
  });
  if (summary.status === "failed") process.exitCode = 1;
} catch (error) {
  console.error("[job radar] sync failed", error);
  process.exitCode = 1;
}
