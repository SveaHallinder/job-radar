import { createHash, randomUUID } from "node:crypto";

import { neon } from "@neondatabase/serverless";

import { CREATE_JOBS, CREATE_SYNC_RUNS } from "./schema";
import type {
  DashboardStats,
  JobRepository,
  MatchedJob,
  SourceResult,
  StoredJob,
  SyncStatus,
  SyncSummary,
} from "./types";

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

// Both @neondatabase/serverless and pglite return an array of row objects from
// query(), but be defensive about the node-postgres-style `{ rows }` shape too.
function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

// Production: Neon Postgres over HTTP.
function neonExecutor(connectionString: string): SqlExecutor {
  const sql = neon(connectionString);
  return {
    query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
      toRows<T>(await sql.query(text, params ?? [])),
  };
}

// Local development fallback when DATABASE_URL is unset: an in-process pglite
// (real Postgres via WASM) persisted under .data, so `npm run dev` works with
// zero infra and data survives restarts. pglite is dynamic-imported so it never
// enters the production serverless bundle.
function pgliteExecutor(): SqlExecutor {
  let ready: Promise<{ query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }> | undefined;
  const getDb = () => {
    if (!ready) {
      ready = (async () => {
        const { PGlite } = await import("@electric-sql/pglite");
        const dataDir = process.env.JOB_RADAR_PGLITE_PATH ?? ".data/pg";
        const db = new PGlite(dataDir);
        await db.exec(`${CREATE_JOBS};${CREATE_SYNC_RUNS};`);
        return db;
      })();
    }
    return ready;
  };
  return {
    query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
      const db = await getDb();
      return toRows<T>(await db.query(text, params ?? []));
    },
  };
}

