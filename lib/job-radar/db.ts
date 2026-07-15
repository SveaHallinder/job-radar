import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type {
  DashboardStats,
  JobRepository,
  MatchedJob,
  SourceResult,
  StoredJob,
  SyncStatus,
  SyncSummary,
} from "./types";

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
  remote: number | null;
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
    remote: row.remote === null ? null : row.remote === 1,
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

export class SqliteJobRepository implements JobRepository {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
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
        remote INTEGER,
        tags_json TEXT NOT NULL,
        match_reasons_json TEXT NOT NULL,
        posted_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

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
      );
    `);
  }

  startSyncRun(startedAt: string): string {
    const runId = randomUUID();
    this.database
      .prepare("INSERT INTO sync_runs (run_id, status, started_at) VALUES (?, 'failed', ?)")
      .run(runId, startedAt);
    return runId;
  }

  upsertJob(job: MatchedJob, seenAt: string): "created" | "updated" {
    const existing = this.database
      .prepare("SELECT id FROM jobs WHERE canonical_url = ?")
      .get(job.canonicalUrl) as { id: string } | undefined;
    const values = {
      id:
        existing?.id ||
        createHash("sha256").update(job.canonicalUrl).digest("hex").slice(0, 20),
      canonicalUrl: job.canonicalUrl,
      source: job.source,
      externalId: job.externalId,
      sourceUrl: job.sourceUrl,
      originalUrl: job.originalUrl,
      title: job.title,
      company: job.company,
      location: job.location,
      country: job.country,
      description: job.description.slice(0, 1_200),
      category: job.category,
      engagementType: job.normalizedEngagementType,
      remote: job.remote === null ? null : job.remote ? 1 : 0,
      tagsJson: JSON.stringify(job.tags),
      matchReasonsJson: JSON.stringify(job.matchReasons),
      postedAt: job.postedAt,
      seenAt,
    };

    if (existing) {
      this.database
        .prepare(`
          UPDATE jobs SET
            source = @source,
            external_id = @externalId,
            source_url = @sourceUrl,
            original_url = @originalUrl,
            title = @title,
            company = @company,
            location = @location,
            country = @country,
            description = @description,
            category = @category,
            engagement_type = @engagementType,
            remote = @remote,
            tags_json = @tagsJson,
            match_reasons_json = @matchReasonsJson,
            posted_at = @postedAt,
            last_seen_at = @seenAt
          WHERE id = @id
        `)
        .run(values);
      return "updated";
    }

    this.database
      .prepare(`
        INSERT INTO jobs (
          id, canonical_url, source, external_id, source_url, original_url,
          title, company, location, country, description, category,
          engagement_type, remote, tags_json, match_reasons_json, posted_at,
          first_seen_at, last_seen_at
        ) VALUES (
          @id, @canonicalUrl, @source, @externalId, @sourceUrl, @originalUrl,
          @title, @company, @location, @country, @description, @category,
          @engagementType, @remote, @tagsJson, @matchReasonsJson, @postedAt,
          @seenAt, @seenAt
        )
      `)
      .run(values);
    return "created";
  }

  deleteJobBySourceId(source: string, externalId: string): void {
    this.database
      .prepare("DELETE FROM jobs WHERE source = ? AND external_id = ?")
      .run(source, externalId);
  }

  finishSyncRun(summary: SyncSummary): void {
    this.database
      .prepare(`
        UPDATE sync_runs SET
          status = @status,
          completed_at = @completedAt,
          fetched = @fetched,
          accepted = @accepted,
          rejected = @rejected,
          new_jobs = @newJobs,
          updated_jobs = @updatedJobs,
          source_results_json = @sourceResultsJson,
          source_errors_json = @sourceErrorsJson
        WHERE run_id = @runId
      `)
      .run({
        ...summary,
        sourceResultsJson: JSON.stringify(summary.sourceResults),
        sourceErrorsJson: JSON.stringify(summary.sourceErrors),
      });
  }

  listJobs(): StoredJob[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM jobs ORDER BY COALESCE(posted_at, first_seen_at) DESC, first_seen_at DESC",
      )
      .all() as JobRow[];
    return rows.map(mapJobRow);
  }

  getDashboardStats(): DashboardStats {
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as {
      count: number;
    };
    const lastRun = this.database
      .prepare(
        "SELECT * FROM sync_runs WHERE completed_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get() as SyncRow | undefined;

    return {
      totalJobs: count.count,
      newJobs: lastRun?.new_jobs ?? 0,
      lastRun: lastRun ? mapSyncRow(lastRun) : null,
    };
  }
}

let repository: SqliteJobRepository | undefined;

export function getJobRepository(): SqliteJobRepository {
  if (!repository) {
    const databasePath = process.env.JOB_RADAR_DB_PATH
      ? resolve(process.env.JOB_RADAR_DB_PATH)
      : resolve(process.cwd(), ".data", "job-radar.sqlite");
    repository = new SqliteJobRepository(databasePath);
  }

  return repository;
}
