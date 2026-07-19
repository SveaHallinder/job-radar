import { setTimeout as wait } from "node:timers/promises";

import { loadEnvConfig } from "@next/env";

import { getJobRepository } from "../lib/job-radar/db";
import { syncJobs } from "../lib/job-radar/sync";
import type { SyncRequestKind, SyncSummary } from "../lib/job-radar/types";

loadEnvConfig(process.cwd());

const KIND: SyncRequestKind = "linkedin";
const POLL_MS = Number(process.env.JOB_RADAR_WORKER_POLL_MS ?? 20_000);

// Compact, human-readable outcome written back to the request so the dashboard
// can show what the last run actually produced.
function summarize(summary: SyncSummary): string {
  const linkedin = summary.sourceResults.find((r) => r.source === "LinkedIn");
  const parts = [
    `${summary.newJobs} nya`,
    `${summary.updatedJobs} uppdaterade`,
  ];
  if (linkedin) {
    parts.push(
      linkedin.status === "success"
        ? `LinkedIn: ${linkedin.accepted}/${linkedin.fetched} träffar`
        : `LinkedIn: ${linkedin.status}`,
    );
  }
  if (summary.sourceErrors.length) {
    parts.push(`${summary.sourceErrors.length} källa felade`);
  }
  return parts.join(" · ");
}

async function processOne(): Promise<boolean> {
  const repository = getJobRepository();
  const claimed = await repository.claimNextBrowserRequest(
    KIND,
    new Date().toISOString(),
  );
  if (!claimed) return false;

  console.info(`[job radar worker] claimed request ${claimed.id} — running full sync`);
  try {
    const summary = await syncJobs();
    const status = summary.status === "failed" ? "failed" : "done";
    await repository.completeBrowserRequest(claimed.id, status, new Date().toISOString(), {
      runId: summary.runId,
      message: summarize(summary),
    });
    console.info(`[job radar worker] request ${claimed.id} ${status}`, {
      status: summary.status,
      newJobs: summary.newJobs,
      updatedJobs: summary.updatedJobs,
      sourceErrors: summary.sourceErrors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Okänt fel";
    await repository.completeBrowserRequest(claimed.id, "failed", new Date().toISOString(), {
      message,
    });
    console.error(`[job radar worker] request ${claimed.id} failed`, error);
  }
  return true;
}

async function runWorker(): Promise<never> {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "[job radar worker] DATABASE_URL is not set — the worker is using the LOCAL pglite database, " +
        "so results will NOT reach the hosted site. Set DATABASE_URL to the Neon connection string.",
    );
  }
  if (process.env.JOB_RADAR_BROWSER_DISCOVERY !== "1") {
    console.warn(
      "[job radar worker] JOB_RADAR_BROWSER_DISCOVERY is not '1' — LinkedIn will be skipped. " +
        "Enable it (and set LINKEDIN_SEARCH_URLS) for the worker to fetch LinkedIn.",
    );
  }
  console.info(
    `[job radar worker] started — polling for '${KIND}' sync requests every ${POLL_MS}ms`,
  );

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.info(`[job radar worker] ${signal} received — stopping after current cycle`);
      stopping = true;
    });
  }

  while (!stopping) {
    try {
      // Drain any backlog before sleeping so a burst of clicks all get served.
      let handled = await processOne();
      while (handled && !stopping) {
        handled = await processOne();
      }
    } catch (error) {
      // A transient DB error must not kill the worker — log and keep polling.
      console.error("[job radar worker] poll cycle failed", error);
    }
    if (!stopping) await wait(POLL_MS);
  }

  console.info("[job radar worker] stopped");
  process.exit(0);
}

runWorker().catch((error: unknown) => {
  console.error("[job radar worker] fatal", error);
  process.exit(1);
});
