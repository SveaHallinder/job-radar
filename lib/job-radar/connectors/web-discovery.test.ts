import { describe, expect, it, vi } from "vitest";

import type { BrowserDiscoveryConfig } from "../browser/config";
import {
  BrowserRuntime,
  type BrowserContextLike,
  type BrowserLauncher,
} from "../browser/runtime";
import { EMPTY_BROWSER_STATE, type BrowserState } from "../browser/state";

import {
  buildWebQueries,
  PlaywrightWebDiscoveryBrowserPort,
  WebDiscoveryConnector,
  mapPublicJobPage,
  sanitizeGoogleResultUrl,
  type WebDiscoveryBrowserPort,
  type WebDiscoverySession,
  type WebDiscoveryStatePort,
  type WebLocatorPort,
  type WebPagePort,
  type PublicJobPage,
} from "./web-discovery";

describe("buildWebQueries", () => {
  it("builds at most eight focused queries across roles, terms, regions, and targets", () => {
    const queries = buildWebQueries(8);
    const text = queries.join(" ").toLowerCase();

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(8);
    for (const term of [
      "sales",
      "marketing",
      "remote",
      "contract",
      "freelance",
      "consulting",
      "sweden",
      "romania",
      "bucharest",
      "emea",
      "europe",
      "jobs.lever.co",
      "greenhouse",
      "careers",
      "linkedin.com/jobs/view",
    ]) {
      expect(text).toContain(term);
    }
    expect(buildWebQueries(2)).toHaveLength(2);
  });
});

describe("sanitizeGoogleResultUrl", () => {
  it.each([
    [
      "direct Lever URL",
      "https://jobs.lever.co/acme/role-123?source=google#apply",
      "https://jobs.lever.co/acme/role-123",
    ],
    [
      "wrapped Greenhouse URL",
      "/url?q=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F456%3Fgh_src%3Dgoogle&sa=U",
      "https://boards.greenhouse.io/acme/jobs/456",
    ],
    [
      "LinkedIn detail URL",
      "https://www.linkedin.com/jobs/view/growth-lead-789/?trackingId=x",
      "https://www.linkedin.com/jobs/view/growth-lead-789",
    ],
    [
      "employer career detail",
      "https://careers.acme.example/careers/sales-lead-123?utm_source=google",
      "https://careers.acme.example/careers/sales-lead-123",
    ],
  ])("accepts a %s", (_case, value, expected) => {
    expect(sanitizeGoogleResultUrl(value)).toBe(expected);
  });

  it.each([
    "http://jobs.lever.co/acme/role-123",
    "https://user:secret@jobs.lever.co/acme/role-123",
    "https://jobs.lever.co:8443/acme/role-123",
    "https://www.google.com/search?q=jobs",
    "https://jobs.lever.co/acme",
    "https://boards.greenhouse.io/acme/jobs",
    "https://www.linkedin.com/jobs/search/?keywords=sales",
    "https://careers.acme.example/careers",
    "https://acme.example/blog/best-sales-jobs",
    "https://jobs.lever.co/acme/jobs",
    "https://google.se/url?q=https://jobs.lever.co/acme/role-123",
    "https://www.bing.com/search/jobs/sales-lead",
    "https://careers.acme.example/jobs/search/sales-lead",
    "https://careers.acme.example/jobs/category/sales-lead",
    "https://careers.acme.example/jobs/sales-jobs-in-europe",
    "https://careers.acme.example/jobs/best-remote-sales-jobs",
    "https://careers.acme.example/jobs/remote-sales-jobs",
  ])("rejects unsafe or generic result %s", (value) => {
    expect(sanitizeGoogleResultUrl(value)).toBeNull();
  });
});

