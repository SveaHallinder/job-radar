import { createHash } from "node:crypto";

import type { BrowserDiscoveryConfig } from "../browser/config";
import { classifyPageStatus, type PageStatus } from "../browser/page-status";
import { BrowserRuntime } from "../browser/runtime";
import { BrowserStateStore, type BrowserState } from "../browser/state";
import type { JobConnector, SourceJob } from "../types";

const ERROR_PREFIX = "[job radar google]";
const MAX_DETAILS = 80;
const BLOCKED_ERROR =
  `${ERROR_PREFIX} Google blocked browser discovery with CAPTCHA`;

export interface PublicJobPage {
  status: number | null;
  url: string;
  text: string;
  jsonLd: unknown[];
  title?: string | null;
  company?: string | null;
  location?: string | null;
  description?: string | null;
  employmentType?: string | null;
  postedAt?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
}

interface NormalizedPublicJobPage {
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  employmentType: string | null;
  postedAt: string | null;
  validThrough: string | null;
  jobLocationType: string | null;
  applicantLocationRequirements: string | null;
}

export interface WebDiscoverySession {
  search(query: string, pageNumber: number): Promise<string[]>;
  detail(url: string): Promise<PublicJobPage | null>;
}

export interface WebDiscoveryBrowserPort {
  run<T>(task: (session: WebDiscoverySession) => Promise<T>): Promise<T>;
}

export interface WebDiscoveryStatePort {
  load(): Promise<BrowserState>;
  save(state: BrowserState): Promise<void>;
}

export interface WebLocatorPort {
  count(): Promise<number>;
  nth(index: number): WebLocatorPort;
  first(): WebLocatorPort;
  getAttribute(name: string): Promise<string | null>;
  innerText(): Promise<string>;
  textContent(): Promise<string | null>;
}

export interface WebPagePort {
  goto(
    url: string,
    options?: { waitUntil: "domcontentloaded" },
  ): Promise<{ status(): number } | null>;
  url(): string;
  locator(selector: string): WebLocatorPort;
}

export interface PlaywrightWebDiscoveryOptions {
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  searchReadyTimeoutMs?: number;
  detailReadyTimeoutMs?: number;
}

const ROLE_QUERIES = [
  '(sales OR "account executive" OR "business development")',
  '(marketing OR growth OR "demand generation")',
] as const;
const WORK_QUERY = '(remote) (contract OR freelance OR consulting)';
const REGION_QUERY = '(Sweden OR Romania OR Bucharest OR EMEA OR Europe)';
const TARGET_QUERIES = [
  '(site:jobs.lever.co OR site:boards.greenhouse.io OR site:job-boards.greenhouse.io)',
  '(site:linkedin.com/jobs/view OR inurl:careers OR inurl:jobs OR inurl:positions OR inurl:openings OR inurl:vacancies)',
] as const;

export function buildWebQueries(maxQueries = 8): string[] {
  const queries = ROLE_QUERIES.flatMap((role) =>
    TARGET_QUERIES.map(
      (target) => `${role} ${WORK_QUERY} ${REGION_QUERY} ${target}`,
    ),
  );
  return queries.slice(0, Math.max(0, Math.min(8, maxQueries)));
}

function unwrapGoogleResult(value: string): string {
  try {
    const wrapper = new URL(value, "https://www.google.com");
    const isGoogle =
      wrapper.hostname === "google.com" ||
      wrapper.hostname.endsWith(".google.com");
    if (isGoogle && wrapper.pathname === "/url") {
      return wrapper.searchParams.get("q") || wrapper.searchParams.get("url") || "";
    }
  } catch {
    return "";
  }
  return value;
}

function isAllowedDetailPath(url: URL): boolean {
  const segments = url.pathname.split("/").filter(Boolean);
  const hostname = url.hostname.toLowerCase();
  const isLinkedIn =
    hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");

  const finalSegment = segments.at(-1) || "";
  const isGenericFinal = /^(?:jobs?|careers?|positions?|openings?|vacancies?)$/i.test(
    finalSegment,
  );
  const isListFinal = /-(?:jobs|careers|positions|openings|vacancies)$/i.test(
    finalSegment,
  );
  if (hostname === "jobs.lever.co") {
    return segments.length >= 2 && !isGenericFinal && !isListFinal;
  }
  if (
    hostname === "boards.greenhouse.io" ||
    hostname === "job-boards.greenhouse.io"
  ) {
    return (
      segments.length >= 3 &&
      segments[1]?.toLowerCase() === "jobs" &&
      !isGenericFinal &&
      !isListFinal
    );
  }
  if (isLinkedIn) {
    return (
      segments.length === 3 &&
      segments[0]?.toLowerCase() === "jobs" &&
      segments[1]?.toLowerCase() === "view"
    );
  }

  if (segments.some((segment) => /^(?:blog|guide|resources?|search|category|tag)$/i.test(segment))) {
    return false;
  }
  if (
    isGenericFinal ||
    isListFinal ||
    /(?:^|-)(?:jobs?|careers?|positions?|openings?|vacancies?)-(?:in|at|for)(?:-|$)/i.test(
      finalSegment,
    ) ||
    /^(?:best|top)-.*-(?:jobs?|careers?|positions?|openings?|vacancies?)$/i.test(
      finalSegment,
    )
  ) {
    return false;
  }
  const detailIndex = segments.findIndex((segment) =>
    /^(?:jobs?|careers?|positions?|openings?|vacancies?)$/i.test(segment),
  );
  return detailIndex >= 0 && detailIndex < segments.length - 1;
}

