import { describe, expect, it, vi } from "vitest";

import type { BrowserDiscoveryConfig } from "../browser/config";
import {
  BrowserRuntime,
  type BrowserContextLike,
  type BrowserLauncher,
} from "../browser/runtime";
import {
  EMPTY_BROWSER_STATE,
  type BrowserState,
} from "../browser/state";
import {
  LinkedInConnector,
  PlaywrightLinkedInBrowserPort,
  extractLinkedInDescription,
  mapLinkedInJob,
  parseLinkedInTitle,
  withLinkedInRecency,
  type LinkedInBrowserPort,
  type LinkedInBrowserSession,
  type LinkedInDetail,
  type LinkedInJobReference,
  type LinkedInLocatorPort,
  type LinkedInPagePort,
  type LinkedInStatePort,
} from "./linkedin";

describe("withLinkedInRecency", () => {
  it.each([
    [false, "r604800"],
    [true, "r86400"],
  ])("sets remote recency for bootstrapCompleted=%s", (bootstrapCompleted, recency) => {
    const result = new URL(
      withLinkedInRecency(
        "https://www.linkedin.com/jobs/search/?keywords=growth&geoId=105117694&f_TPR=old",
        bootstrapCompleted,
      ),
    );

    expect(result.searchParams.get("f_TPR")).toBe(recency);
    expect(result.searchParams.get("f_WT")).toBe("2");
    expect(result.searchParams.get("keywords")).toBe("growth");
    expect(result.searchParams.get("geoId")).toBe("105117694");
  });
});

describe("parseLinkedInTitle", () => {
  it("splits the stable title/company/LinkedIn page title", () => {
    expect(parseLinkedInTitle("Sales Manager | SciPro | LinkedIn")).toEqual({
      title: "Sales Manager",
      company: "SciPro",
    });
  });

  it("keeps the last segment as company when a title contains a pipe", () => {
    expect(
      parseLinkedInTitle("Growth | Marketing Lead | Northstar AB | LinkedIn"),
    ).toEqual({ title: "Growth", company: "Northstar AB" });
  });

  it.each(["", "LinkedIn", "Just a title", "   |   | LinkedIn"])(
    "returns null for the unparseable title %j",
    (value) => {
      expect(parseLinkedInTitle(value)).toBeNull();
    },
  );
});

describe("extractLinkedInDescription", () => {
  it("anchors on the About the job heading", () => {
    expect(
      extractLinkedInDescription("Apply now\nAbout the job\nRemote contract role."),
    ).toBe("Remote contract role.");
  });

  it("supports the Swedish heading", () => {
    expect(extractLinkedInDescription("Om jobbet\nDistansuppdrag på konsultbasis.")).toBe(
      "Distansuppdrag på konsultbasis.",
    );
  });

  it("returns an empty string when no heading is present", () => {
    expect(extractLinkedInDescription("Loading job")).toBe("");
  });
});

