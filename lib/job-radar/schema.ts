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

// Queue of browser-sync requests. The hosted dashboard (serverless, no browser)
// inserts a 'pending' row when someone clicks "Synka via min dator"; a local
// worker on a machine with a logged-in browser claims it, runs the full sync
// (incl. LinkedIn), and writes the outcome back. This decouples the button from
// the machine — the request waits in Postgres until a worker is awake to run it.
export const CREATE_SYNC_REQUESTS = `
  CREATE TABLE IF NOT EXISTS sync_requests (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    run_id TEXT,
    message TEXT
  )
`;
