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
  mapLinkedInJob,
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
    return this.searchResults.get(keywords) || [];
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
    return this.nodes[0]?.attributes?.[name] || null;
  }

  async innerText(): Promise<string> {
    const text = this.nodes[0]?.text;
    if (text === undefined) throw new Error("Fake locator has no text");
    return text;
  }
}

class FakePage implements LinkedInPagePort {
  readonly navigations: string[] = [];
  readonly selectors: string[] = [];
  readonly bodies = new Map<string, string>();
  readonly nodes = new Map<string, Record<string, FakeDomNode[]>>();
  currentUrl = "about:blank";

  async goto(url: string): Promise<{ status(): number }> {
    this.currentUrl = url;
    this.navigations.push(url);
    return { status: () => 200 };
  }

  url(): string {
    return this.currentUrl;
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

  it("paces between detail navigations and uses the required detail fallbacks", async () => {
    const page = new FakePage();
    page.bodies.set("https://www.linkedin.com/feed/", "LinkedIn feed");
    const first = reference("1");
    const second = reference("2");
    const descriptionSelector =
      ".jobs-description-content__text, .jobs-description__content, .jobs-box__html-content";
    const detailNodes = {
      ".job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1": [
        { text: "Sales Lead" },
      ],
      ".job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, a[href*='/company/']": [
        { text: "Acme AB" },
      ],
      ".job-details-jobs-unified-top-card__primary-description-container .tvm__text, .jobs-unified-top-card__bullet": [
        { text: "Remote, Sweden" },
      ],
      ".job-details-preferences-and-skills__pill, .jobs-unified-top-card__job-insight": [
        { text: "Contract" },
      ],
      "time[datetime]": [
        { attributes: { datetime: "2026-07-15T08:00:00.000Z" } },
      ],
      [descriptionSelector]: [{ text: "Contract role." }],
    };
    for (const job of [first, second]) {
      page.bodies.set(job.url, "Apply now");
      page.nodes.set(job.url, detailNodes);
    }
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
      description: "Contract role.",
      employmentType: "Contract",
      postedAt: "2026-07-15T08:00:00.000Z",
    });
    expect(waits).toEqual([1_500]);
    expect(page.selectors).toContain(descriptionSelector);
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
