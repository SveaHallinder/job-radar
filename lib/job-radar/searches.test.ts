import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { PostgresJobRepository, type SqlExecutor } from "./db";
import {
  DEFAULT_SEARCH_KEYWORDS,
  buildLinkedInSearchUrl,
  keywordsFromSearches,
} from "./searches";
import { CREATE_JOBS, CREATE_SEARCHES, CREATE_SYNC_RUNS } from "./schema";
import type { SearchSpec } from "./types";

function spec(overrides: Partial<SearchSpec> = {}): SearchSpec {
  return { keywords: "sales", location: "", remoteOnly: true, ...overrides };
}

describe("keywordsFromSearches", () => {
  it("falls back to the defaults when nothing is configured", () => {
    expect(keywordsFromSearches(undefined)).toEqual(DEFAULT_SEARCH_KEYWORDS);
    expect(keywordsFromSearches([])).toEqual(DEFAULT_SEARCH_KEYWORDS);
  });

  it("uses configured keywords and de-duplicates them", () => {
    const result = keywordsFromSearches([
      spec({ keywords: "account executive" }),
      spec({ keywords: "account executive" }),
      spec({ keywords: "growth marketer" }),
    ]);
    expect(result).toEqual(["account executive", "growth marketer"]);
  });

  it("ignores blank keywords", () => {
    expect(keywordsFromSearches([spec({ keywords: "   " })])).toEqual(
      DEFAULT_SEARCH_KEYWORDS,
    );
  });
});

describe("buildLinkedInSearchUrl", () => {
  it("builds a valid LinkedIn jobs search URL with keywords, location and remote", () => {
    const url = new URL(
      buildLinkedInSearchUrl(spec({ keywords: "account executive", location: "Sverige" })),
    );
    expect(url.origin).toBe("https://www.linkedin.com");
    expect(url.pathname).toBe("/jobs/search/");
    expect(url.searchParams.get("keywords")).toBe("account executive");
    expect(url.searchParams.get("location")).toBe("Sverige");
    expect(url.searchParams.get("f_WT")).toBe("2");
  });

  it("omits location and remote filter when not requested", () => {
    const url = new URL(buildLinkedInSearchUrl(spec({ location: "", remoteOnly: false })));
    expect(url.searchParams.has("location")).toBe(false);
    expect(url.searchParams.has("f_WT")).toBe(false);
  });
});

describe("PostgresJobRepository searches", () => {
  let repository: PostgresJobRepository;

  beforeEach(async () => {
    const db = new PGlite();
    await db.query(CREATE_JOBS);
    await db.query(CREATE_SYNC_RUNS);
    await db.query(CREATE_SEARCHES);
    const exec: SqlExecutor = {
      query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
        (await db.query<T>(text, params ?? [])).rows,
    };
    repository = new PostgresJobRepository(exec);
  });

  it("adds, lists (oldest first), and deletes searches", async () => {
    const first = await repository.addSearch(
      spec({ keywords: "sales", location: "Sverige" }),
      "2026-07-19T10:00:00.000Z",
    );
    await repository.addSearch(
      spec({ keywords: "marketing", remoteOnly: false }),
      "2026-07-19T10:00:05.000Z",
    );

    let all = await repository.listSearches();
    expect(all.map((s) => s.keywords)).toEqual(["sales", "marketing"]);
    expect(all[0]).toMatchObject({ keywords: "sales", location: "Sverige", remoteOnly: true });
    expect(all[1]).toMatchObject({ keywords: "marketing", remoteOnly: false });

    await repository.deleteSearch(first.id);
    all = await repository.listSearches();
    expect(all.map((s) => s.keywords)).toEqual(["marketing"]);
  });

  it("trims keywords and location on insert", async () => {
    await repository.addSearch(
      spec({ keywords: "  growth  ", location: "  Berlin  " }),
      "2026-07-19T10:00:00.000Z",
    );
    const [saved] = await repository.listSearches();
    expect(saved.keywords).toBe("growth");
    expect(saved.location).toBe("Berlin");
  });
});
