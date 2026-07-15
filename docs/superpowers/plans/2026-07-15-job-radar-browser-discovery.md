# Job Radar Browser Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add zero-subscription, personal-only LinkedIn and Google browser discovery while preserving the existing strict matcher, partial-source behavior, SQLite schema, and localhost dashboard.

**Architecture:** Add one shared Playwright runtime with a dedicated persistent Chromium profile, then implement LinkedIn and Google as serial `JobConnector`s. Pure mapping and page-status functions stay independently testable; browser state lives in ignored JSON, and a bounded validator removes only jobs confirmed inactive.

**Tech Stack:** Next.js 16, TypeScript 6, Node.js 20+, Playwright 1.61.1, Vitest 4, SQLite through `better-sqlite3`.

---

## Scope and file map

This is one staged plan because LinkedIn and Google are independent connectors but share the same browser runtime, configuration, scheduling rules, and active-job validator. Each connector becomes testable before the next one is added.

**Create:**

- `lib/job-radar/browser/config.ts` — parses safe, hard-capped browser configuration.
- `lib/job-radar/browser/config.test.ts` — covers disabled/default/invalid configuration.
- `lib/job-radar/browser/state.ts` — atomically persists bootstrap and validation cursor state.
- `lib/job-radar/browser/state.test.ts` — covers missing, valid, corrupt, and failed writes.
- `lib/job-radar/browser/runtime.ts` — owns the persistent visible Chromium context and mutex.
- `lib/job-radar/browser/runtime.test.ts` — tests mutex and cleanup through a fake launcher.
- `lib/job-radar/browser/page-status.ts` — classifies login, challenge, active, inactive, and unknown pages.
- `lib/job-radar/browser/page-status.test.ts` — fixture-based page classification tests.
- `lib/job-radar/connectors/linkedin.ts` — pure LinkedIn mapping plus the Playwright connector.
- `lib/job-radar/connectors/linkedin.test.ts` — tests recency, mapping, login, block, and checkpoint behavior.
- `lib/job-radar/connectors/web-discovery.ts` — pure Google/public-page mapping plus the Playwright connector.
- `lib/job-radar/connectors/web-discovery.test.ts` — tests queries, URL filtering, JSON-LD, expiry, and CAPTCHA.
- `lib/job-radar/active-validation.ts` — validates a bounded rotating batch of browser-discovered jobs.
- `lib/job-radar/active-validation.test.ts` — tests deletion, preservation, cursor rotation, and source errors.
- `scripts/linkedin-login.ts` — launches the dedicated profile for explicit manual login.

**Modify:**

- `package.json` and `package-lock.json` — add the already approved Playwright dependency and login helper script.
- `.env.example` — document opt-in browser settings and hard caps.
- `README.md` — document risk, setup, manual login, scheduler limitations, and QA.
- `QA.md` — add the localhost browser-discovery QA flow.
- `lib/job-radar/types.ts` — add connector execution class and bounded validation repository methods; no table/schema changes.
- `lib/job-radar/connectors/index.ts` — register browser connectors only when explicitly enabled.
- `lib/job-radar/sync.ts` — run API connectors in parallel, browser connectors serially, then active validation.
- `lib/job-radar/sync.test.ts` — prove serial browser ordering and partial failure.
- `lib/job-radar/db.ts` — query validation candidates and delete by row ID using the existing table.
- `app/api/cron/sync/route.ts` — explicitly skip local browser connectors in hosted cron.
- `app/components/dashboard.tsx` — replace obsolete “NO LINKEDIN SCRAPING” and empty-state copy.

No migration and no new database column are permitted in this plan.

### Task 1: Safe configuration and approved dependency

**Files:**
- Create: `lib/job-radar/browser/config.ts`
- Create: `lib/job-radar/browser/config.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing configuration tests**

```ts
import { describe, expect, it } from "vitest";

import { getBrowserDiscoveryConfig } from "./config";

