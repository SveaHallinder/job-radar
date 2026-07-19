import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { PostgresJobRepository, type SqlExecutor } from "./db";
import {
  CREATE_JOBS,
  CREATE_SYNC_REQUESTS,
  CREATE_SYNC_RUNS,
} from "./schema";

describe("PostgresJobRepository browser-sync request queue", () => {
  let repository: PostgresJobRepository;

  beforeEach(async () => {
    const db = new PGlite();
    await db.query(CREATE_JOBS);
    await db.query(CREATE_SYNC_RUNS);
    await db.query(CREATE_SYNC_REQUESTS);
    const exec: SqlExecutor = {
      query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
        (await db.query<T>(text, params ?? [])).rows,
    };
    repository = new PostgresJobRepository(exec);
  });

  it("creates a pending request and surfaces it as the latest", async () => {
    const request = await repository.requestBrowserSync("linkedin", "2026-07-19T10:00:00.000Z");
    expect(request.status).toBe("pending");
    expect(request.kind).toBe("linkedin");

    const latest = await repository.getLatestBrowserRequest("linkedin");
    expect(latest?.id).toBe(request.id);
  });

  it("coalesces repeated requests while one is still pending", async () => {
    const first = await repository.requestBrowserSync("linkedin", "2026-07-19T10:00:00.000Z");
    const second = await repository.requestBrowserSync("linkedin", "2026-07-19T10:00:05.000Z");
    expect(second.id).toBe(first.id);
  });

  it("claims the oldest pending request and marks it running", async () => {
    const first = await repository.requestBrowserSync("linkedin", "2026-07-19T10:00:00.000Z");

    const claimed = await repository.claimNextBrowserRequest("linkedin", "2026-07-19T10:00:10.000Z");
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).toBe("2026-07-19T10:00:10.000Z");

    // Nothing left to claim once the only request is running.
    const again = await repository.claimNextBrowserRequest("linkedin", "2026-07-19T10:00:12.000Z");
    expect(again).toBeNull();
  });

  it("returns null when there is nothing to claim", async () => {
    const claimed = await repository.claimNextBrowserRequest("linkedin", "2026-07-19T10:00:00.000Z");
    expect(claimed).toBeNull();
  });

  it("records completion with status, run id, and message", async () => {
    const request = await repository.requestBrowserSync("linkedin", "2026-07-19T10:00:00.000Z");
    await repository.claimNextBrowserRequest("linkedin", "2026-07-19T10:00:10.000Z");
    await repository.completeBrowserRequest(request.id, "done", "2026-07-19T10:01:00.000Z", {
      runId: "run-123",
      message: "2 nya · 3 uppdaterade",
    });

    const latest = await repository.getLatestBrowserRequest("linkedin");
    expect(latest?.status).toBe("done");
    expect(latest?.runId).toBe("run-123");
    expect(latest?.message).toBe("2 nya · 3 uppdaterade");
    expect(latest?.completedAt).toBe("2026-07-19T10:01:00.000Z");
  });

  it("reclaims a request stuck running for over 15 minutes", async () => {
    const request = await repository.requestBrowserSync("linkedin", "2026-07-19T10:00:00.000Z");
    // First worker claims it, then dies without completing.
    await repository.claimNextBrowserRequest("linkedin", "2026-07-19T10:00:10.000Z");

    // A second worker 20 minutes later must be able to reclaim the stale run.
    const reclaimed = await repository.claimNextBrowserRequest(
      "linkedin",
      "2026-07-19T10:20:10.000Z",
    );
    expect(reclaimed?.id).toBe(request.id);
    expect(reclaimed?.startedAt).toBe("2026-07-19T10:20:10.000Z");
  });

  it("does not reclaim a request that is running within the grace window", async () => {
    await repository.requestBrowserSync("linkedin", "2026-07-19T10:00:00.000Z");
    await repository.claimNextBrowserRequest("linkedin", "2026-07-19T10:00:10.000Z");

    // Only 5 minutes later — the first worker is presumably still going.
    const reclaimed = await repository.claimNextBrowserRequest(
      "linkedin",
      "2026-07-19T10:05:10.000Z",
    );
    expect(reclaimed).toBeNull();
  });
});