describe("mapLinkedInJob", () => {
  const baseDetail: LinkedInDetail = {
    externalId: null,
    url: "https://www.linkedin.com/jobs/view/9876543210/",
    title: "Independent Sales Lead",
    company: "Acme AB",
    location: "Remote, Sweden",
    description: "Contract role serving European customers.",
    employmentType: "Contract",
    postedAt: "2026-07-15T08:00:00.000Z",
  };

  it("maps stable LinkedIn source fields and derives Sales from the title", () => {
    expect(mapLinkedInJob(baseDetail)).toEqual({
      source: "LinkedIn",
      externalId: "9876543210",
      sourceUrl: baseDetail.url,
      originalUrl: baseDetail.url,
      title: "Independent Sales Lead",
      company: "Acme AB",
      location: "Remote, Sweden",
      country: null,
      description: "Contract role serving European customers.",
      engagementType: "Contract",
      remote: true,
      tags: ["Sales"],
      postedAt: "2026-07-15T08:00:00.000Z",
    });
  });

  it.each([
    ["Growth Marketing Manager", ["Marketing"]],
    ["Sales and Marketing Director", ["Sales", "Marketing"]],
    ["TypeScript Engineer", []],
  ])("derives only matching title tags for %s", (title, tags) => {
    expect(mapLinkedInJob({ ...baseDetail, title }).tags).toEqual(tags);
  });

  it("prefers the supplied stable external ID", () => {
    expect(mapLinkedInJob({ ...baseDetail, externalId: "detail-42" }).externalId).toBe(
      "detail-42",
    );
  });

  it("does not infer remote or Sales from ambiguous commercial prose", () => {
    expect(
      mapLinkedInJob({
        ...baseDetail,
        title: "Commercial Counsel",
        location: "London, United Kingdom",
        description: "Advise on commercial agreements and regulation.",
      }),
    ).toMatchObject({ remote: null, tags: [] });
  });

  it.each([
    ["not a remote position", "This is not a remote position."],
    ["not fully remote", "This role is not fully remote."],
    ["hybrid", "Hybrid role with remote working days."],
    ["on-site", "Remote-friendly but on-site three days per week."],
  ])("rejects %s as positive remote evidence", (_case, description) => {
    expect(
      mapLinkedInJob({
        ...baseDetail,
        location: "Stockholm, Sweden",
        description,
      }).remote,
    ).toBeNull();
  });
});

class MemoryStatePort implements LinkedInStatePort {
  readonly saved: BrowserState[] = [];

  constructor(public state: BrowserState = { ...EMPTY_BROWSER_STATE }) {}

  async load(): Promise<BrowserState> {
    return { ...this.state };
  }

  async save(state: BrowserState): Promise<void> {
    this.state = { ...state };
    this.saved.push({ ...state });
  }
}

class FakeLinkedInSession implements LinkedInBrowserSession {
  readonly searchCalls: Array<{ url: string; limit: number }> = [];
  readonly detailCalls: LinkedInJobReference[] = [];
  ensureCalls = 0;
  ensureError?: unknown;
  searchError?: unknown;
  detailError?: unknown;
  searchResults = new Map<string, LinkedInJobReference[]>();
  details = new Map<string, LinkedInDetail | null>();

  async ensureAuthenticated(): Promise<void> {
    this.ensureCalls += 1;
    if (this.ensureError) throw this.ensureError;
  }

  async search(url: string, limit: number): Promise<LinkedInJobReference[]> {
    this.searchCalls.push({ url, limit });
    if (this.searchError) throw this.searchError;
    const keywords = new URL(url).searchParams.get("keywords") || "";
    return (this.searchResults.get(keywords) || []).slice(0, limit);
  }

  async detail(reference: LinkedInJobReference): Promise<LinkedInDetail | null> {
    this.detailCalls.push(reference);
    if (this.detailError) throw this.detailError;
    return this.details.get(reference.url) ?? detailFor(reference);
  }
}

class FakeLinkedInBrowserPort implements LinkedInBrowserPort {
  runCalls = 0;

  constructor(readonly session: FakeLinkedInSession) {}

  async run<T>(task: (session: LinkedInBrowserSession) => Promise<T>): Promise<T> {
    this.runCalls += 1;
    return task(this.session);
  }
}

function reference(id: string): LinkedInJobReference {
  return {
    externalId: id,
    url: `https://www.linkedin.com/jobs/view/${id}/`,
  };
}

function detailFor(job: LinkedInJobReference): LinkedInDetail {
  return {
    externalId: job.externalId,
    url: job.url,
    title: `Sales Lead ${job.externalId || ""}`.trim(),
    company: "Acme AB",
    location: "Remote, Sweden",
    description: "Contract role.",
    employmentType: "Contract",
    postedAt: "2026-07-15T08:00:00.000Z",
  };
}