describe("mapPublicJobPage", () => {
  const page: PublicJobPage = {
    status: 200,
    url: "https://careers.acme.example/jobs/growth-sales-lead?ref=google",
    text: "Visible job content",
    jsonLd: [
      {
        "@type": ["Thing", "JobPosting"],
        title: "Growth Sales Lead",
        hiringOrganization: { name: "Acme AB" },
        jobLocation: { address: { addressCountry: "Europe" } },
        description: "Remote contract role across Europe.",
        employmentType: "CONTRACTOR",
        datePosted: "2026-07-14",
        validThrough: "2026-08-01",
        jobLocationType: "TELECOMMUTE",
      },
    ],
  };

  it("maps stable direct source fields, narrow title tags, and explicit remote evidence", () => {
    const first = mapPublicJobPage(page, new Date("2026-07-15T12:00:00.000Z"));
    const second = mapPublicJobPage(
      { ...page, url: `${page.url}#apply` },
      new Date("2026-07-15T12:00:00.000Z"),
    );

    expect(first).toMatchObject({
      source: "Web discovery",
      sourceUrl: "https://careers.acme.example/jobs/growth-sales-lead",
      originalUrl: "https://careers.acme.example/jobs/growth-sales-lead",
      title: "Growth Sales Lead",
      company: "Acme AB",
      location: "Europe",
      remote: true,
      tags: ["Sales", "Marketing"],
    });
    expect(first?.externalId).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.externalId).toBe(first?.externalId);
  });

  it("maps a sufficient unknown raw fallback without apply copy and honors remote negation", () => {
    const mapped = mapPublicJobPage({
      status: 200,
      url: page.url,
      text: "Complete visible job description without an apply CTA.",
      jsonLd: [],
      title: "Sales Lead",
      company: "Acme AB",
      location: "Stockholm",
      description: "This is not a remote role; work is on-site.",
    });

    expect(mapped?.remote).toBeNull();
    expect(mapped?.title).toBe("Sales Lead");
  });

  it("returns null for expired probes and flattens applicant-location arrays", () => {
    const expired = mapPublicJobPage(
      {
        ...page,
        jsonLd: [jobPosting({ validThrough: "2026-07-14" })],
      },
      new Date("2026-07-15T12:00:00.000Z"),
    );
    const telecommute = mapPublicJobPage(
      {
        ...page,
        jsonLd: [
          jobPosting({
            jobLocation: undefined,
            applicantLocationRequirements: [{ name: "Europe" }, { name: "EMEA" }],
          }),
        ],
      },
      new Date("2026-07-15T12:00:00.000Z"),
    );

    expect(expired).toBeNull();
    expect(telecommute).toMatchObject({ location: "Europe, EMEA", remote: true });
  });
});

class MemoryState implements WebDiscoveryStatePort {
  saved: BrowserState[] = [];

  constructor(readonly value: BrowserState = { ...EMPTY_BROWSER_STATE }) {}

  async load(): Promise<BrowserState> {
    return { ...this.value };
  }

  async save(value: BrowserState): Promise<void> {
    this.saved.push({ ...value });
  }
}

class FakeWebSession implements WebDiscoverySession {
  searchCalls: Array<{ query: string; page: number }> = [];
  detailCalls: string[] = [];
  searchError?: unknown;
  detailError?: unknown;
  searchResults = new Map<string, string[]>();
  details = new Map<string, PublicJobPage | null>();

  async search(query: string, pageNumber: number): Promise<string[]> {
    this.searchCalls.push({ query, page: pageNumber });
    if (this.searchError) throw this.searchError;
    return this.searchResults.get(`${query}:${pageNumber}`) || [];
  }

  async detail(url: string): Promise<PublicJobPage | null> {
    this.detailCalls.push(url);
    if (this.detailError) throw this.detailError;
    return this.details.get(url) || {
      status: 200,
      url,
      text: "Remote contract role.",
      jsonLd: [],
      title: "Sales Lead",
      company: "Acme AB",
      location: "Remote, Europe",
      description: "Remote contract role.",
    };
  }
}

class FakeWebBrowser implements WebDiscoveryBrowserPort {
  runs = 0;

  constructor(readonly session: FakeWebSession) {}

  async run<T>(task: (session: WebDiscoverySession) => Promise<T>): Promise<T> {
    this.runs += 1;
    return task(this.session);
  }
}

function webConfig(overrides: Partial<BrowserDiscoveryConfig> = {}): BrowserDiscoveryConfig {
  return {
    enabled: true,
    profilePath: "/tmp/web-profile",
    statePath: "/tmp/web-state.json",
    linkedinSearchUrls: [],
    linkedinBootstrapMaxResults: 200,
    linkedinIncrementalMaxResults: 100,
    linkedinMaxDetails: 80,
    googleMaxQueries: 2,
    googleMaxPages: 2,
    ...overrides,
  };
}

