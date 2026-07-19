import { beforeEach, describe, expect, it, vi } from "vitest";

import { PGlite } from "@electric-sql/pglite";

import { validateActiveJobs } from "./active-validation";
import { EMPTY_BROWSER_STATE, type BrowserState } from "./browser/state";
import { PostgresJobRepository, type SqlExecutor } from "./db";
import type {
  DashboardStats,
  JobRepository,
  MatchedJob,
  SearchRecord,
  SearchSpec,
  StoredJob,
  SyncRequest,
  SyncRequestKind,
} from "./types";

const storedJob: StoredJob = {
  id: "seed",
  source: "Web discovery",
  externalId: "seed",
  sourceUrl: "https://jobs.example.com/seed",
  originalUrl: "https://jobs.example.com/seed",
  canonicalUrl: "https://jobs.example.com/seed",
  title: "Freelance Marketing Consultant",
  company: "Northstar AB",
  location: "Remote - Europe",
  country: null,
  description: "Fully remote freelance contract open across EMEA.",
  engagementType: "Freelance",
  normalizedEngagementType: "Freelance",
  remote: true,
  tags: ["Marketing"],
  matchReasons: ["remote", "contract"],
  category: "Marketing",
  postedAt: "2026-07-15T08:00:00.000Z",
  firstSeenAt: "2026-07-15T08:00:00.000Z",
  lastSeenAt: "2026-07-15T08:00:00.000Z",
};

class MemoryRepository implements JobRepository {
  validationJobs: StoredJob[] = [];
  deletedIds: string[] = [];

  async startSyncRun(): Promise<string> {
    return "run-1";
  }
  async upsertJob(): Promise<"created" | "updated"> {
    return "created";
  }
  async deleteJobBySourceId(): Promise<void> {}
  async listJobsForValidation(
    sources: string[],
    afterId: string | null,
    limit: number,
  ): Promise<StoredJob[]> {
    return this.validationJobs
      .filter((job) => sources.includes(job.source))
      .filter((job) => (afterId ? job.id > afterId : true))
      .slice(0, limit);
  }
  async deleteJobById(id: string): Promise<void> {
    this.deletedIds.push(id);
  }
  async finishSyncRun(): Promise<void> {}
  async listJobs(): Promise<StoredJob[]> {
    return [];
  }
  async getDashboardStats(): Promise<DashboardStats> {
    return { totalJobs: 0, newJobs: 0, lastRun: null, latestBrowserRequest: null };
  }
  async requestBrowserSync(
    kind: SyncRequestKind,
    requestedAt: string,
  ): Promise<SyncRequest> {
    return {
      id: "req-1",
      kind,
      status: "pending",
      requestedAt,
      startedAt: null,
      completedAt: null,
      runId: null,
      message: null,
    };
  }
  async getLatestBrowserRequest(): Promise<SyncRequest | null> {
    return null;
  }
  async claimNextBrowserRequest(): Promise<SyncRequest | null> {
    return null;
  }
  async completeBrowserRequest(): Promise<void> {}
  async listSearches(): Promise<SearchRecord[]> {
    return [];
  }
  async addSearch(spec: SearchSpec, createdAt: string): Promise<SearchRecord> {
    return { id: "search-1", ...spec, createdAt };
  }
  async deleteSearch(): Promise<void> {}
}

function memoryStateStore(initial: BrowserState) {
  let state = { ...initial };
  return {
    async load(): Promise<BrowserState> {
      return { ...state };
    },
    async save(next: BrowserState): Promise<void> {
      state = { ...next };
    },
  };
}

describe("validateActiveJobs", () => {
  it("deletes only confirmed inactive jobs and advances the cursor", async () => {
    const repository = new MemoryRepository();
    repository.validationJobs = [
      { ...storedJob, id: "a", source: "LinkedIn", originalUrl: "https://www.linkedin.com/jobs/view/a" },
      { ...storedJob, id: "b", source: "Web discovery", originalUrl: "https://jobs.example.com/b" },
      { ...storedJob, id: "c", source: "Web discovery", originalUrl: "https://jobs.example.com/c" },
    ];
    const store = memoryStateStore({ ...EMPTY_BROWSER_STATE });
    const loader = vi.fn(async (url: string) =>
      url.endsWith("/a")
        ? { status: 200, url, text: "This job is no longer available" }
        : url.endsWith("/b")
          ? { status: 200, url, text: "Apply now" }
          : { status: 429, url, text: "Too many requests" },
    );

    const result = await validateActiveJobs(repository, store, loader, 3);

    expect(result).toEqual({ checked: 3, deleted: 1, unknown: 1 });
    expect(repository.deletedIds).toEqual(["a"]);
    expect((await store.load()).validationCursor).toBe("c");
  });

  it("preserves every job when the loader throws", async () => {
    const repository = new MemoryRepository();
    repository.validationJobs = [
      { ...storedJob, id: "a", source: "LinkedIn" },
      { ...storedJob, id: "b", source: "Web discovery" },
    ];
    const store = memoryStateStore({ ...EMPTY_BROWSER_STATE });
    const loader = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await validateActiveJobs(repository, store, loader, 50);

    expect(result).toEqual({ checked: 2, deleted: 0, unknown: 2 });
    expect(repository.deletedIds).toEqual([]);
  });
});

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

describe("PostgresJobRepository validation queries", () => {
  let repository: PostgresJobRepository;

  beforeEach(async () => {
    const db = new PGlite();
    await db.query(CREATE_JOBS);
    await db.query(CREATE_SYNC_RUNS);
    const exec: SqlExecutor = {
      query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
        (await db.query<T>(text, params ?? [])).rows,
    };
    repository = new PostgresJobRepository(exec);
  });

  function matchedJob(source: string, slug: string): MatchedJob {
    return {
      source,
      externalId: slug,
      sourceUrl: `https://jobs.example.com/${slug}`,
      originalUrl: `https://jobs.example.com/${slug}`,
      canonicalUrl: `https://jobs.example.com/${slug}`,
      title: "Freelance Marketing Consultant",
      company: "Northstar AB",
      location: "Remote - Europe",
      country: null,
      description: "Fully remote freelance contract open across EMEA.",
      engagementType: "Freelance",
      normalizedEngagementType: "Freelance",
      remote: true,
      tags: ["Marketing"],
      matchReasons: ["remote"],
      category: "Marketing",
      postedAt: "2026-07-15T08:00:00.000Z",
    };
  }

  it("lists only browser sources in id order and deletes a single row", async () => {
    const seenAt = "2026-07-15T08:00:00.000Z";
    await repository.upsertJob(matchedJob("JobTech", "jobtech-1"), seenAt);
    await repository.upsertJob(matchedJob("LinkedIn", "linkedin-1"), seenAt);
    await repository.upsertJob(matchedJob("Web discovery", "web-1"), seenAt);

    const rows = await repository.listJobsForValidation(
      ["LinkedIn", "Web discovery"],
      null,
      50,
    );

    expect(rows.map((row) => row.source).sort()).toEqual([
      "LinkedIn",
      "Web discovery",
    ]);
    expect(rows.some((row) => row.source === "JobTech")).toBe(false);
    const ids = rows.map((row) => row.id);
    expect([...ids].sort()).toEqual(ids);

    await repository.deleteJobById(rows[0].id);
    const remaining = await repository.listJobsForValidation(
      ["LinkedIn", "Web discovery"],
      null,
      50,
    );
    expect(remaining.map((row) => row.id)).toEqual([rows[1].id]);
  });
});
