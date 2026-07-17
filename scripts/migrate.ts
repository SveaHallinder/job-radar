import { neon } from "@neondatabase/serverless";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const CREATE_JOBS = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    original_url TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT NOT NULL,
    country TEXT,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    engagement_type TEXT NOT NULL,
    remote BOOLEAN,
    tags_json TEXT NOT NULL,
    match_reasons_json TEXT NOT NULL,
    posted_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )
`;

const CREATE_SYNC_RUNS = `
  CREATE TABLE IF NOT EXISTS sync_runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    fetched INTEGER NOT NULL DEFAULT 0,
    accepted INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    new_jobs INTEGER NOT NULL DEFAULT 0,
    updated_jobs INTEGER NOT NULL DEFAULT 0,
    source_results_json TEXT NOT NULL DEFAULT '[]',
    source_errors_json TEXT NOT NULL DEFAULT '[]'
  )
`;

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