function publicUrl(id: number): string {
  return `https://careers.acme.example/jobs/role-${id}`;
}

describe("WebDiscoveryConnector", () => {
  it("uses query/page caps, deduplicates globally, and merges successful state", async () => {
    const session = new FakeWebSession();
    const queries = buildWebQueries(2);
    session.searchResults.set(`${queries[0]}:1`, [publicUrl(1), publicUrl(2)]);
    session.searchResults.set(`${queries[0]}:2`, [publicUrl(2), publicUrl(3)]);
    session.searchResults.set(`${queries[1]}:1`, [publicUrl(3), publicUrl(4)]);
    session.searchResults.set(`${queries[1]}:2`, [publicUrl(4), publicUrl(5)]);
    const initial = {
      ...EMPTY_BROWSER_STATE,
      linkedinBootstrapCompleted: true,
      validationCursor: "linkedin:42",
    };
    const state = new MemoryState(initial);
    const connector = new WebDiscoveryConnector(
      webConfig(),
      state,
      new FakeWebBrowser(session),
      () => new Date("2026-07-15T12:00:00.000Z"),
    );

    const jobs = await connector.fetchJobs();

    expect(jobs).toHaveLength(5);
    expect(session.searchCalls).toHaveLength(4);
    expect(session.detailCalls).toHaveLength(5);
    expect(state.saved).toEqual([
      {
        ...initial,
        googleLastSuccessfulAt: "2026-07-15T12:00:00.000Z",
      },
    ]);
    expect(connector.name).toBe("Web discovery");
    expect(connector.execution).toBe("browser");
  });

  it("enforces the global 80-detail cap", async () => {
    const session = new FakeWebSession();
    session.searchResults.set(
      `${buildWebQueries(1)[0]}:1`,
      Array.from({ length: 100 }, (_, index) => publicUrl(index)),
    );
    const connector = new WebDiscoveryConnector(
      webConfig({ googleMaxQueries: 1, googleMaxPages: 1 }),
      new MemoryState(),
      new FakeWebBrowser(session),
    );

    await expect(connector.fetchJobs()).resolves.toHaveLength(80);
    expect(session.detailCalls).toHaveLength(80);
  });

  it("advances state after a known empty result", async () => {
    const state = new MemoryState();
    const connector = new WebDiscoveryConnector(
      webConfig(),
      state,
      new FakeWebBrowser(new FakeWebSession()),
      () => new Date("2026-07-15T12:00:00.000Z"),
    );

    await expect(connector.fetchJobs()).resolves.toEqual([]);
    expect(state.saved[0]?.googleLastSuccessfulAt).toBe(
      "2026-07-15T12:00:00.000Z",
    );
  });

  it("skips a nullable expired detail mapping and still completes state", async () => {
    const session = new FakeWebSession();
    const url = publicUrl(90);
    session.searchResults.set(`${buildWebQueries(2)[0]}:1`, [url]);
    session.details.set(url, {
      status: 410,
      url,
      text: "This job is closed.",
      jsonLd: [],
    });
    const state = new MemoryState();
    const connector = new WebDiscoveryConnector(
      webConfig(),
      state,
      new FakeWebBrowser(session),
    );

    await expect(connector.fetchJobs()).resolves.toEqual([]);
    expect(state.saved).toHaveLength(1);
  });

  it("does not save state on failure and preserves prefixed errors", async () => {
    const session = new FakeWebSession();
    const failure = new Error(
      "[job radar google] Google blocked browser discovery with CAPTCHA",
    );
    session.searchError = failure;
    const state = new MemoryState();
    const connector = new WebDiscoveryConnector(
      webConfig(),
      state,
      new FakeWebBrowser(session),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(connector.fetchJobs()).rejects.toBe(failure);
    } finally {
      errorLog.mockRestore();
    }
    expect(state.saved).toEqual([]);
  });

  it("wraps unknown failures with cause and no state save", async () => {
    const session = new FakeWebSession();
    const cause = new TypeError("Google parser exploded");
    session.detailError = cause;
    session.searchResults.set(`${buildWebQueries(2)[0]}:1`, [publicUrl(1)]);
    const state = new MemoryState();
    const connector = new WebDiscoveryConnector(
      webConfig(),
      state,
      new FakeWebBrowser(session),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(connector.fetchJobs()).rejects.toEqual(
        expect.objectContaining({
          message: "[job radar google] Web discovery failed: Google parser exploded",
          cause,
        }),
      );
    } finally {
      errorLog.mockRestore();
    }
    expect(state.saved).toEqual([]);
  });
});

