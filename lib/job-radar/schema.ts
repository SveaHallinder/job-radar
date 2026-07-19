// Shared Postgres schema, used by scripts/migrate.ts (Neon) and the local
// pglite fallback in db.ts. Keep both statements single-statement-safe so the
// Neon HTTP driver can run each on its own.

export const CREATE_JOBS = `
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

export const CREATE_SYNC_RUNS = `
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