function connectorConfig(
  overrides: Partial<BrowserDiscoveryConfig> = {},
): BrowserDiscoveryConfig {
  return {
    enabled: true,
    profilePath: "/tmp/linkedin-profile",
    statePath: "/tmp/linkedin-state.json",
    linkedinSearchUrls: [
      "https://www.linkedin.com/jobs/search/?keywords=sales",
      "https://www.linkedin.com/jobs/search/?keywords=marketing",
    ],
    linkedinBootstrapMaxResults: 4,
    linkedinIncrementalMaxResults: 2,
    linkedinMaxDetails: 4,
    googleMaxQueries: 8,
    googleMaxPages: 2,
    ...overrides,
  };
}

function createConnector(options: {
  config?: Partial<BrowserDiscoveryConfig>;
  state?: BrowserState;
  clock?: Date;
}) {
  const session = new FakeLinkedInSession();
  const browser = new FakeLinkedInBrowserPort(session);
  const state = new MemoryStatePort(options.state);
  const connector = new LinkedInConnector(
    connectorConfig(options.config),
    state,
    browser,
    () => options.clock || new Date("2026-07-15T10:00:00.000Z"),
  );
  return { browser, connector, session, state };
}

describe("LinkedInConnector", () => {
  it("uses the bootstrap cap across searches in one browser session", async () => {
    const { browser, connector, session } = createConnector({
      config: { linkedinBootstrapMaxResults: 3, linkedinMaxDetails: 10 },
    });
    session.searchResults.set("sales", [
      reference("1"),
      reference("2"),
      reference("3"),
      reference("4"),
    ]);
    session.searchResults.set("marketing", [reference("5")]);

    const jobs = await connector.fetchJobs();

    expect(jobs.map((job) => job.externalId)).toEqual(["1", "2", "3"]);
    expect(session.searchCalls).toHaveLength(1);
    expect(session.searchCalls[0]?.limit).toBe(3);
    expect(session.ensureCalls).toBe(1);
    expect(browser.runCalls).toBe(1);
  });

  it("uses the incremental cap after bootstrap", async () => {
    const { connector, session } = createConnector({
      config: { linkedinIncrementalMaxResults: 2, linkedinMaxDetails: 10 },
      state: {
        ...EMPTY_BROWSER_STATE,
        linkedinBootstrapCompleted: true,
      },
    });
    session.searchResults.set("sales", [
      reference("1"),
      reference("2"),
      reference("3"),
    ]);

    const jobs = await connector.fetchJobs();

    expect(jobs.map((job) => job.externalId)).toEqual(["1", "2"]);
    expect(new URL(session.searchCalls[0]!.url).searchParams.get("f_TPR")).toBe(
      "r86400",
    );
  });

  it("deduplicates globally across saved searches", async () => {
    const { connector, session } = createConnector({
      config: { linkedinBootstrapMaxResults: 10, linkedinMaxDetails: 10 },
    });
    session.searchResults.set("sales", [reference("1"), reference("2")]);
    session.searchResults.set("marketing", [reference("2"), reference("3")]);

    const jobs = await connector.fetchJobs();

    expect(jobs.map((job) => job.externalId)).toEqual(["1", "2", "3"]);
    expect(session.detailCalls.map((job) => job.externalId)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("scans bounded extra results to fill the cap after cross-search duplicates", async () => {
    const { connector, session } = createConnector({
      config: { linkedinBootstrapMaxResults: 3, linkedinMaxDetails: 3 },
    });
    session.searchResults.set("sales", [reference("1"), reference("2")]);
    session.searchResults.set("marketing", [
      reference("1"),
      reference("2"),
      reference("3"),
    ]);

    const jobs = await connector.fetchJobs();

    expect(jobs.map((job) => job.externalId)).toEqual(["1", "2", "3"]);
  });

  it("never fetches more than maxDetails", async () => {
    const { connector, session } = createConnector({
      config: { linkedinBootstrapMaxResults: 5, linkedinMaxDetails: 2 },
    });
    session.searchResults.set("sales", [
      reference("1"),
      reference("2"),
      reference("3"),
    ]);

    const jobs = await connector.fetchJobs();

    expect(jobs).toHaveLength(2);
    expect(session.detailCalls).toHaveLength(2);
  });

  it("merges and advances state only after a successful bounded run", async () => {
    const initialState: BrowserState = {
      ...EMPTY_BROWSER_STATE,
      googleLastSuccessfulAt: "2026-07-14T10:00:00.000Z",
      validationCursor: "google:42",
    };
    const clock = new Date("2026-07-15T12:34:56.000Z");
    const { connector, session, state } = createConnector({
      clock,
      state: initialState,
    });
    session.searchResults.set("sales", [reference("1")]);

    await connector.fetchJobs();

    expect(state.saved).toEqual([
      {
        ...initialState,
        linkedinBootstrapCompleted: true,
        linkedinLastSuccessfulAt: clock.toISOString(),
      },
    ]);
  });

  it("advances state after a successful empty result", async () => {
    const { connector, state } = createConnector({});

    await expect(connector.fetchJobs()).resolves.toEqual([]);
    expect(state.saved[0]).toMatchObject({
      linkedinBootstrapCompleted: true,
      linkedinLastSuccessfulAt: "2026-07-15T10:00:00.000Z",
    });
  });

  it.each([
    ["login", new Error("[job radar linkedin] LinkedIn login required"), "ensure"],
    [
      "blocked",
      new Error("[job radar linkedin] LinkedIn blocked browser discovery"),
      "search",
    ],
    ["detail parser", new Error("detail parser failed"), "detail"],
  ] as const)("does not advance state after a %s failure", async (_case, error, step) => {
    const { connector, session, state } = createConnector({});
    session.searchResults.set("sales", [reference("1")]);
    if (step === "ensure") session.ensureError = error;
    if (step === "search") session.searchError = error;
    if (step === "detail") session.detailError = error;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(connector.fetchJobs()).rejects.toThrow();
    } finally {
      errorLog.mockRestore();
    }
    expect(state.saved).toEqual([]);
  });

  it("preserves prefixed failures", async () => {
    const { connector, session } = createConnector({});
    const blocked = new Error(
      "[job radar linkedin] LinkedIn blocked browser discovery",
    );
    session.ensureError = blocked;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(connector.fetchJobs()).rejects.toBe(blocked);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("wraps unknown failures with their cause and a prefixed log", async () => {
    const { connector, session } = createConnector({});
    const cause = new TypeError("card parser exploded");
    session.searchError = cause;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(connector.fetchJobs()).rejects.toEqual(
      expect.objectContaining({
        message:
          "[job radar linkedin] LinkedIn discovery failed: card parser exploded",
        cause,
      }),
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringMatching(/^\[job radar linkedin\]/),
      expect.any(Error),
    );
    errorLog.mockRestore();
  });
});

interface FakeDomNode {
  text?: string;
  attributes?: Record<string, string>;
  children?: Record<string, FakeDomNode[]>;
  attributeError?: Error;
  textError?: Error;
}

class FakeLocator implements LinkedInLocatorPort {
  constructor(private readonly nodes: FakeDomNode[]) {}

  async count(): Promise<number> {
    return this.nodes.length;
  }

  nth(index: number): LinkedInLocatorPort {
    return new FakeLocator(this.nodes[index] ? [this.nodes[index]] : []);
  }

  first(): LinkedInLocatorPort {
    return this.nth(0);
  }

  locator(selector: string): LinkedInLocatorPort {
    return new FakeLocator(
      this.nodes.flatMap((node) => node.children?.[selector] || []),
    );
  }

  async getAttribute(name: string): Promise<string | null> {
    if (!this.nodes[0]) throw new Error("Fake locator has no matching node");
    if (this.nodes[0].attributeError) throw this.nodes[0].attributeError;
    return this.nodes[0]?.attributes?.[name] || null;
  }

  async innerText(): Promise<string> {
    if (this.nodes[0]?.textError) throw this.nodes[0].textError;
    const text = this.nodes[0]?.text;
    if (text === undefined) throw new Error("Fake locator has no text");
    return text;
  }
}

class FakePage implements LinkedInPagePort {
  readonly navigations: string[] = [];
  readonly selectors: string[] = [];
  readonly bodies = new Map<string, string>();
  readonly titles = new Map<string, string>();
  readonly nodes = new Map<string, Record<string, FakeDomNode[]>>();
  readonly statuses = new Map<string, number>();
  currentUrl = "about:blank";

  async goto(url: string): Promise<{ status(): number }> {
    this.currentUrl = url;
    this.navigations.push(url);
    return { status: () => this.statuses.get(url) ?? 200 };
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.titles.get(this.currentUrl) ?? "";
  }

  locator(selector: string): LinkedInLocatorPort {
    this.selectors.push(selector);
    if (selector === "body") {
      return new FakeLocator([{ text: this.bodies.get(this.currentUrl) || "" }]);
    }
    return new FakeLocator(this.nodes.get(this.currentUrl)?.[selector] || []);
  }
}

function createProductionPort(
  page: FakePage,
  options: ConstructorParameters<typeof PlaywrightLinkedInBrowserPort>[1] = {},
) {
  let newPageCalls = 0;
  let closeCalls = 0;
  const context = {
    pages: () => [page],
    async newPage() {
      newPageCalls += 1;
      return page;
    },
    async close() {
      closeCalls += 1;
    },
  } as unknown as BrowserContextLike;
  const launcher: BrowserLauncher = {
    async launchPersistentContext() {
      return context;
    },
  };
  const runtime = new BrowserRuntime("/tmp/linkedin-profile", launcher);
  const port = new PlaywrightLinkedInBrowserPort(runtime, options);
  return {
    closeCalls: () => closeCalls,
    newPageCalls: () => newPageCalls,
    port,
  };
}

describe("PlaywrightLinkedInBrowserPort", () => {
  it("reuses one visible runtime page and returns zero for no search cards", async () => {
    const page = new FakePage();
    page.bodies.set("https://www.linkedin.com/feed/", "LinkedIn feed");
    const searchUrl =
      "https://www.linkedin.com/jobs/search/?keywords=sales&f_TPR=r604800&f_WT=2";
    page.bodies.set(searchUrl, "No matching jobs");
    page.nodes.set(searchUrl, {
      ".jobs-search-no-results-banner, .jobs-search-no-results-list, .jobs-search-results-list__empty-state": [
        { text: "No matching jobs" },
      ],
    });
    const { closeCalls, newPageCalls, port } = createProductionPort(page);

    const results = await port.run(async (session) => {
      await session.ensureAuthenticated();
      return session.search(searchUrl, 20);
    });

    expect(results).toEqual([]);
    expect(page.navigations).toEqual([
      "https://www.linkedin.com/feed/",
      searchUrl,
    ]);
    expect(page.selectors).toContain(
      "[data-job-id], .job-card-container, li.jobs-search-results__list-item",
    );
    expect(newPageCalls()).toBe(0);
    expect(closeCalls()).toBe(1);
  });

  it("waits boundedly for delayed search cards", async () => {
    const page = new FakePage();
    page.bodies.set("https://www.linkedin.com/feed/", "LinkedIn feed");
    const searchUrl = "https://www.linkedin.com/jobs/search/?keywords=delayed";
    page.bodies.set(searchUrl, "Search results loading");
    const delayedCards: FakeDomNode[] = [];
    page.nodes.set(searchUrl, {
      "[data-job-id], .job-card-container, li.jobs-search-results__list-item":
        delayedCards,
    });
    let now = 0;
    const waits: number[] = [];
    const { port } = createProductionPort(page, {
      now: () => now,
      searchReadyTimeoutMs: 1_000,
      wait: async (milliseconds) => {
        now += milliseconds;
        waits.push(milliseconds);
        delayedCards.push({
          attributes: { "data-job-id": "delayed-21" },
          children: {
            'a[href*="/jobs/view/"]': [
              { attributes: { href: "/jobs/view/21/" } },
            ],
          },
        });
      },
    });

    const results = await port.run(async (session) => {
      await session.ensureAuthenticated();
      return session.search(searchUrl, 1);
    });

    expect(results).toEqual([
      {
        externalId: "delayed-21",
        url: "https://www.linkedin.com/jobs/view/21/",
      },
    ]);
    expect(waits).toEqual([250]);
  });

  it.each([
    [
      "login",
      "Join LinkedIn or sign in",
      "[job radar linkedin] LinkedIn login required",
    ],
    [
      "challenge",
      "Complete the CAPTCHA challenge",
      "[job radar linkedin] LinkedIn blocked browser discovery",
    ],
    [
      "account restriction",
      "Your LinkedIn account is temporarily restricted",
      "[job radar linkedin] LinkedIn blocked browser discovery",
    ],
  ])(
    "reclassifies a delayed search %s while waiting for results",
    async (_case, body, expectedError) => {
      const page = new FakePage();
      const searchUrl =
        "https://www.linkedin.com/jobs/search/?keywords=delayed-status";
      page.bodies.set(searchUrl, "Search results loading");
      let now = 0;
      const { port } = createProductionPort(page, {
        now: () => now,
        searchReadyTimeoutMs: 1_000,
        wait: async (milliseconds) => {
          now += milliseconds;
          page.bodies.set(searchUrl, body);
        },
      });

      await expect(
        port.run((session) => session.search(searchUrl, 1)),
      ).rejects.toThrow(expectedError);
    },
  );

  it.each([
    ["HTTP 500", 500, "Server error"],
    ["unknown readiness timeout", 200, "Please wait"],
  ])("does not advance state after %s during search", async (_case, status, body) => {
    const page = new FakePage();
    page.bodies.set("https://www.linkedin.com/feed/", "LinkedIn feed");
    const searchUrl = "https://www.linkedin.com/jobs/search/?keywords=sales";
    page.bodies.set(searchUrl, body);
    page.statuses.set(searchUrl, status);
    let now = 0;
    const { port } = createProductionPort(page, {
      now: () => now,
      searchReadyTimeoutMs: 500,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
    });
    const state = new MemoryStatePort();
    const connector = new LinkedInConnector(
      connectorConfig({ linkedinSearchUrls: [searchUrl] }),
      state,
      port,
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(connector.fetchJobs()).rejects.toThrow(
        /^\[job radar linkedin\]/,
      );
    } finally {
      errorLog.mockRestore();
    }
    expect(state.saved).toEqual([]);
  });

  it("extracts direct and nested IDs with safe canonical URLs and bounded filtering", async () => {
    const page = new FakePage();
    page.bodies.set("https://www.linkedin.com/feed/", "LinkedIn feed");
    const searchUrl = "https://www.linkedin.com/jobs/search/?keywords=sales";
    page.bodies.set(searchUrl, "Search results");
    page.nodes.set(searchUrl, {
      "[data-job-id], .job-card-container, li.jobs-search-results__list-item": [
        {
          attributes: { "data-job-id": "unsafe" },
          children: {
            'a[href*="/jobs/view/"]': [
              { attributes: { href: "http://www.linkedin.com/jobs/view/9/" } },
            ],
          },
        },
        {
          attributes: { "data-job-id": "direct-11" },
          children: {
            'a[href*="/jobs/view/"]': [
              {
                attributes: {
                  href: "/jobs/view/11/?trackingId=secret#fragment",
                },
              },
            ],
          },
        },
        {
          children: {
            "[data-job-id]": [
              { attributes: { "data-job-id": "nested-12" } },
            ],
            'a[href*="/jobs/view/"]': [
              { attributes: { href: "https://se.linkedin.com/jobs/view/12/" } },
            ],
          },
        },
        { attributes: { "data-job-id": "malformed" } },
        {
          attributes: { "data-job-id": "credentialed" },
          children: {
            'a[href*="/jobs/view/"]': [
              {
                attributes: {
                  href: "https://user:pass@www.linkedin.com/jobs/view/13/",
                },
              },
            ],
          },
        },
        {
          attributes: { "data-job-id": "custom-port" },
          children: {
            'a[href*="/jobs/view/"]': [
              {
                attributes: {
                  href: "https://www.linkedin.com:444/jobs/view/14/",
                },
              },
            ],
          },
        },
        {
          attributes: { "data-job-id": "standard-port" },
          children: {
            'a[href*="/jobs/view/"]': [
              {
                attributes: {
                  href: "https://www.linkedin.com:443/jobs/view/15/?trk=secret",
                },
              },
            ],
          },
        },
      ],
    });
    const { port } = createProductionPort(page);

    const results = await port.run(async (session) => {
      await session.ensureAuthenticated();
      return session.search(searchUrl, 3);
    });

    expect(results).toEqual([
      {
        externalId: "direct-11",
        url: "https://www.linkedin.com/jobs/view/11/",
      },
      {
        externalId: "nested-12",
        url: "https://se.linkedin.com/jobs/view/12/",
      },
      {
        externalId: "standard-port",
        url: "https://www.linkedin.com/jobs/view/15/",
      },
    ]);
  });

  it("paces between detail navigations and reads title plus about section", async () => {
    const page = new FakePage();
    page.bodies.set("https://www.linkedin.com/feed/", "LinkedIn feed");
    const first = reference("1");
    const second = reference("2");
    page.titles.set(first.url, "Sales Lead | Acme AB | LinkedIn");
    page.bodies.set(first.url, "Apply now\nAbout the job\nContract role.");
    page.nodes.set(first.url, {
      // Best-effort fields still come from (fragile) pills when present.
      ".jobs-unified-top-card__job-insight": [{ text: "Contract" }],
      ".jobs-unified-top-card__posted-date time[datetime]": [
        { attributes: { datetime: "2026-07-15T08:00:00.000Z" } },
      ],
    });
    page.titles.set(second.url, "Marketing Lead | Beta AB | LinkedIn");
    page.bodies.set(second.url, "About the job\nSecond role.");
    const waits: number[] = [];
    const { port } = createProductionPort(page, {
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    const details = await port.run(async (session) => {
      await session.ensureAuthenticated();
      return [await session.detail(first), await session.detail(second)];
    });

    expect(details).toHaveLength(2);
    expect(details[0]).toMatchObject({
      externalId: "1",
      title: "Sales Lead",
      company: "Acme AB",
      description: "Contract role.",
      employmentType: "Contract",
      postedAt: "2026-07-15T08:00:00.000Z",
    });
    expect(details[1]).toMatchObject({
      title: "Marketing Lead",
      company: "Beta AB",
      description: "Second role.",
      employmentType: null,
      postedAt: null,
    });
    expect(waits).toEqual([1_500]);
  });

  it("waits boundedly for a client-rendered detail before reading it", async () => {
    const page = new FakePage();
    const target = reference("21");
    page.bodies.set(target.url, "Loading job");
    let now = 0;
    const waits: number[] = [];
    const { port } = createProductionPort(page, {
      detailReadyTimeoutMs: 1_000,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
        waits.push(milliseconds);
        page.titles.set(target.url, "Delayed Sales Lead | Acme AB | LinkedIn");
        page.bodies.set(target.url, "About the job\nDelayed contract role.");
      },
    });

    const detail = await port.run((session) => session.detail(target));

    expect(detail).toMatchObject({
      title: "Delayed Sales Lead",
      company: "Acme AB",
      description: "Delayed contract role.",
    });
    expect(waits).toEqual([250]);
  });

  it.each([
    [
      "block",
      "Our systems have detected unusual traffic",
      "[job radar linkedin] LinkedIn blocked browser discovery",
    ],
    [
      "login",
      "Join LinkedIn or sign in",
      "[job radar linkedin] LinkedIn login required",
    ],
  ])(
    "reclassifies a delayed %s while waiting for detail readiness",
    async (_case, body, expectedError) => {
      const page = new FakePage();
      const target = reference("22");
      page.bodies.set(target.url, "Loading job");
      let now = 0;
      const { port } = createProductionPort(page, {
        detailReadyTimeoutMs: 1_000,
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
          page.bodies.set(target.url, body);
        },
      });

      await expect(
        port.run((session) => session.detail(target)),
      ).rejects.toThrow(expectedError);
    },
  );

  it("does not advance state when mounted detail fields stay empty", async () => {
    const page = new FakePage();
    page.bodies.set("https://www.linkedin.com/feed/", "LinkedIn feed");
    const savedSearch =
      "https://www.linkedin.com/jobs/search/?keywords=timeout-detail";
    const searchUrl = withLinkedInRecency(savedSearch, false);
    const target = reference("23");
    page.bodies.set(searchUrl, "Search results");
    page.nodes.set(searchUrl, {
      "[data-job-id], .job-card-container, li.jobs-search-results__list-item": [
        {
          attributes: { "data-job-id": "23" },
          children: {
            'a[href*="/jobs/view/"]': [
              { attributes: { href: target.url } },
            ],
          },
        },
      ],
    });
    // Detail page never renders a parseable title or an About-the-job section.
    page.bodies.set(target.url, "Loading job");
    let now = 0;
    const { port } = createProductionPort(page, {
      detailReadyTimeoutMs: 500,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
    });
    const state = new MemoryStatePort();
    const connector = new LinkedInConnector(
      connectorConfig({ linkedinSearchUrls: [savedSearch] }),
      state,
      port,
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(connector.fetchJobs()).rejects.toThrow(
        "[job radar linkedin] LinkedIn detail readiness timed out",
      );
    } finally {
      errorLog.mockRestore();
    }
    expect(state.saved).toEqual([]);
  });

  it("logs manual login handoff and throws the exact timeout error", async () => {
    const page = new FakePage();
    page.bodies.set(
      "https://www.linkedin.com/feed/",
      "Join LinkedIn or sign in",
    );
    let now = 0;
    const { port } = createProductionPort(page, {
      loginTimeoutMs: 2_000,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        port.run((session) => session.ensureAuthenticated()),
      ).rejects.toThrow("[job radar linkedin] LinkedIn login required");
      expect(errorLog).toHaveBeenCalledWith(
        "[job radar linkedin] LinkedIn login required in the visible Chromium window",
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("completes the manual login handoff and verifies the feed again", async () => {
    const page = new FakePage();
    page.bodies.set(
      "https://www.linkedin.com/feed/",
      "Join LinkedIn or sign in",
    );
    let now = 0;
    const { port } = createProductionPort(page, {
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
        page.bodies.set("https://www.linkedin.com/feed/", "LinkedIn feed");
      },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        port.run((session) => session.ensureAuthenticated()),
      ).resolves.toBeUndefined();
    } finally {
      errorLog.mockRestore();
    }
    expect(page.navigations).toEqual([
      "https://www.linkedin.com/feed/",
      "https://www.linkedin.com/feed/",
    ]);
  });

  it.each(["search", "detail"] as const)(
    "stops on a classified block during %s navigation",
    async (operation) => {
      const page = new FakePage();
      page.bodies.set("https://www.linkedin.com/feed/", "LinkedIn feed");
      const target =
        operation === "search"
          ? "https://www.linkedin.com/jobs/search/?keywords=sales"
          : "https://www.linkedin.com/jobs/view/42/";
      page.bodies.set(target, "Our systems have detected unusual traffic");
      const { port } = createProductionPort(page);

      await expect(
        port.run(async (session) => {
          await session.ensureAuthenticated();
          return operation === "search"
            ? session.search(target, 1)
            : session.detail(reference("42"));
        }),
      ).rejects.toThrow(
        "[job radar linkedin] LinkedIn blocked browser discovery",
      );
    },
  );

  it("stops immediately on a classified block page", async () => {
    const page = new FakePage();
    page.bodies.set(
      "https://www.linkedin.com/feed/",
      "Our systems have detected unusual traffic",
    );
    const { port } = createProductionPort(page);

    await expect(
      port.run((session) => session.ensureAuthenticated()),
    ).rejects.toThrow(
      "[job radar linkedin] LinkedIn blocked browser discovery",
    );
  });
});