describe("getBrowserDiscoveryConfig", () => {
  it("keeps browser discovery disabled by default", () => {
    expect(getBrowserDiscoveryConfig({}, "/repo")).toMatchObject({
      enabled: false,
      profilePath: "/repo/.data/browser-profile",
      statePath: "/repo/.data/browser-state.json",
      linkedinSearchUrls: [],
    });
  });

  it("parses opt-in search URLs and conservative limits", () => {
    const config = getBrowserDiscoveryConfig(
      {
        JOB_RADAR_BROWSER_DISCOVERY: "1",
        LINKEDIN_SEARCH_URLS:
          "https://www.linkedin.com/jobs/search/?keywords=sales|https://www.linkedin.com/jobs/search/?keywords=marketing",
        LINKEDIN_BOOTSTRAP_MAX_RESULTS: "40",
        LINKEDIN_INCREMENTAL_MAX_RESULTS: "20",
        LINKEDIN_MAX_DETAILS: "15",
        GOOGLE_MAX_QUERIES: "4",
        GOOGLE_MAX_PAGES: "1",
      },
      "/repo",
    );

    expect(config).toMatchObject({
      enabled: true,
      linkedinSearchUrls: [
        "https://www.linkedin.com/jobs/search/?keywords=sales",
        "https://www.linkedin.com/jobs/search/?keywords=marketing",
      ],
      linkedinBootstrapMaxResults: 40,
      linkedinIncrementalMaxResults: 20,
      linkedinMaxDetails: 15,
      googleMaxQueries: 4,
      googleMaxPages: 1,
    });
  });

  it("rejects non-LinkedIn URLs and values above hard caps", () => {
    expect(() =>
      getBrowserDiscoveryConfig(
        {
          JOB_RADAR_BROWSER_DISCOVERY: "1",
          LINKEDIN_SEARCH_URLS: "https://example.com/jobs",
        },
        "/repo",
      ),
    ).toThrow("[job radar browser] LINKEDIN_SEARCH_URLS must contain only https://www.linkedin.com/jobs/search URLs");

    expect(() =>
      getBrowserDiscoveryConfig(
        {
          JOB_RADAR_BROWSER_DISCOVERY: "1",
          LINKEDIN_BOOTSTRAP_MAX_RESULTS: "201",
        },
        "/repo",
      ),
    ).toThrow("[job radar browser] LINKEDIN_BOOTSTRAP_MAX_RESULTS must be between 1 and 200");
  });
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `npm test -- lib/job-radar/browser/config.test.ts`

Expected: FAIL because `./config` does not exist.

- [ ] **Step 3: Implement the typed, hard-capped configuration**

```ts
import { resolve } from "node:path";

export interface BrowserDiscoveryConfig {
  enabled: boolean;
  profilePath: string;
  statePath: string;
  linkedinSearchUrls: string[];
  linkedinBootstrapMaxResults: number;
  linkedinIncrementalMaxResults: number;
  linkedinMaxDetails: number;
  googleMaxQueries: number;
  googleMaxPages: number;
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  hardMax: number,
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > hardMax) {
    throw new Error(`[job radar browser] ${name} must be between 1 and ${hardMax}`);
  }
  return value;
}

function isLinkedInSearchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.linkedin.com" && url.pathname.startsWith("/jobs/search");
  } catch {
    return false;
  }
}

function optionalPath(value: string | undefined, cwd: string, fallback: string): string {
  return value?.trim() ? resolve(value.trim()) : resolve(cwd, fallback);
}

export function getBrowserDiscoveryConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): BrowserDiscoveryConfig {
  const linkedinSearchUrls = (env.LINKEDIN_SEARCH_URLS ?? "")
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);

  if (linkedinSearchUrls.some((value) => !isLinkedInSearchUrl(value))) {
    throw new Error(
      "[job radar browser] LINKEDIN_SEARCH_URLS must contain only https://www.linkedin.com/jobs/search URLs",
    );
  }

  return {
    enabled: env.JOB_RADAR_BROWSER_DISCOVERY === "1",
    profilePath: optionalPath(env.JOB_RADAR_BROWSER_PROFILE_PATH, cwd, ".data/browser-profile"),
    statePath: optionalPath(env.JOB_RADAR_BROWSER_STATE_PATH, cwd, ".data/browser-state.json"),
    linkedinSearchUrls,
    linkedinBootstrapMaxResults: boundedInteger(env, "LINKEDIN_BOOTSTRAP_MAX_RESULTS", 200, 200),
    linkedinIncrementalMaxResults: boundedInteger(env, "LINKEDIN_INCREMENTAL_MAX_RESULTS", 100, 100),
    linkedinMaxDetails: boundedInteger(env, "LINKEDIN_MAX_DETAILS", 80, 80),
    googleMaxQueries: boundedInteger(env, "GOOGLE_MAX_QUERIES", 8, 8),
    googleMaxPages: boundedInteger(env, "GOOGLE_MAX_PAGES", 2, 2),
  };
}
```

- [ ] **Step 4: Run the configuration tests**

Run: `npm test -- lib/job-radar/browser/config.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Add Playwright and document the opt-in variables**

Run: `npm install playwright@1.61.1`

Add these exact entries to `.env.example`:

```dotenv
# Personal/local-only browser discovery. Opens a visible dedicated Chromium profile.
JOB_RADAR_BROWSER_DISCOVERY=0

# Pipe-separated LinkedIn Jobs search URLs. Required when browser discovery is enabled.
LINKEDIN_SEARCH_URLS=

# Optional hard-capped limits. Defaults shown below.
LINKEDIN_BOOTSTRAP_MAX_RESULTS=200
LINKEDIN_INCREMENTAL_MAX_RESULTS=100
LINKEDIN_MAX_DETAILS=80
GOOGLE_MAX_QUERIES=8
GOOGLE_MAX_PAGES=2

# Optional absolute paths. Defaults live under the already ignored .data directory.
JOB_RADAR_BROWSER_PROFILE_PATH=
JOB_RADAR_BROWSER_STATE_PATH=
```

- [ ] **Step 6: Verify dependency metadata and commit**

Run: `npm ls playwright && npm test -- lib/job-radar/browser/config.test.ts`

Expected: `playwright@1.61.1` and PASS.

```bash
git add package.json package-lock.json .env.example lib/job-radar/browser/config.ts lib/job-radar/browser/config.test.ts
git commit -m "feat: configure browser discovery"
```

### Task 2: Atomic checkpoint store

**Files:**
- Create: `lib/job-radar/browser/state.ts`
- Create: `lib/job-radar/browser/state.test.ts`

- [ ] **Step 1: Write failing state-store tests with a temporary directory**

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserStateStore, EMPTY_BROWSER_STATE } from "./state";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BrowserStateStore", () => {
  it("returns safe defaults when no state exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "job-radar-state-"));
    directories.push(directory);
    await expect(new BrowserStateStore(join(directory, "state.json")).load()).resolves.toEqual(EMPTY_BROWSER_STATE);
  });

  it("writes state atomically and reads it back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "job-radar-state-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const store = new BrowserStateStore(path);
    const state = {
      ...EMPTY_BROWSER_STATE,
      linkedinBootstrapCompleted: true,
      linkedinLastSuccessfulAt: "2026-07-15T08:00:00.000Z",
      validationCursor: "job-42",
    };
    await store.save(state);
    await expect(store.load()).resolves.toEqual(state);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
  });

  it("fails clearly for corrupt state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "job-radar-state-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    await writeFile(path, "not-json");
    await expect(new BrowserStateStore(path).load()).rejects.toThrow(
      "[job radar browser] Could not read browser state",
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm test -- lib/job-radar/browser/state.test.ts`

Expected: FAIL because `./state` does not exist.

- [ ] **Step 3: Implement atomic state loading and saving**

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface BrowserState {
  linkedinBootstrapCompleted: boolean;
  linkedinLastSuccessfulAt: string | null;
  googleLastSuccessfulAt: string | null;
  validationCursor: string | null;
}

export const EMPTY_BROWSER_STATE: BrowserState = {
  linkedinBootstrapCompleted: false,
  linkedinLastSuccessfulAt: null,
  googleLastSuccessfulAt: null,
  validationCursor: null,
};

function isBrowserState(value: unknown): value is BrowserState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.linkedinBootstrapCompleted === "boolean" &&
    (state.linkedinLastSuccessfulAt === null || typeof state.linkedinLastSuccessfulAt === "string") &&
    (state.googleLastSuccessfulAt === null || typeof state.googleLastSuccessfulAt === "string") &&
    (state.validationCursor === null || typeof state.validationCursor === "string")
  );
}