function isSearchEngineHostname(hostname: string): boolean {
  return (
    /^(?:www\.)?google\.[a-z.]+$/i.test(hostname) ||
    /(?:^|\.)(?:bing\.com|search\.yahoo\.com|duckduckgo\.com|ecosia\.org)$/i.test(
      hostname,
    )
  );
}

export function sanitizeGoogleResultUrl(value: string): string | null {
  try {
    const url = new URL(unwrapGoogleResult(value));
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      isSearchEngineHostname(hostname) ||
      !isAllowedDetailPath(url)
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function tagsFromTitle(title: string): string[] {
  const tags: string[] = [];
  if (/\b(?:sales|account executive|business development|revenue operations?|partnerships?)\b/i.test(title)) {
    tags.push("Sales");
  }
  if (/\b(?:marketing|growth|demand generation|content|brand|communications?|seo|sem)\b/i.test(title)) {
    tags.push("Marketing");
  }
  return tags;
}

function remoteFromPage(page: NormalizedPublicJobPage): true | null {
  const evidence = [
    page.jobLocationType,
    page.applicantLocationRequirements,
    page.location,
    page.description,
  ]
    .filter(Boolean)
    .join("\n");
  if (/\bnot\s+(?:(?:a|fully)\s+)?remote\b|\bnon[- ]?remote\b|\bhybrid\b|\bon[- ]?site\b/i.test(evidence)) {
    return null;
  }
  return /\btelecommute\b|\bremote\b|\bwork(?:ing)? from home\b/i.test(evidence)
    ? true
    : null;
}

export function mapPublicJobPage(
  page: PublicJobPage,
  now = new Date(),
): SourceJob | null {
  const url =
    (page.canonicalUrl
      ? sanitizeGoogleResultUrl(page.canonicalUrl)
      : null) || sanitizeGoogleResultUrl(page.url);
  if (!url) return null;
  const pageStatus = classifyPageStatus(
    { status: page.status, url: page.url, text: page.text },
    now,
  );
  if (
    pageStatus === "inactive" ||
    pageStatus === "blocked" ||
    pageStatus === "login-required"
  ) {
    return null;
  }

  const postings = page.jsonLd.flatMap(jobPostingNodes);
  let normalized: NormalizedPublicJobPage | null = null;
  let foundExpiredPosting = false;
  for (const posting of postings) {
    const validThrough = textValue(posting.validThrough) || null;
    const status = classifyPageStatus(
      { status: page.status, url: page.url, text: page.text, validThrough },
      now,
    );
    if (status === "inactive") {
      foundExpiredPosting = true;
      continue;
    }
    normalized = postingToPage(posting, url);
    if (normalized) break;
  }
  if (!normalized && foundExpiredPosting) return null;

  if (!normalized) {
    const title = page.title?.trim() || "";
    const company = page.company?.trim() || "";
    const location = page.location?.trim() || "";
    const description =
      page.description?.trim() || page.metaDescription?.trim() || page.text.trim();
    if (!title || !company || !location || !description) return null;
    normalized = {
      url,
      title,
      company,
      location,
      description,
      employmentType: page.employmentType?.trim() || null,
      postedAt: page.postedAt?.trim() || null,
      validThrough: null,
      jobLocationType: null,
      applicantLocationRequirements: null,
    };
  }

  return {
    source: "Web discovery",
    externalId: createHash("sha256").update(url).digest("hex"),
    sourceUrl: url,
    originalUrl: url,
    title: normalized.title,
    company: normalized.company,
    location: normalized.location,
    country: null,
    description: normalized.description,
    engagementType: normalized.employmentType,
    remote: remoteFromPage(normalized),
    tags: tagsFromTitle(normalized.title),
    postedAt: normalized.postedAt,
  };
}

function hasJobRadarPrefix(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /^\[job radar(?: [^\]]+)?\](?:\s|$)/.test(error.message)
  );
}

