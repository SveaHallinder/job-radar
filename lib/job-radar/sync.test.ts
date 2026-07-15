import { describe, expect, it } from "vitest";

import { syncJobs } from "./sync";
import type {
  DashboardStats,
  JobConnector,
  JobRepository,
  MatchedJob,
  StoredJob,
  SyncSummary,
} from "./types";

class MemoryRepository implements JobRepository {
  saved: MatchedJob[] = [];
  deleted: string[] = [];
  summary: SyncSummary | null = null;

  startSyncRun(): string {
    return "run-1";
  }

  upsertJob(job: MatchedJob): "created" | "updated" {
    this.saved.push(job);
    return "created";
  }

  deleteJobBySourceId(source: string, externalId: string): void {
    this.deleted.push(`${source}:${externalId}`);
  }

  finishSyncRun(summary: SyncSummary): void {
    this.summary = summary;
  }

  listJobs(): StoredJob[] {
    return [];
  }

  getDashboardStats(): DashboardStats {
    return { totalJobs: this.saved.length, newJobs: this.saved.length, lastRun: this.summary };
  }
}

const matchingJob = {
  source: "Fixture",
  externalId: "match-1",
  sourceUrl: "https://source.example/match-1",
  originalUrl: "https://jobs.example.com/match-1?utm_source=fixture",
  title: "Freelance Marketing Consultant",
  company: "Northstar AB",
  location: "Remote - Europe",
  country: null,
  description: "Fully remote freelance contract open across EMEA.",
  engagementType: "Freelance",
  remote: true,
  tags: ["Marketing"],
  postedAt: "2026-07-15T08:00:00.000Z",
};

const rejectedJob = {
  ...matchingJob,
  externalId: "reject-1",
  originalUrl: "https://jobs.example.com/reject-1",
  title: "Permanent Sales Manager",
  description: "Permanent full-time remote role in Sweden.",
  engagementType: "Full-time",
  tags: ["Sales"],
};

describe("syncJobs", () => {
  it("keeps successful source results when another source fails", async () => {
    const repository = new MemoryRepository();
    const connectors: JobConnector[] = [
      {
        name: "Good source",
        fetchJobs: async () => [matchingJob, rejectedJob],
      },
      {
        name: "Broken source",
        fetchJobs: async () => {
          throw new Error("upstream unavailable");
        },
      },
    ];

    const summary = await syncJobs({
      connectors,
      repository,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveUrl: async (url) => url,
    });

    expect(summary).toMatchObject({
      status: "partial",
      fetched: 2,
      accepted: 1,
      rejected: 1,
      newJobs: 1,
      updatedJobs: 0,
    });
    expect(summary.sourceErrors).toEqual(["Broken source: upstream unavailable"]);
    expect(repository.saved).toHaveLength(1);
    expect(repository.deleted).toEqual(["Fixture:reject-1"]);
    expect(repository.saved[0].canonicalUrl).toBe("https://jobs.example.com/match-1");
    expect(repository.summary).toEqual(summary);
  });

  it("stores duplicate source records only once", async () => {
    const repository = new MemoryRepository();
    const connector: JobConnector = {
      name: "Duplicate source",
      fetchJobs: async () => [
        matchingJob,
        {
          ...matchingJob,
          externalId: "match-duplicate",
          originalUrl: "https://jobs.example.com/match-1?utm_campaign=duplicate",
        },
      ],
    };

    const summary = await syncJobs({
      connectors: [connector],
      repository,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveUrl: async (url) => url,
    });

    expect(summary).toMatchObject({ status: "success", fetched: 2, accepted: 1 });
    expect(repository.saved).toHaveLength(1);
  });
});