interface FakeNode {
  text?: string;
  attributes?: Record<string, string>;
}

interface FakeDocument {
  status?: number;
  finalUrl?: string;
  body: string;
  links?: string[];
  noResults?: string;
  scripts?: unknown[];
  nodes?: Record<string, FakeNode[]>;
}

class FakeLocator implements WebLocatorPort {
  constructor(
    private readonly nodes: FakeNode[],
    private readonly bodyRead?: () => string,
  ) {}

  async count() {
    return this.nodes.length;
  }

  nth(index: number): WebLocatorPort {
    return new FakeLocator(this.nodes[index] ? [this.nodes[index]] : []);
  }

  first(): WebLocatorPort {
    return this.nth(0);
  }

  async getAttribute(name: string) {
    if (this.nodes.length === 0) throw new Error("Fake locator matched no nodes");
    return this.nodes[0]?.attributes?.[name] || null;
  }

  async innerText() {
    if (this.bodyRead) return this.bodyRead();
    const text = this.nodes[0]?.text;
    if (text === undefined) throw new Error("Fake locator has no text");
    return text;
  }

  async textContent() {
    if (this.nodes.length === 0) throw new Error("Fake locator matched no nodes");
    return this.nodes[0]?.text ?? null;
  }
}

class FakePage implements WebPagePort {
  navigations: string[] = [];
  private currentUrl = "about:blank";
  private documents: FakeDocument[] = [];
  private active: FakeDocument = { body: "" };
  private bodyReads = 0;

  constructor(private readonly resolve: (url: string) => FakeDocument[]) {}

  async goto(url: string) {
    this.navigations.push(url);
    this.currentUrl = url;
    this.documents = this.resolve(url);
    if (this.documents.length === 0) throw new Error(`No fake route for ${url}`);
    this.active = this.documents[0]!;
    this.bodyReads = 0;
    return { status: () => this.active.status ?? 200 };
  }

  url() {
    return this.active.finalUrl || this.currentUrl;
  }

  locator(selector: string): WebLocatorPort {
    if (selector === "body") {
      return new FakeLocator([{ text: this.active.body }], () => {
        this.active =
          this.documents[Math.min(this.bodyReads, this.documents.length - 1)]!;
        this.bodyReads += 1;
        return this.active.body;
      });
    }
    if (selector === "#search a[href]") {
      return new FakeLocator(
        (this.active.links || []).map((href) => ({ attributes: { href } })),
      );
    }
    if (
      selector ===
      '#topstuff [role="heading"], #botstuff .card-section, [data-attrid="No results"]'
    ) {
      return new FakeLocator(
        this.active.noResults ? [{ text: this.active.noResults }] : [],
      );
    }
    if (selector === 'script[type="application/ld+json"]') {
      return new FakeLocator(
        (this.active.scripts || []).map((value) => ({ text: JSON.stringify(value) })),
      );
    }
    return new FakeLocator(this.active.nodes?.[selector] || []);
  }
}

function productionPort(
  page: FakePage,
  options: ConstructorParameters<typeof PlaywrightWebDiscoveryBrowserPort>[1] = {},
) {
  let closes = 0;
  let newPages = 0;
  const context = {
    pages: () => [page],
    async newPage() {
      newPages += 1;
      return page;
    },
    async close() {
      closes += 1;
    },
  } as unknown as BrowserContextLike;
  const launcher: BrowserLauncher = {
    async launchPersistentContext() {
      return context;
    },
  };
  return {
    closes: () => closes,
    newPages: () => newPages,
    port: new PlaywrightWebDiscoveryBrowserPort(
      new BrowserRuntime("/tmp/web-profile", launcher),
      options,
    ),
  };
}