function toWebDiscoveryError(error: unknown): Error {
  if (hasJobRadarPrefix(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${ERROR_PREFIX} Web discovery failed: ${message}`, {
    cause: error,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  return typeof record?.name === "string" ? record.name.trim() : "";
}

function htmlToText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function jobPostingNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(jobPostingNodes);
  const record = asRecord(value);
  if (!record) return [];
  const types = Array.isArray(record["@type"])
    ? record["@type"]
    : [record["@type"]];
  const own = types.some(
    (type) => typeof type === "string" && type.toLowerCase() === "jobposting",
  )
    ? [record]
    : [];
  return own.concat(jobPostingNodes(record["@graph"]));
}

function locationFromPosting(posting: Record<string, unknown>): string {
  const locations = Array.isArray(posting.jobLocation)
    ? posting.jobLocation
    : [posting.jobLocation];
  for (const location of locations) {
    const record = asRecord(location);
    const address = asRecord(record?.address);
    const parts = [
      textValue(address?.addressLocality),
      textValue(address?.addressRegion),
      textValue(address?.addressCountry),
    ].filter(Boolean);
    if (parts.length) return [...new Set(parts)].join(", ");
    const direct = textValue(location);
    if (direct) return direct;
  }
  const applicantLocations = Array.isArray(posting.applicantLocationRequirements)
    ? posting.applicantLocationRequirements
    : [posting.applicantLocationRequirements];
  return applicantLocations.map(textValue).filter(Boolean).join(", ");
}

function postingToPage(
  posting: Record<string, unknown>,
  url: string,
): NormalizedPublicJobPage | null {
  const title = textValue(posting.title) || textValue(posting.name);
  const company = textValue(posting.hiringOrganization);
  const location = locationFromPosting(posting);
  const description = htmlToText(posting.description);
  if (!title || !company || !location || !description) return null;
  const employmentType = Array.isArray(posting.employmentType)
    ? posting.employmentType.map(textValue).filter(Boolean).join(", ")
    : textValue(posting.employmentType);
  const applicant = Array.isArray(posting.applicantLocationRequirements)
    ? posting.applicantLocationRequirements
        .map(textValue)
        .filter(Boolean)
        .join(", ")
    : textValue(posting.applicantLocationRequirements);
  return {
    url,
    title,
    company,
    location,
    description,
    employmentType: employmentType || null,
    postedAt: textValue(posting.datePosted) || null,
    validThrough: textValue(posting.validThrough) || null,
    jobLocationType: textValue(posting.jobLocationType) || null,
    applicantLocationRequirements: applicant || null,
  };
}

async function firstText(
  page: WebPagePort,
  selectors: readonly string[],
): Promise<string> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) === 0) continue;
    const value = (await locator.first().innerText()).trim();
    if (value) return value;
  }
  return "";
}

async function firstAttribute(
  page: WebPagePort,
  selectors: readonly string[],
  name: string,
): Promise<string> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) === 0) continue;
    const value = await locator.first().getAttribute(name);
    if (value?.trim()) return value.trim();
  }
  return "";
}

function isInterstitial(url: string, text: string): boolean {
  try {
    const parsed = new URL(url);
    const google =
      parsed.hostname === "google.com" || parsed.hostname.endsWith(".google.com");
    return (
      google &&
      (/^\/(?:sorry|interstitial)(?:\/|$)/i.test(parsed.pathname) ||
        /\bbefore you continue to google\b/i.test(text))
    );
  } catch {
    return false;
  }
}

class PlaywrightWebDiscoverySession implements WebDiscoverySession {
  private navigated = false;

  constructor(
    private readonly page: WebPagePort,
    private readonly wait: (milliseconds: number) => Promise<void>,
    private readonly now: () => number,
    private readonly searchReadyTimeoutMs: number,
    private readonly detailReadyTimeoutMs: number,
  ) {}

  private async navigate(url: string): Promise<number | null> {
    if (this.navigated) await this.wait(1_500);
    const response = await this.page.goto(url, { waitUntil: "domcontentloaded" });
    this.navigated = true;
    return response?.status() ?? null;
  }

  private assertPage(
    status: PageStatus,
    httpStatus: number | null,
    text: string,
    operation: string,
  ): void {
    if (status === "blocked") throw new Error(BLOCKED_ERROR);
    if (status === "login-required") {
      throw new Error(`${ERROR_PREFIX} Web ${operation} login required`);
    }
    if (isInterstitial(this.page.url(), text)) {
      throw new Error(`${ERROR_PREFIX} Google search interstitial detected`);
    }
    if (httpStatus !== null && httpStatus >= 400) {
      throw new Error(
        `${ERROR_PREFIX} Web ${operation} navigation failed with HTTP ${httpStatus}`,
      );
    }
  }

  private async snapshot(
    httpStatus: number | null,
    validThrough?: string | null,
  ): Promise<{ status: PageStatus; text: string }> {
    const text = await this.page.locator("body").innerText();
    return {
      status: classifyPageStatus(
        { status: httpStatus, url: this.page.url(), text, validThrough },
        new Date(this.now()),
      ),
      text,
    };
  }

  async search(query: string, pageNumber: number): Promise<string[]> {
    const url = new URL("https://www.google.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("filter", "0");
    url.searchParams.set("start", String((Math.max(1, pageNumber) - 1) * 10));
    const httpStatus = await this.navigate(url.toString());
    const deadline = this.now() + this.searchReadyTimeoutMs;

    while (true) {
      const snapshot = await this.snapshot(httpStatus);
      this.assertPage(snapshot.status, httpStatus, snapshot.text, "search");
      const anchors = this.page.locator("#search a[href]");
      if ((await anchors.count()) > 0) {
        const results: string[] = [];
        const seen = new Set<string>();
        for (let index = 0; index < (await anchors.count()); index += 1) {
          const href = await anchors.nth(index).getAttribute("href");
          const clean = href ? sanitizeGoogleResultUrl(href) : null;
          if (clean && !seen.has(clean)) {
            seen.add(clean);
            results.push(clean);
          }
        }
        return results;
      }
      const noResults = this.page.locator(
        '#topstuff [role="heading"], #botstuff .card-section, [data-attrid="No results"]',
      );
      if ((await noResults.count()) > 0) {
        const noResultsText = await noResults.first().innerText();
        if (
          /\b(?:your search did not match any documents|no results found)\b/i.test(
            noResultsText,
          )
        ) {
          return [];
        }
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new Error(`${ERROR_PREFIX} Google search readiness timed out`);
      }
      await this.wait(Math.min(250, remaining));
    }
  }

  private async readJsonLd(): Promise<unknown[]> {
    const scripts = this.page.locator('script[type="application/ld+json"]');
    const values: unknown[] = [];
    for (let index = 0; index < (await scripts.count()); index += 1) {
      const text = await scripts.nth(index).textContent();
      if (!text) continue;
      try {
        values.push(JSON.parse(text));
      } catch {
        // Ignore malformed unrelated JSON-LD while readiness remains bounded.
      }
    }
    return values;
  }

  private async rawFallbackFields(): Promise<
    Pick<
      PublicJobPage,
      | "title"
      | "company"
      | "location"
      | "description"
      | "employmentType"
      | "postedAt"
      | "metaDescription"
      | "canonicalUrl"
    >
  > {
    const title =
      (await firstText(this.page, ["h1", '[itemprop="title"]', "title"])) ||
      (await firstAttribute(
        this.page,
        ['meta[property="og:title"], meta[name="twitter:title"]'],
        "content",
      ));
    const company = await firstText(this.page, [
      '[data-company], .company-name, [itemprop="hiringOrganization"]',
    ]);
    const location = await firstText(this.page, [
      '[data-location], .job-location, [itemprop="jobLocation"]',
    ]);
    const description = await firstText(this.page, [
      '[data-description], .job-description, [itemprop="description"], main',
    ]);
    const employmentType = await firstText(this.page, [
      '[data-employment-type], [itemprop="employmentType"]',
    ]);
    const postedAt =
      (await firstAttribute(
        this.page,
        ['time[datetime], [itemprop="datePosted"]'],
        "datetime",
      )) ||
      (await firstText(this.page, ['[itemprop="datePosted"]']));
    const metaDescription = await firstAttribute(
      this.page,
      ['meta[name="description"], meta[property="og:description"]'],
      "content",
    );
    const canonicalUrl = await firstAttribute(
      this.page,
      ['link[rel="canonical"]'],
      "href",
    );
    return {
      title: title || null,
      company: company || null,
      location: location || null,
      description: description || null,
      employmentType: employmentType || null,
      postedAt: postedAt || null,
      metaDescription: metaDescription || null,
      canonicalUrl: canonicalUrl || null,
    };
  }

  async detail(value: string): Promise<PublicJobPage | null> {
    const httpStatus = await this.navigate(value);
    const deadline = this.now() + this.detailReadyTimeoutMs;

    while (true) {
      const initial = await this.snapshot(httpStatus);
      if (initial.status !== "inactive") {
        this.assertPage(initial.status, httpStatus, initial.text, "detail");
      }
      const finalUrl = sanitizeGoogleResultUrl(this.page.url());
      if (!finalUrl) {
        throw new Error(`${ERROR_PREFIX} Unsafe redirected job detail URL`);
      }
      const jsonLd = await this.readJsonLd();
      const fallback = await this.rawFallbackFields();
      const raw: PublicJobPage = {
        status: httpStatus,
        url: finalUrl,
        text: initial.text,
        jsonLd,
        ...fallback,
      };
      const hasJobPosting = jsonLd.flatMap(jobPostingNodes).length > 0;
      const hasFallback = Boolean(
        fallback.title &&
          fallback.company &&
          fallback.location &&
          (fallback.description || fallback.metaDescription || initial.text),
      );
      if (initial.status === "inactive" || hasJobPosting || hasFallback) {
        return raw;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new Error(`${ERROR_PREFIX} Web detail readiness timed out`);
      }
      await this.wait(Math.min(250, remaining));
    }
  }
}

export class PlaywrightWebDiscoveryBrowserPort
  implements WebDiscoveryBrowserPort
{
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly searchReadyTimeoutMs: number;
  private readonly detailReadyTimeoutMs: number;

  constructor(
    private readonly runtime: BrowserRuntime,
    options: PlaywrightWebDiscoveryOptions = {},
  ) {
    this.wait =
      options.wait ||
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now || Date.now;
    this.searchReadyTimeoutMs = options.searchReadyTimeoutMs ?? 10_000;
    this.detailReadyTimeoutMs = options.detailReadyTimeoutMs ?? 10_000;
  }

  async run<T>(task: (session: WebDiscoverySession) => Promise<T>): Promise<T> {
    return this.runtime.run(async (context) => {
      const page = (context.pages()[0] ||
        (await context.newPage())) as WebPagePort;
      const session = new PlaywrightWebDiscoverySession(
        page,
        this.wait,
        this.now,
        this.searchReadyTimeoutMs,
        this.detailReadyTimeoutMs,
      );
      try {
        return await task(session);
      } catch (error) {
        throw toWebDiscoveryError(error);
      }
    });
  }
}

export interface WebDiscoveryConnectorFactoryOptions
  extends PlaywrightWebDiscoveryOptions {
  state?: WebDiscoveryStatePort;
  runtime?: BrowserRuntime;
  clock?: () => Date;
}

export function createWebDiscoveryConnector(
  config: BrowserDiscoveryConfig,
  options: WebDiscoveryConnectorFactoryOptions = {},
): WebDiscoveryConnector {
  const state = options.state || new BrowserStateStore(config.statePath);
  const runtime = options.runtime || new BrowserRuntime(config.profilePath);
  const browser = new PlaywrightWebDiscoveryBrowserPort(runtime, options);
  return new WebDiscoveryConnector(config, state, browser, options.clock);
}

export class WebDiscoveryConnector implements JobConnector {
  readonly name = "Web discovery";
  readonly execution = "browser" as const;

  constructor(
    private readonly config: BrowserDiscoveryConfig,
    private readonly state: WebDiscoveryStatePort,
    private readonly browser: WebDiscoveryBrowserPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async fetchJobs(): Promise<SourceJob[]> {
    try {
      const state = await this.state.load();
      const queries = buildWebQueries(this.config.googleMaxQueries);
      const jobs = await this.browser.run(async (session) => {
        const urls = new Map<string, string>();

        for (const query of queries) {
          for (
            let pageNumber = 1;
            pageNumber <= this.config.googleMaxPages;
            pageNumber += 1
          ) {
            if (urls.size >= MAX_DETAILS) break;
            const results = await session.search(query, pageNumber);
            for (const result of results) {
              const url = sanitizeGoogleResultUrl(result);
              if (url && !urls.has(url)) urls.set(url, url);
              if (urls.size >= MAX_DETAILS) break;
            }
            if (results.length === 0) break;
          }
          if (urls.size >= MAX_DETAILS) break;
        }

        const mapped: SourceJob[] = [];
        for (const url of urls.values()) {
          const detail = await session.detail(url);
          if (detail) {
            const job = mapPublicJobPage(detail);
            if (job) mapped.push(job);
          }
        }
        return mapped;
      });

      await this.state.save({
        ...state,
        googleLastSuccessfulAt: this.clock().toISOString(),
      });
      return jobs;
    } catch (error) {
      const failure = toWebDiscoveryError(error);
      console.error(failure.message, failure);
      throw failure;
    }
  }
}
