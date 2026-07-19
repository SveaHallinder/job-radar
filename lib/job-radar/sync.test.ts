import { describe, expect, it } from "vitest";

import { syncJobs } from "./sync";
import type {
  DashboardStats,
  JobConnector,
  JobRepository,
  MatchedJob,
  SearchRecord,
  SearchSpec,
  StoredJob,
  SyncRequest,
  SyncRequestKind,
  SyncSummary,
} from "./types";

class MemoryRepository implements JobRepository {
  saved: MatchedJob[] = [];
  deleted: string[] = [];
  summary: SyncSummary | null = null;

  async startSyncRun(): Promise<string> {
    return "run-1";
  }

  async upsertJob(job: MatchedJob): Promise<"created" | "updated"> {
    this.saved.push(job);
    return "created";
  }

  async deleteJobBySourceId(source: string, externalId: string): Promise<void> {
    this.deleted.push(`${source}:${externalId}`);
  }

  async listJobsForValidation(): Promise<StoredJob[]> {
    return [];
  }

  async deleteJobById(id: string): Promise<void> {
    this.deleted.push(id);
  }

  async finishSyncRun(summary: SyncSummary): Promise<void> {
    this.summary = summary;
  }

  async listJobs(): Promise<StoredJob[]> {
    return [];
  }

  async getDashboardStats(): Promise<DashboardStats> {
    return {
      totalJobs: this.saved.length,
      newJobs: this.saved.length,
      lastRun: this.summary,
      latestBrowserRequest: null,
    };
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

  async getLatestRunStartedAt(): Promise<string | null> {
    return null;
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

  it("runs API connectors in parallel and browser connectors serially", async () => {
    const repository = new MemoryRepository();
    const events: string[] = [];
    const connector = (
      name: string,
      execution: "parallel" | "browser",
    ): JobConnector => ({
      name,
      execution,
      fetchJobs: async () => {
        events.push(`${name}:start`);
        await Promise.resolve();
        events.push(`${name}:end`);
        return [];
      },
    });

    await syncJobs({
      connectors: [
        connector("API", "parallel"),
        connector("LinkedIn", "browser"),
        connector("Web discovery", "browser"),
      ],
      repository,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveUrl: async (url) => url,
    });

    expect(events.indexOf("LinkedIn:end")).toBeLessThan(
      events.indexOf("Web discovery:start"),
    );
  });

  it("skips browser connectors and records them when browserDiscovery is off", async () => {
    const repository = new MemoryRepository();
    let browserCalled = false;
    const connectors: JobConnector[] = [
      { name: "API", execution: "parallel", fetchJobs: async () => [] },
      {
        name: "LinkedIn",
        execution: "browser",
        fetchJobs: async () => {
          browserCalled = true;
          throw new Error("browser must not run in hosted cron");
        },
      },
    ];

    const summary = await syncJobs({
      browserDiscovery: false,
      connectors,
      repository,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveUrl: async (url) => url,
    });

    expect(browserCalled).toBe(false);
    const linkedin = summary.sourceResults.find(
      (result) => result.source === "LinkedIn",
    );
    expect(linkedin).toMatchObject({ status: "skipped" });
  });

  it("runs the active validator after upserts and records its result", async () => {
    const repository = new MemoryRepository();
    const summary = await syncJobs({
      connectors: [{ name: "API", fetchJobs: async () => [] }],
      activeValidator: async () => ({ checked: 4, deleted: 1, unknown: 1 }),
      repository,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveUrl: async (url) => url,
    });

    const validation = summary.sourceResults.find(
      (result) => result.source === "Active validation",
    );
    expect(validation).toMatchObject({
      status: "success",
      fetched: 4,
      accepted: 3,
      rejected: 1,
    });
  });

  it("marks the run partial when the active validator fails but preserves jobs", async () => {
    const repository = new MemoryRepository();
    const summary = await syncJobs({
      connectors: [{ name: "API", fetchJobs: async () => [matchingJob] }],
      activeValidator: async () => {
        throw new Error("browser crashed");
      },
      repository,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveUrl: async (url) => url,
    });

    expect(summary.status).toBe("partial");
    expect(
      summary.sourceErrors.some((message) =>
        message.includes("Active validation failed"),
      ),
    ).toBe(true);
    expect(repository.saved).toHaveLength(1);
  });

  it("does not run the active validator when browserDiscovery is off", async () => {
    const repository = new MemoryRepository();
    let validatorCalled = false;
    const summary = await syncJobs({
      browserDiscovery: false,
      connectors: [{ name: "API", fetchJobs: async () => [] }],
      activeValidator: async () => {
        validatorCalled = true;
        return { checked: 0, deleted: 0, unknown: 0 };
      },
      repository,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      resolveUrl: async (url) => url,
    });

    expect(validatorCalled).toBe(false);
    expect(
      summary.sourceResults.some((result) => result.source === "Active validation"),
    ).toBe(false);
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