function jobPosting(overrides: Record<string, unknown> = {}) {
  return {
    "@type": "JobPosting",
    title: "Growth Marketing Lead",
    description: "<p>Remote consulting role.</p>",
    hiringOrganization: { name: "Acme AB" },
    jobLocation: {
      address: { addressLocality: "Bucharest", addressCountry: "Romania" },
    },
    employmentType: "CONTRACTOR",
    datePosted: "2026-07-14",
    validThrough: "2026-08-01",
    jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: { name: "Europe" },
    ...overrides,
  };
}

describe("PlaywrightWebDiscoveryBrowserPort", () => {
  it("waits for Google readiness, parses result links, and uses one page", async () => {
    const page = new FakePage(() => [
      { body: "Loading results" },
      {
        body: "Search results",
        links: [
          "https://jobs.lever.co/acme/role-1?source=google",
          "/url?q=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F2&sa=U",
          "https://www.google.com/search?q=more",
        ],
      },
    ]);
    let now = 0;
    const waits: number[] = [];
    const { closes, newPages, port } = productionPort(page, {
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      searchReadyTimeoutMs: 1_000,
    });

    const urls = await port.run((session) => session.search("sales remote", 3));

    expect(urls).toEqual([
      "https://jobs.lever.co/acme/role-1",
      "https://boards.greenhouse.io/acme/jobs/2",
    ]);
    const navigation = new URL(page.navigations[0]!);
    expect(navigation.searchParams.get("q")).toBe("sales remote");
    expect(navigation.searchParams.get("filter")).toBe("0");
    expect(navigation.searchParams.get("start")).toBe("20");
    expect(waits).toContain(250);
    expect(newPages()).toBe(0);
    expect(closes()).toBe(1);
  });

  it("accepts only an explicit Google no-results page as empty", async () => {
    const page = new FakePage(() => [
      {
        body: "Your search did not match any documents",
        noResults: "Your search did not match any documents",
      },
    ]);
    const { port } = productionPort(page);
    await expect(port.run((session) => session.search("sales", 1))).resolves.toEqual(
      [],
    );
  });

  it("does not accept no-results body copy without explicit Google DOM state", async () => {
    const page = new FakePage(() => [
      { body: "Article quoting: your search did not match any documents" },
    ]);
    const { port } = productionPort(page, { searchReadyTimeoutMs: 0 });

    await expect(port.run((session) => session.search("sales", 1))).rejects.toThrow(
      "Google search readiness timed out",
    );
  });

  it.each([
    ["HTTP 500", { status: 500, body: "Server error" }, "HTTP 500"],
    [
      "interstitial",
      { body: "Before you continue to Google", finalUrl: "https://www.google.com/sorry/" },
      "Google search interstitial detected",
    ],
    [
      "CAPTCHA",
      { body: "Complete the CAPTCHA to continue" },
      "[job radar google] Google blocked browser discovery with CAPTCHA",
    ],
  ])("fails %s without treating it as empty", async (_case, document, message) => {
    const { port } = productionPort(new FakePage(() => [document]), {
      searchReadyTimeoutMs: 0,
    });
    await expect(port.run((session) => session.search("sales", 1))).rejects.toThrow(
      message,
    );
  });

  it.each([
    ["array", [jobPosting()]],
    ["@graph", { "@graph": [{ "@type": "Organization" }, jobPosting()] }],
  ])("extracts an active JSON-LD %s", async (_case, script) => {
    const url = publicUrl(30);
    const { port } = productionPort(
      new FakePage(() => [{ body: "Apply now", scripts: [script] }]),
      { now: () => Date.parse("2026-07-15T12:00:00.000Z") },
    );
    const raw = await port.run((session) => session.detail(url));
    expect(raw).toMatchObject({ status: 200, url, text: "Apply now" });
    expect(raw?.jsonLd).toEqual([script]);
    expect(
      mapPublicJobPage(raw!, new Date("2026-07-15T12:00:00.000Z")),
    ).toMatchObject({
      title: "Growth Marketing Lead",
      company: "Acme AB",
      location: "Bucharest, Romania",
    });
  });

  it.each([
    ["expired", { body: "Apply now", scripts: [jobPosting({ validThrough: "2026-07-14" })] }],
    ["closed", { body: "This job is closed." }],
    ["404", { body: "Not found", status: 404 }],
  ])("maps an %s raw detail to null", async (_case, document) => {
    const { port } = productionPort(new FakePage(() => [document]), {
      now: () => Date.parse("2026-07-15T12:00:00.000Z"),
    });
    const raw = await port.run((session) => session.detail(publicUrl(31)));
    expect(raw).toMatchObject({ status: document.status ?? 200 });
    expect(
      mapPublicJobPage(raw!, new Date("2026-07-15T12:00:00.000Z")),
    ).toBeNull();
  });

  it("accepts invalid expiration, paces details, and maps visible fallback", async () => {
    const jsonUrl = publicUrl(40);
    const fallbackUrl = publicUrl(41);
    const page = new FakePage((url) => [
      url === jsonUrl
        ? { body: "Apply now", scripts: [jobPosting({ validThrough: "invalid" })] }
        : {
            body: "Complete visible description for this remote contract role.",
            nodes: {
              'meta[property="og:title"], meta[name="twitter:title"]': [
                { attributes: { content: "Sales Lead" } },
              ],
              '[data-company], .company-name, [itemprop="hiringOrganization"]': [{ text: "Acme AB" }],
              '[data-location], .job-location, [itemprop="jobLocation"]': [{ text: "Remote, Sweden" }],
              '[data-description], .job-description, [itemprop="description"], main': [{ text: "Remote contract role." }],
              '[data-employment-type], [itemprop="employmentType"]': [
                { text: "Contract" },
              ],
              'time[datetime], [itemprop="datePosted"]': [
                { attributes: { datetime: "2026-07-14" } },
              ],
              'link[rel="canonical"]': [
                { attributes: { href: `${fallbackUrl}?source=canonical` } },
              ],
              'meta[name="description"], meta[property="og:description"]': [
                { attributes: { content: "Meta role description" } },
              ],
            },
          },
    ]);
    const waits: number[] = [];
    const { port } = productionPort(page, {
      wait: async (milliseconds) => waits.push(milliseconds),
    });
    const details = await port.run(async (session) => [
      await session.detail(jsonUrl),
      await session.detail(fallbackUrl),
    ]);
    expect(details[0]?.jsonLd).toHaveLength(1);
    expect(
      mapPublicJobPage(details[0]!, new Date("2026-07-15T12:00:00.000Z")),
    ).not.toBeNull();
    expect(details[1]).toMatchObject({
      status: 200,
      title: "Sales Lead",
      company: "Acme AB",
      employmentType: "Contract",
      postedAt: "2026-07-14",
      metaDescription: "Meta role description",
      canonicalUrl: `${fallbackUrl}?source=canonical`,
    });
    expect(mapPublicJobPage(details[1]!)).toMatchObject({ title: "Sales Lead" });
    expect(waits).toEqual([1_500]);
  });

  it("times out missing detail readiness and reclassifies delayed CAPTCHA", async () => {
    let now = 0;
    const missing = productionPort(new FakePage(() => [{ body: "Loading job" }]), {
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      detailReadyTimeoutMs: 250,
    });
    await expect(
      missing.port.run((session) => session.detail(publicUrl(50))),
    ).rejects.toThrow("Web detail readiness timed out");

    now = 0;
    const blocked = productionPort(
      new FakePage(() => [
        { body: "Loading job" },
        { body: "Complete the CAPTCHA to continue" },
      ]),
      {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
        detailReadyTimeoutMs: 1_000,
      },
    );
    await expect(
      blocked.port.run((session) => session.detail(publicUrl(51))),
    ).rejects.toThrow(
      "[job radar google] Google blocked browser discovery with CAPTCHA",
    );
  });

  it("rejects an unsafe redirected final detail URL", async () => {
    const page = new FakePage(() => [
      {
        body: "Apply now",
        finalUrl: "https://acme.example/blog/sales-jobs",
        scripts: [jobPosting()],
      },
    ]);
    const { port } = productionPort(page);

    await expect(port.run((session) => session.detail(publicUrl(70)))).rejects.toThrow(
      "[job radar google] Unsafe redirected job detail URL",
    );
  });
});