interface JobRow {
  id: string;
  canonical_url: string;
  source: string;
  external_id: string;
  source_url: string;
  original_url: string;
  title: string;
  company: string;
  location: string;
  country: string | null;
  description: string;
  category: "Sales" | "Marketing";
  engagement_type: string;
  remote: boolean | null;
  tags_json: string;
  match_reasons_json: string;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface SyncRow {
  run_id: string;
  status: SyncStatus;
  started_at: string;
  completed_at: string;
  fetched: number;
  accepted: number;
  rejected: number;
  new_jobs: number;
  updated_jobs: number;
  source_results_json: string;
  source_errors_json: string;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function mapJobRow(row: JobRow): StoredJob {
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    source: row.source,
    externalId: row.external_id,
    sourceUrl: row.source_url,
    originalUrl: row.original_url,
    title: row.title,
    company: row.company,
    location: row.location,
    country: row.country,
    description: row.description,
    category: row.category,
    normalizedEngagementType: row.engagement_type,
    engagementType: row.engagement_type,
    remote: row.remote,
    tags: parseJsonArray<string>(row.tags_json),
    matchReasons: parseJsonArray<string>(row.match_reasons_json),
    postedAt: row.posted_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapSyncRow(row: SyncRow): SyncSummary {
  return {
    runId: row.run_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    fetched: row.fetched,
    accepted: row.accepted,
    rejected: row.rejected,
    newJobs: row.new_jobs,
    updatedJobs: row.updated_jobs,
    sourceResults: parseJsonArray<SourceResult>(row.source_results_json),
    sourceErrors: parseJsonArray<string>(row.source_errors_json),
  };
}

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly exec: SqlExecutor) {}

  async startSyncRun(startedAt: string): Promise<string> {
    const runId = randomUUID();
    await this.exec.query(
      "INSERT INTO sync_runs (run_id, status, started_at) VALUES ($1, 'failed', $2)",
      [runId, startedAt],
    );
    return runId;
  }

  async upsertJob(job: MatchedJob, seenAt: string): Promise<"created" | "updated"> {
    const id = createHash("sha256").update(job.canonicalUrl).digest("hex").slice(0, 20);
    const params = [
      id,
      job.canonicalUrl,
      job.source,
      job.externalId,
      job.sourceUrl,
      job.originalUrl,
      job.title,
      job.company,
      job.location,
      job.country,
      job.description.slice(0, 1_200),
      job.category,
      job.normalizedEngagementType,
      job.remote === null ? null : job.remote,
      JSON.stringify(job.tags),
      JSON.stringify(job.matchReasons),
      job.postedAt,
      seenAt,
    ];

    const rows = await this.exec.query<{ inserted: boolean }>(
      `INSERT INTO jobs (
        id, canonical_url, source, external_id, source_url, original_url,
        title, company, location, country, description, category,
        engagement_type, remote, tags_json, match_reasons_json, posted_at,
        first_seen_at, last_seen_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
      ON CONFLICT (canonical_url) DO UPDATE SET
        source=EXCLUDED.source,
        external_id=EXCLUDED.external_id,
        source_url=EXCLUDED.source_url,
        original_url=EXCLUDED.original_url,
        title=EXCLUDED.title,
        company=EXCLUDED.company,
        location=EXCLUDED.location,
        country=EXCLUDED.country,
        description=EXCLUDED.description,
        category=EXCLUDED.category,
        engagement_type=EXCLUDED.engagement_type,
        remote=EXCLUDED.remote,
        tags_json=EXCLUDED.tags_json,
        match_reasons_json=EXCLUDED.match_reasons_json,
        posted_at=EXCLUDED.posted_at,
        last_seen_at=EXCLUDED.last_seen_at
      RETURNING (xmax = 0) AS inserted`,
      params,
    );

    return rows[0].inserted ? "created" : "updated";
  }

  async deleteJobBySourceId(source: string, externalId: string): Promise<void> {
    await this.exec.query("DELETE FROM jobs WHERE source = $1 AND external_id = $2", [
      source,
      externalId,
    ]);
  }

  async listJobsForValidation(
    sources: string[],
    afterId: string | null,
    limit: number,
  ): Promise<StoredJob[]> {
    if (sources.length === 0) return [];
    const cursorClause = afterId ? " AND id > $2" : "";
    const limitIndex = afterId ? 3 : 2;
    const text =
      "SELECT * FROM jobs WHERE source = ANY($1)" +
      cursorClause +
      " ORDER BY id ASC LIMIT $" +
      limitIndex;
    const params = afterId ? [sources, afterId, limit] : [sources, limit];
    const rows = await this.exec.query<JobRow>(text, params);
    return rows.map(mapJobRow);
  }

  async deleteJobById(id: string): Promise<void> {
    await this.exec.query("DELETE FROM jobs WHERE id = $1", [id]);
  }

  async finishSyncRun(summary: SyncSummary): Promise<void> {
    await this.exec.query(
      `UPDATE sync_runs SET
        status=$1,
        completed_at=$2,
        fetched=$3,
        accepted=$4,
        rejected=$5,
        new_jobs=$6,
        updated_jobs=$7,
        source_results_json=$8,
        source_errors_json=$9
      WHERE run_id=$10`,
      [
        summary.status,
        summary.completedAt,
        summary.fetched,
        summary.accepted,
        summary.rejected,
        summary.newJobs,
        summary.updatedJobs,
        JSON.stringify(summary.sourceResults),
        JSON.stringify(summary.sourceErrors),
        summary.runId,
      ],
    );
  }

  async listJobs(): Promise<StoredJob[]> {
    const rows = await this.exec.query<JobRow>(
      "SELECT * FROM jobs ORDER BY COALESCE(posted_at, first_seen_at) DESC, first_seen_at DESC",
    );
    return rows.map(mapJobRow);
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const countRows = await this.exec.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM jobs",
    );
    const totalJobs = Number(countRows[0].count);
    const lastRunRows = await this.exec.query<SyncRow>(
      "SELECT * FROM sync_runs WHERE completed_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
    );
    const lastRun = lastRunRows[0];

    return {
      totalJobs,
      newJobs: lastRun?.new_jobs ?? 0,
      lastRun: lastRun ? mapSyncRow(lastRun) : null,
    };
  }
}

let repository: PostgresJobRepository | undefined;

export function getJobRepository(): PostgresJobRepository {
  if (!repository) {
    const url = process.env.DATABASE_URL;
    repository = new PostgresJobRepository(url ? neonExecutor(url) : pgliteExecutor());
  }

  return repository;
}