export class BrowserStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<BrowserState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isBrowserState(parsed)) throw new Error("invalid shape");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_BROWSER_STATE };
      throw new Error("[job radar browser] Could not read browser state", { cause: error });
    }
  }

  async save(state: BrowserState): Promise<void> {
    const temporaryPath = `${this.path}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.path);
    } catch (error) {
      throw new Error("[job radar browser] Could not save browser state", { cause: error });
    }
  }
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- lib/job-radar/browser/state.test.ts`

Expected: PASS, 3 tests.

```bash
git add lib/job-radar/browser/state.ts lib/job-radar/browser/state.test.ts
git commit -m "feat: persist browser discovery checkpoints"
```

### Task 3: Shared visible browser runtime and mutex

**Files:**
- Create: `lib/job-radar/browser/runtime.ts`
- Create: `lib/job-radar/browser/runtime.test.ts`

- [ ] **Step 1: Write failing mutex and cleanup tests**

Use a tiny launcher port so tests never start Chromium:

```ts
import { describe, expect, it, vi } from "vitest";

import { BrowserRuntime, type BrowserContextLike, type BrowserLauncher } from "./runtime";

describe("BrowserRuntime", () => {
  it("closes the context after success and failure", async () => {
    const close = vi.fn(async () => undefined);
    const context = { close } as BrowserContextLike;
    const launcher: BrowserLauncher = { launchPersistentContext: vi.fn(async () => context) };
    const runtime = new BrowserRuntime("/profile", launcher);

    await expect(runtime.run(async () => "done")).resolves.toBe("done");
    await expect(runtime.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("rejects overlapping browser runs", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const context = { close: vi.fn(async () => undefined) } as BrowserContextLike;
    const launcher: BrowserLauncher = { launchPersistentContext: vi.fn(async () => context) };
    const runtime = new BrowserRuntime("/profile", launcher);
    const first = runtime.run(async () => held);

    await expect(runtime.run(async () => undefined)).rejects.toThrow(
      "[job radar browser] Another browser discovery run is already active",
    );
    release();
    await first;
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm test -- lib/job-radar/browser/runtime.test.ts`

Expected: FAIL because `./runtime` does not exist.

- [ ] **Step 3: Implement one-context-at-a-time runtime**

```ts
import { chromium, type BrowserContext } from "playwright";

export type BrowserContextLike = Pick<BrowserContext, "close" | "newPage" | "pages">;

export interface BrowserLauncher {
  launchPersistentContext(
    profilePath: string,
    options: { headless: false; viewport: null },
  ): Promise<BrowserContextLike>;
}

const playwrightLauncher: BrowserLauncher = {
  launchPersistentContext: (profilePath, options) =>
    chromium.launchPersistentContext(profilePath, options),
};

let browserRunActive = false;

export class BrowserRuntime {
  constructor(
    private readonly profilePath: string,
    private readonly launcher: BrowserLauncher = playwrightLauncher,
  ) {}

  async run<T>(task: (context: BrowserContextLike) => Promise<T>): Promise<T> {
    if (browserRunActive) {
      throw new Error("[job radar browser] Another browser discovery run is already active");
    }
    browserRunActive = true;
    let context: BrowserContextLike | undefined;
    try {
      context = await this.launcher.launchPersistentContext(this.profilePath, {
        headless: false,
        viewport: null,
      });
      return await task(context);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("[job radar")) throw error;
      throw new Error("[job radar browser] Browser run failed", { cause: error });
    } finally {
      await context?.close();
      browserRunActive = false;
    }
  }
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- lib/job-radar/browser/runtime.test.ts`

Expected: PASS, 2 tests, without opening a browser.

```bash
git add lib/job-radar/browser/runtime.ts lib/job-radar/browser/runtime.test.ts
git commit -m "feat: add visible browser runtime"
```

### Task 4: Shared page-status classification

**Files:**
- Create: `lib/job-radar/browser/page-status.ts`
- Create: `lib/job-radar/browser/page-status.test.ts`

- [ ] **Step 1: Write failing page-status tests**

```ts
import { describe, expect, it } from "vitest";

import { classifyPageStatus } from "./page-status";

describe("classifyPageStatus", () => {
  it.each([
    [404, "Not found", "inactive"],
    [410, "Gone", "inactive"],
    [200, "This job is no longer available", "inactive"],
    [429, "Too many requests", "blocked"],
    [200, "Our systems have detected unusual traffic", "blocked"],
    [200, "Join LinkedIn or sign in", "login-required"],
    [200, "Apply now for this remote contract role", "active"],
    [200, "Welcome to our company", "unknown"],
  ] as const)("classifies %s %s", (status, text, expected) => {
    expect(classifyPageStatus({ status, url: "https://example.com/job", text })).toBe(expected);
  });

  it("marks past JSON-LD expiry inactive", () => {
    expect(
      classifyPageStatus({
        status: 200,
        url: "https://example.com/job",
        text: "Apply now",
        validThrough: "2026-07-14T23:59:59.000Z",
      }, new Date("2026-07-15T08:00:00.000Z")),
    ).toBe("inactive");
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm test -- lib/job-radar/browser/page-status.test.ts`

Expected: FAIL because `./page-status` does not exist.

- [ ] **Step 3: Implement conservative classification**

```ts
export type PageStatus = "active" | "inactive" | "blocked" | "login-required" | "unknown";

export interface PageSnapshot {
  status: number | null;
  url: string;
  text: string;
  validThrough?: string | null;
}

const INACTIVE = /\b(no longer available|job has expired|position has been filled|applications? (?:are|is) closed|job is closed)\b/i;
const BLOCKED = /\b(unusual traffic|captcha|security verification|too many requests|challenge)\b/i;
const LOGIN = /\b(join linkedin|sign in to linkedin|log in to linkedin)\b/i;
const ACTIVE = /\b(apply now|apply for this job|submit application|ansök|apply here)\b/i;

export function classifyPageStatus(snapshot: PageSnapshot, now = new Date()): PageStatus {
  if (snapshot.status === 404 || snapshot.status === 410 || INACTIVE.test(snapshot.text)) return "inactive";
  if (snapshot.status === 429 || BLOCKED.test(snapshot.text)) return "blocked";
  if (/linkedin\.com\/(login|checkpoint)/.test(snapshot.url) || LOGIN.test(snapshot.text)) return "login-required";
  if (snapshot.validThrough && Date.parse(snapshot.validThrough) < now.getTime()) return "inactive";
  return ACTIVE.test(snapshot.text) ? "active" : "unknown";
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- lib/job-radar/browser/page-status.test.ts`

Expected: PASS, 9 cases.

```bash
git add lib/job-radar/browser/page-status.ts lib/job-radar/browser/page-status.test.ts
git commit -m "feat: classify active and blocked job pages"
```

### Task 5: LinkedIn connector with seven-day bootstrap

**Files:**
- Create: `lib/job-radar/connectors/linkedin.ts`
- Create: `lib/job-radar/connectors/linkedin.test.ts`

- [ ] **Step 1: Define tests around a browser port, not live LinkedIn**

The test fixture is sanitized structured data returned by the production Playwright adapter:

```ts
import { describe, expect, it, vi } from "vitest";

import { LinkedInConnector, mapLinkedInJob, withLinkedInRecency } from "./linkedin";
import { BrowserStateStore, EMPTY_BROWSER_STATE } from "../browser/state";

const detail = {
  externalId: "42001",
  url: "https://www.linkedin.com/jobs/view/42001/",
  title: "Freelance Demand Generation Consultant",
  company: "Acme AB",
  location: "Remote - Europe",
  description: "Fully remote B2B consulting contract across EMEA.",
  employmentType: "Contract",
  postedAt: "2026-07-15T08:00:00.000Z",
};

describe("LinkedIn connector", () => {
  it("applies seven days before bootstrap and 24 hours afterward", () => {
    expect(withLinkedInRecency("https://www.linkedin.com/jobs/search/?keywords=sales", false)).toContain("f_TPR=r604800");
    expect(withLinkedInRecency("https://www.linkedin.com/jobs/search/?keywords=sales", true)).toContain("f_TPR=r86400");
  });

  it("maps a detail record to SourceJob", () => {
    expect(mapLinkedInJob(detail)).toMatchObject({
      source: "LinkedIn",
      externalId: "42001",
      remote: true,
      engagementType: "Contract",
      tags: ["Marketing"],
    });
  });

  it("advances bootstrap only after a successful bounded run", async () => {
    const state = { ...EMPTY_BROWSER_STATE };
    const store = {
      load: vi.fn(async () => state),
      save: vi.fn(async (next) => Object.assign(state, next)),
    } as unknown as BrowserStateStore;
    const browser = {
      ensureLogin: vi.fn(async () => undefined),
      collectJobUrls: vi.fn(async () => [detail.url]),
      readJob: vi.fn(async () => detail),
    };
    const connector = new LinkedInConnector(
      ["https://www.linkedin.com/jobs/search/?keywords=sales"],
      { bootstrapMaxResults: 10, incrementalMaxResults: 5, maxDetails: 5 },
      browser,
      store,
      () => new Date("2026-07-15T10:00:00.000Z"),
    );

    await expect(connector.fetchJobs()).resolves.toHaveLength(1);
    expect(state.linkedinBootstrapCompleted).toBe(true);
    expect(state.linkedinLastSuccessfulAt).toBe("2026-07-15T10:00:00.000Z");
  });

  it("does not advance state after login or challenge failure", async () => {
    const store = {
      load: vi.fn(async () => ({ ...EMPTY_BROWSER_STATE })),
      save: vi.fn(),
    } as unknown as BrowserStateStore;
    const browser = {
      ensureLogin: vi.fn(async () => { throw new Error("[job radar linkedin] LinkedIn login required"); }),
      collectJobUrls: vi.fn(),
      readJob: vi.fn(),
    };
    const connector = new LinkedInConnector([], { bootstrapMaxResults: 10, incrementalMaxResults: 5, maxDetails: 5 }, browser, store);
    await expect(connector.fetchJobs()).rejects.toThrow("[job radar linkedin] LinkedIn login required");
    expect(store.save).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm test -- lib/job-radar/connectors/linkedin.test.ts`

Expected: FAIL because `./linkedin` does not exist.

- [ ] **Step 3: Implement pure recency and mapping functions plus connector port**

The file must export these stable types for the fake and Playwright implementations:

```ts
import type { JobConnector, SourceJob } from "../types";
import type { BrowserStateStore } from "../browser/state";

export interface LinkedInDetail {
  externalId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  employmentType: string | null;
  postedAt: string | null;
}

export interface LinkedInBrowser {
  ensureLogin(): Promise<void>;
  collectJobUrls(searchUrl: string, limit: number): Promise<string[]>;
  readJob(url: string): Promise<LinkedInDetail>;
}

export function withLinkedInRecency(value: string, bootstrapCompleted: boolean): string {
  const url = new URL(value);
  url.searchParams.set("f_TPR", bootstrapCompleted ? "r86400" : "r604800");
  url.searchParams.set("f_WT", "2");
  return url.toString();
}

export function mapLinkedInJob(job: LinkedInDetail): SourceJob {
  const tags: string[] = [];
  if (/\b(sales|account executive|business development|revenue)\b/i.test(job.title)) tags.push("Sales");
  if (/\b(marketing|growth|demand generation|content|brand)\b/i.test(job.title)) tags.push("Marketing");
  return {
    source: "LinkedIn",
    externalId: job.externalId,
    sourceUrl: job.url,
    originalUrl: job.url,
    title: job.title,
    company: job.company,
    location: job.location,
    country: null,
    description: job.description,
    engagementType: job.employmentType,
    remote: /\bremote\b/i.test(`${job.location} ${job.description}`) ? true : null,
    tags,
    postedAt: job.postedAt,
  };
}
```

`LinkedInConnector` must set `readonly name = "LinkedIn"` and `readonly execution = "browser"`. It loads state, selects the hard-capped result limit, deduplicates URLs, reads no more than `maxDetails`, saves the successful timestamp only after all bounded work completes, and wraps unknown failures as `[job radar linkedin] LinkedIn discovery failed: <message>`.

- [ ] **Step 4: Implement the Playwright adapter inside the same focused file**

Use `BrowserRuntime.run()` and visible Playwright pages. The production adapter must:

```ts
const CARD_SELECTOR = "[data-job-id], .job-card-container, li.jobs-search-results__list-item";
const DESCRIPTION_SELECTOR = ".jobs-description-content__text, .jobs-description__content, .jobs-box__html-content";

// Login handoff: navigate to /feed, and when redirected to /login wait up to five
// minutes for the user to complete login manually in the visible window.
await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
if (/linkedin\.com\/(login|checkpoint)/.test(page.url())) {
  console.error("[job radar linkedin] LinkedIn login required in the visible Chromium window");
  await page.waitForURL((url) => url.hostname.endsWith("linkedin.com") && !/\/(login|checkpoint)/.test(url.pathname), {
    timeout: 300_000,
  });
}
```

After every navigation, collect visible body text and call `classifyPageStatus()`. Throw exact errors for `blocked` and `login-required`. Use fixed 1,500 ms pacing between detail navigations, never random delays, stealth, retries through another identity, or CAPTCHA handling.

- [ ] **Step 5: Run unit tests and typecheck**

Run: `npm test -- lib/job-radar/connectors/linkedin.test.ts && npx tsc --noEmit`

Expected: PASS and no TypeScript errors. No live browser opens because tests inject the fake port.

- [ ] **Step 6: Commit**

```bash
git add lib/job-radar/connectors/linkedin.ts lib/job-radar/connectors/linkedin.test.ts
git commit -m "feat: add personal LinkedIn connector"
```

### Task 6: Free Google web-discovery connector

**Files:**
- Create: `lib/job-radar/connectors/web-discovery.ts`
- Create: `lib/job-radar/connectors/web-discovery.test.ts`

- [ ] **Step 1: Write failing pure-mapping and connector tests**

```ts
import { describe, expect, it, vi } from "vitest";

import { buildWebQueries, mapPublicJobPage, WebDiscoveryConnector } from "./web-discovery";
import { EMPTY_BROWSER_STATE } from "../browser/state";

const activePage = {
  status: 200,
  url: "https://jobs.lever.co/acme/42",
  text: "Apply now. Fully remote freelance marketing contract across EMEA.",
  jsonLd: [{
    "@type": "JobPosting",
    title: "Freelance Growth Marketing Consultant",
    description: "Fully remote freelance marketing contract across EMEA.",
    datePosted: "2026-07-15",
    validThrough: "2026-08-15",
    employmentType: "CONTRACTOR",
    hiringOrganization: { name: "Acme" },
    jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: { name: "Europe" },
  }],
};

describe("web discovery", () => {
  it("builds no more than eight targeted queries", () => {
    const queries = buildWebQueries();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(8);
    expect(queries.join(" ")).toContain("site:jobs.lever.co");
  });

  it("maps active JobPosting JSON-LD", () => {
    expect(mapPublicJobPage(activePage, new Date("2026-07-15T10:00:00Z"))).toMatchObject({
      source: "Web discovery",
      company: "Acme",
      remote: true,
      engagementType: "CONTRACTOR",
      originalUrl: "https://jobs.lever.co/acme/42",
    });
  });

  it("rejects expired and non-job pages", () => {
    expect(mapPublicJobPage({ ...activePage, jsonLd: [{ ...activePage.jsonLd[0], validThrough: "2026-07-14" }] }, new Date("2026-07-15T10:00:00Z"))).toBeNull();
    expect(mapPublicJobPage({ status: 200, url: "https://example.com/about", text: "About us", jsonLd: [] })).toBeNull();
  });

  it("stops safely on Google CAPTCHA without advancing state", async () => {
    const store = { load: vi.fn(async () => ({ ...EMPTY_BROWSER_STATE })), save: vi.fn() };
    const browser = { search: vi.fn(async () => { throw new Error("[job radar google] Google blocked browser discovery with CAPTCHA"); }), readPublicJob: vi.fn() };
    const connector = new WebDiscoveryConnector(2, 1, browser, store as never);
    await expect(connector.fetchJobs()).rejects.toThrow("[job radar google] Google blocked browser discovery with CAPTCHA");
    expect(store.save).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm test -- lib/job-radar/connectors/web-discovery.test.ts`

Expected: FAIL because `./web-discovery` does not exist.

- [ ] **Step 3: Implement targeted queries and pure JSON-LD mapping**

Export these ports:

```ts
export interface PublicJobPage {
  status: number | null;
  url: string;
  text: string;
  jsonLd: Array<Record<string, unknown>>;
}

export interface WebDiscoveryBrowser {
  search(query: string, page: number): Promise<string[]>;
  readPublicJob(url: string): Promise<PublicJobPage>;
}
```

`buildWebQueries()` returns explicit sales and marketing variants for `site:jobs.lever.co`, `site:job-boards.greenhouse.io`, public employer career pages, and LinkedIn public job URLs. `mapPublicJobPage()` selects only `@type: "JobPosting"`, validates `validThrough` through `classifyPageStatus()`, derives a stable external ID from SHA-256 of the final URL, and returns `null` when title, company, location, or description is missing.

Reject result URLs whose hostname is Google, a generic search/list page, or an unsupported non-HTTP protocol before opening them. Follow redirects through Playwright and store the final employer/ATS URL.

- [ ] **Step 4: Implement the Playwright Google adapter**

Use the same `BrowserRuntime`, fixed 1,500 ms pacing, and at most `googleMaxQueries * googleMaxPages` result pages. Search with:

```ts
const url = new URL("https://www.google.com/search");
url.searchParams.set("q", query);
url.searchParams.set("filter", "0");
url.searchParams.set("start", String((pageNumber - 1) * 10));
```

After navigation, use `classifyPageStatus()` and throw `[job radar google] Google blocked browser discovery with CAPTCHA` for `blocked`. Collect only result anchors under `#search`, unwrap `/url?q=` links, deduplicate, and enforce all caps before visiting detail pages. Never retry a blocked query through a different identity.

- [ ] **Step 5: Run unit tests and typecheck**

Run: `npm test -- lib/job-radar/connectors/web-discovery.test.ts && npx tsc --noEmit`

Expected: PASS and no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add lib/job-radar/connectors/web-discovery.ts lib/job-radar/connectors/web-discovery.test.ts
git commit -m "feat: add free web job discovery"
```

### Task 7: Register and serialize browser connectors

**Files:**
- Modify: `lib/job-radar/types.ts:74-77`
- Modify: `lib/job-radar/connectors/index.ts:22-48`
- Modify: `lib/job-radar/sync.ts:11-73`
- Modify: `lib/job-radar/sync.test.ts`
- Modify: `app/api/cron/sync/route.ts:19`

- [ ] **Step 1: Add a failing orchestration test**

Append a test that records connector start/end events:

```ts
it("runs API connectors in parallel and browser connectors serially", async () => {
  const repository = new MemoryRepository();
  const events: string[] = [];
  const connector = (name: string, execution: "parallel" | "browser"): JobConnector => ({
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
    connectors: [connector("API", "parallel"), connector("LinkedIn", "browser"), connector("Web discovery", "browser")],
    repository,
    clock: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  expect(events.indexOf("LinkedIn:end")).toBeLessThan(events.indexOf("Web discovery:start"));
});
```

- [ ] **Step 2: Run the test and confirm it fails to serialize**

Run: `npm test -- lib/job-radar/sync.test.ts`

Expected: FAIL because `execution` is not part of `JobConnector` and all connectors use `Promise.all`.

- [ ] **Step 3: Add execution metadata and a small fetch helper**

Change `JobConnector` to:

```ts
export interface JobConnector {
  name: string;
  execution?: "parallel" | "browser";
  fetchJobs(): Promise<SourceJob[]>;
}
```

In `sync.ts`, extract the existing try/catch to `fetchSource(connector)`, then run:

```ts
const parallelConnectors = configured.connectors.filter((connector) => connector.execution !== "browser");
const browserConnectors = configured.connectors.filter((connector) => connector.execution === "browser");
const fetchedSources = await Promise.all(parallelConnectors.map(fetchSource));
for (const connector of browserConnectors) {
  fetchedSources.push(await fetchSource(connector));
}
```

Preserve the existing source error text, logging, matching, deduplication, and summary behavior.

- [ ] **Step 4: Register browser connectors only under explicit opt-in**

In `getConnectorConfiguration()`:

```ts
const browserConfig = getBrowserDiscoveryConfig(env);
if (!browserConfig.enabled) {
  skippedSources.push("LinkedIn · browser discovery disabled");
  skippedSources.push("Web discovery · browser discovery disabled");
} else if (browserConfig.linkedinSearchUrls.length === 0) {
  skippedSources.push("LinkedIn · missing LINKEDIN_SEARCH_URLS");
  skippedSources.push("Web discovery · requires configured browser discovery");
} else {
  const state = new BrowserStateStore(browserConfig.statePath);
  const runtime = new BrowserRuntime(browserConfig.profilePath);
  connectors.push(createLinkedInConnector(browserConfig, runtime, state));
  connectors.push(createWebDiscoveryConnector(browserConfig, runtime, state));
}
```

Factory functions keep Playwright construction out of configuration parsing and use the same profile path, while serial sync execution prevents overlap.

- [ ] **Step 5: Skip browser work explicitly in hosted cron**

Add `browserDiscovery?: boolean` to `SyncOptions`. When it is `false`, filter out connectors whose execution is `browser`, append skipped-source messages for LinkedIn and Web discovery, and do not run active validation. Change the cron route to:

```ts
const summary = await syncJobs({ browserDiscovery: false });
```

Add a sync test whose browser connector throws if called; invoke `syncJobs({ browserDiscovery: false, ... })` and assert it was not called and its source result is `skipped`. Manual UI, CLI, and scheduler calls keep the default `true` behavior.

- [ ] **Step 6: Run connector, sync, and route type checks**

Run: `npm test -- lib/job-radar/sync.test.ts lib/job-radar/connectors && npx tsc --noEmit`

Expected: PASS; browser tests use fakes, hosted cron skips them, and no Chromium opens.

- [ ] **Step 7: Commit**

```bash
git add lib/job-radar/types.ts lib/job-radar/connectors/index.ts lib/job-radar/sync.ts lib/job-radar/sync.test.ts app/api/cron/sync/route.ts
git commit -m "feat: serialize browser job connectors"
```

### Task 8: Bounded active-job validation without a schema change

**Files:**
- Create: `lib/job-radar/active-validation.ts`
- Create: `lib/job-radar/active-validation.test.ts`
- Modify: `lib/job-radar/types.ts:79-85`
- Modify: `lib/job-radar/connectors/index.ts`
- Modify: `lib/job-radar/db.ts:228-280`
- Modify: `lib/job-radar/sync.ts`
- Modify: `lib/job-radar/sync.test.ts`

- [ ] **Step 1: Write failing repository/validation service tests**

Extend `JobRepository` fakes and add tests for these exact outcomes:

```ts
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
```

Add a SQLite test using a temporary database that proves `listJobsForValidation(["LinkedIn", "Web discovery"], null, 50)` excludes JobTech and returns rows in `id` order, and `deleteJobById()` removes only the requested row.

- [ ] **Step 2: Run focused tests and confirm missing APIs**

Run: `npm test -- lib/job-radar/active-validation.test.ts`

Expected: FAIL because the service and repository methods do not exist.

- [ ] **Step 3: Add repository methods without changing table creation SQL**

Extend `JobRepository` with:

```ts
listJobsForValidation(sources: string[], afterId: string | null, limit: number): StoredJob[];
deleteJobById(id: string): void;
```

Implement with dynamic source placeholders, `id > ?` when a cursor exists, `ORDER BY id ASC LIMIT ?`, and existing `mapJobRow()`. Do not add or alter any database column.

- [ ] **Step 4: Implement the bounded rotating validator**

```ts
export interface ActiveValidationResult {
  checked: number;
  deleted: number;
  unknown: number;
}

export async function validateActiveJobs(
  repository: JobRepository,
  stateStore: BrowserStateStore,
  loadPage: (url: string) => Promise<PageSnapshot>,
  limit = 50,
): Promise<ActiveValidationResult> {
  const state = await stateStore.load();
  let jobs = repository.listJobsForValidation(["LinkedIn", "Web discovery"], state.validationCursor, limit);
  if (jobs.length === 0 && state.validationCursor) {
    jobs = repository.listJobsForValidation(["LinkedIn", "Web discovery"], null, limit);
  }
  let deleted = 0;
  let unknown = 0;
  for (const job of jobs) {
    try {
      const status = classifyPageStatus(await loadPage(job.originalUrl));
      if (status === "inactive") {
        repository.deleteJobById(job.id);
        deleted += 1;
      } else if (status !== "active") {
        unknown += 1;
      }
    } catch (error) {
      unknown += 1;
      console.error(`[job radar browser] Active validation preserved ${job.id} after an ambiguous failure`, error);
    }
  }
  await stateStore.save({ ...state, validationCursor: jobs.at(-1)?.id ?? null });
  return { checked: jobs.length, deleted, unknown };
}
```

- [ ] **Step 5: Integrate validation after upserts**

Add this optional callback to the connector configuration and `SyncOptions`:

```ts
export type ActiveValidator = (repository: JobRepository) => Promise<ActiveValidationResult>;
```

When browser discovery is enabled, `getConnectorConfiguration()` creates one production callback that opens `BrowserRuntime.run()` once for the entire batch, reuses one page, navigates to each stored URL with fixed 1,500 ms pacing, and returns `PageSnapshot` values to `validateActiveJobs()`. The callback is absent when browser discovery is disabled or hosted cron passes `browserDiscovery: false`.

After upserts, `syncJobs()` invokes the configured or injected callback and appends:

```ts
sourceResults.push({
  source: "Active validation",
  status: "success",
  fetched: result.checked,
  accepted: result.checked - result.deleted,
  rejected: result.deleted,
  message: `${result.deleted} inactive jobs removed; ${result.unknown} ambiguous jobs preserved`,
});
```

An unexpected validator failure instead appends a failed source result, adds `[job radar browser] Active validation failed: <message>` to `sourceErrors`, and makes the run partial while preserving rows. Calculate final sync status from all non-skipped `sourceResults`, not only the original fetched connector array.

Do not delete a row for timeout, CAPTCHA, 429, login-required, parser uncertainty, or network failure.

- [ ] **Step 6: Run repository, validation, and sync tests**

Run: `npm test -- lib/job-radar/active-validation.test.ts lib/job-radar/sync.test.ts && npx tsc --noEmit`

Expected: PASS and no schema migration in the diff.

- [ ] **Step 7: Commit**

```bash
git add lib/job-radar/active-validation.ts lib/job-radar/active-validation.test.ts lib/job-radar/types.ts lib/job-radar/connectors/index.ts lib/job-radar/db.ts lib/job-radar/sync.ts lib/job-radar/sync.test.ts
git commit -m "feat: remove confirmed inactive browser jobs"
```

### Task 9: Manual login helper and demo-ready dashboard copy

**Files:**
- Create: `scripts/linkedin-login.ts`
- Modify: `package.json`
- Modify: `app/components/dashboard.tsx:282-307`

- [ ] **Step 1: Add the explicit manual login helper**

```ts
import { loadEnvConfig } from "@next/env";

import { getBrowserDiscoveryConfig } from "../lib/job-radar/browser/config";
import { BrowserRuntime } from "../lib/job-radar/browser/runtime";

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const config = getBrowserDiscoveryConfig();
  const runtime = new BrowserRuntime(config.profilePath);
  await runtime.run(async (context) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    console.log("[job radar linkedin] Complete login in Chromium, then return here and press Enter.");
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  });
}

main().catch((error) => {
  console.error("[job radar linkedin] Login setup failed", error);
  process.exitCode = 1;
});
```

Add `"linkedin:login": "tsx scripts/linkedin-login.ts"` under package scripts.

- [ ] **Step 2: Update only obsolete UI copy**

Replace the empty-state source sentence with:

```tsx
"Kör den första sökningen. JobTech och Arbeitnow fungerar direkt; lokal LinkedIn- och webbsökning aktiveras uttryckligen via miljövariabler."
```

Replace footer `NO LINKEDIN SCRAPING` with `PERSONAL BROWSER DISCOVERY`. Do not change layout, controls, or CSS.

- [ ] **Step 3: Verify UI compile and commit**

Run: `npx tsc --noEmit && npm run lint`

Expected: PASS.

```bash
git add scripts/linkedin-login.ts package.json app/components/dashboard.tsx
git commit -m "feat: add LinkedIn login setup"
```

### Task 10: Documentation, full verification, and localhost QA

**Files:**
- Modify: `README.md`
- Modify: `QA.md`

- [ ] **Step 1: Document exact local setup and risk boundary**

Add these commands and expected behavior to `README.md`:

```bash
npx playwright install chromium
cp .env.example .env.local
npm run linkedin:login
npm run dev
```

Document that `.env.local` must set `JOB_RADAR_BROWSER_DISCOVERY=1` and pipe-separated LinkedIn saved-search URLs. State plainly that LinkedIn and Google may block automation, no CAPTCHA/access-control bypass exists, runs require an awake logged-in Mac, browser discovery is skipped in hosted cron, and it is not suitable as a commercial data source.

- [ ] **Step 2: Add a 7-step QA script to `QA.md`**

```markdown
1. Set `JOB_RADAR_BROWSER_DISCOVERY=1`, one LinkedIn search URL, and low limits (`10`, `5`, `5`, `1`, `1`) in `.env.local`.
2. Run `npm run linkedin:login`, sign in manually in the dedicated Chromium window, return to Terminal, and press Enter.
3. Run `npm run dev`, open `http://localhost:3000`, and click **Kör sökning nu**.
4. Confirm the first successful LinkedIn source result uses the seven-day bootstrap and any accepted card says `Via LinkedIn` or `Via Web discovery`.
5. Open one result and confirm it reaches the original active job page; test dashboard search and source filters.
6. Run sync again and confirm the LinkedIn connector uses the 24-hour window. If Google shows CAPTCHA, confirm the run is partial and existing jobs remain.
7. Run `npm run scheduler` only after manual QA, keep the Mac awake, and confirm the next 08:00/16:00 Stockholm calculation in Terminal.
```

- [ ] **Step 3: Run the complete automated verification suite**

Run:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all Vitest tests pass, TypeScript exits 0, ESLint exits 0, and Next.js production build completes.

- [ ] **Step 4: Inspect scope and generated files before committing**

Run:

```bash
git status --short
git diff --check
git diff --stat
git diff -- package.json package-lock.json .env.example README.md QA.md app/components/dashboard.tsx lib/job-radar scripts
```

Expected: only planned files are changed. Do not stage the pre-existing generated `next-env.d.ts` modification; Next may rewrite it during dev/build.

- [ ] **Step 5: Commit documentation and any verification-only fixes**

```bash
git add README.md QA.md
git commit -m "docs: explain personal browser discovery"
```

If verification required a minimal source/test fix, stage that exact file with a separate `fix:` commit after rerunning the failing command and the full suite.

## Final implementation handoff

When all tasks are complete, report the implementation as one git diff summary per changed file, followed by the 3–7 step QA script required by `AGENTS.md`. Include explicit confirmation that:

- no SQLite schema changed;
- browser credentials and profile data remain under ignored local paths;
- no CAPTCHA, rate-limit, or access-control bypass was added;
- `npm test`, `npx tsc --noEmit`, `npm run lint`, and `npm run build` pass; and
- the localhost UI remains the primary test surface.
