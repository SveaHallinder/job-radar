import { neon } from "@neondatabase/serverless";
import { loadEnvConfig } from "@next/env";

import { CREATE_JOBS, CREATE_SYNC_RUNS } from "../lib/job-radar/schema";

loadEnvConfig(process.cwd());

async function migrate(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  }

  const sql = neon(connectionString);
  // The HTTP driver cannot run multi-statement blobs, so each statement runs
  // as its own call.
  await sql.query(CREATE_JOBS);
  await sql.query(CREATE_SYNC_RUNS);

  console.info("[job radar] migration complete: jobs, sync_runs");
}

migrate().catch((error: unknown) => {
  console.error("[job radar] migration failed", error);
  process.exit(1);
});
