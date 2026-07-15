import { describe, expect, it, vi } from "vitest";

import { validateActiveJobs } from "./active-validation";
import { EMPTY_BROWSER_STATE, type BrowserState } from "./browser/state";
import { SqliteJobRepository } from "./db";
import type {
  DashboardStats,
  JobRepository,
  MatchedJob,
  StoredJob,
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

  startSyncRun(): string {
    return "run-1";
  }
  upsertJob(): "created" | "updated" {
    return "created";
  }
  deleteJobBySourceId(): void {}
  listJobsForValidation(
    sources: string[],
    afterId: string | null,
    limit: number,
  ): StoredJob[] {
    return this.validationJobs
      .filter((job) => sources.includes(job.source))
      .filter((job) => (afterId ? job.id > afterId : true))
      .slice(0, limit);
  }
  deleteJobById(id: string): void {
    this.deletedIds.push(id);
  }
  finishSyncRun(): void {}
  listJobs(): StoredJob[] {
    return [];
  }
  getDashboardStats(): DashboardStats {
    return { totalJobs: 0, newJobs: 0, lastRun: null };
  }
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

describe("SqliteJobRepository validation queries", () => {
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

  it("lists only browser sources in id order and deletes a single row", () => {
    const repository = new SqliteJobRepository(":memory:");
    const seenAt = "2026-07-15T08:00:00.000Z";
    repository.upsertJob(matchedJob("JobTech", "jobtech-1"), seenAt);
    repository.upsertJob(matchedJob("LinkedIn", "linkedin-1"), seenAt);
    repository.upsertJob(matchedJob("Web discovery", "web-1"), seenAt);

    const rows = repository.listJobsForValidation(
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

    repository.deleteJobById(rows[0].id);
    const remaining = repository.listJobsForValidation(
      ["LinkedIn", "Web discovery"],
      null,
      50,
    );
    expect(remaining.map((row) => row.id)).toEqual([rows[1].id]);
  });
});
