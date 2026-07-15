import type { BrowserDiscoveryConfig } from "../browser/config";
import {
  classifyPageStatus,
  type PageStatus,
} from "../browser/page-status";
import { BrowserRuntime } from "../browser/runtime";
import { BrowserStateStore, type BrowserState } from "../browser/state";
import type { JobConnector, SourceJob } from "../types";

const ERROR_PREFIX = "[job radar linkedin]";
const LOGIN_REQUIRED_ERROR = `${ERROR_PREFIX} LinkedIn login required`;
const BLOCKED_ERROR = `${ERROR_PREFIX} LinkedIn blocked browser discovery`;
const FEED_URL = "https://www.linkedin.com/feed/";
const CARD_SELECTOR =
  "[data-job-id], .job-card-container, li.jobs-search-results__list-item";
const JOB_LINK_SELECTOR = 'a[href*="/jobs/view/"]';
const DESCRIPTION_SELECTOR =
  ".jobs-description-content__text, .jobs-description__content, .jobs-box__html-content";
const TITLE_SELECTOR =
  ".job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1";
const COMPANY_SELECTOR =
  ".job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, a[href*='/company/']";
const LOCATION_SELECTOR =
  ".job-details-jobs-unified-top-card__primary-description-container .tvm__text, .jobs-unified-top-card__bullet";
const EMPLOYMENT_SELECTOR =
  ".job-details-preferences-and-skills__pill, .jobs-unified-top-card__job-insight";

export interface LinkedInDetail {
  externalId?: string | null;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  employmentType?: string | null;
  postedAt?: string | null;
}

export interface LinkedInJobReference {
  externalId?: string | null;
  url: string;
}

export interface LinkedInBrowserSession {
  ensureAuthenticated(): Promise<void>;
  search(url: string, limit: number): Promise<LinkedInJobReference[]>;
  detail(reference: LinkedInJobReference): Promise<LinkedInDetail | null>;
}

export interface LinkedInBrowserPort {
  run<T>(task: (session: LinkedInBrowserSession) => Promise<T>): Promise<T>;
}

export interface LinkedInStatePort {
  load(): Promise<BrowserState>;
  save(state: BrowserState): Promise<void>;
}

export interface LinkedInLocatorPort {
  count(): Promise<number>;
  nth(index: number): LinkedInLocatorPort;
  first(): LinkedInLocatorPort;
  locator(selector: string): LinkedInLocatorPort;
  getAttribute(name: string): Promise<string | null>;
  innerText(): Promise<string>;
}

export interface LinkedInPagePort {
  goto(
    url: string,
    options?: { waitUntil: "domcontentloaded" },
  ): Promise<{ status(): number } | null>;
  url(): string;
  locator(selector: string): LinkedInLocatorPort;
}

export interface PlaywrightLinkedInBrowserOptions {
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  loginTimeoutMs?: number;
}

export function withLinkedInRecency(
  value: string,
  bootstrapCompleted: boolean,
): string {
  const url = new URL(value);
  url.searchParams.set("f_TPR", bootstrapCompleted ? "r86400" : "r604800");
  url.searchParams.set("f_WT", "2");
  return url.toString();
}

function externalIdFromDetail(detail: LinkedInDetail): string {
  const explicitId = detail.externalId?.trim();
  if (explicitId) return explicitId;

  try {
    const url = new URL(detail.url);
    const queryId =
      url.searchParams.get("currentJobId") || url.searchParams.get("jobId");
    if (queryId?.trim()) return queryId.trim();

    const pathId = /\/jobs\/view\/(?:[^/]*-)?(\d+)(?:\/|$)/i.exec(
      url.pathname,
    )?.[1];
    if (pathId) return pathId;

    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return detail.url;
  }
}

function referenceKey(reference: LinkedInJobReference): string {
  const externalId = reference.externalId?.trim();
  if (externalId) return `id:${externalId}`;

  try {
    const url = new URL(reference.url);
    const queryId =
      url.searchParams.get("currentJobId") || url.searchParams.get("jobId");
    if (queryId?.trim()) return `id:${queryId.trim()}`;
    const pathId = /\/jobs\/view\/(?:[^/]*-)?(\d+)(?:\/|$)/i.exec(
      url.pathname,
    )?.[1];
    if (pathId) return `id:${pathId}`;
    return `url:${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return `url:${reference.url}`;
  }
}

function tagsFromTitle(title: string): string[] {
  const tags: string[] = [];
  if (
    /\b(?:sales|account executive|business development|revenue|commercial|partnerships?)\b/i.test(
      title,
    )
  ) {
    tags.push("Sales");
  }
  if (
    /\b(?:marketing|growth|demand generation|content|brand|communications?|seo|sem|campaigns?)\b/i.test(
      title,
    )
  ) {
    tags.push("Marketing");
  }
  return tags;
}

export function mapLinkedInJob(detail: LinkedInDetail): SourceJob {
  return {
    source: "LinkedIn",
    externalId: externalIdFromDetail(detail),
    sourceUrl: detail.url,
    originalUrl: detail.url,
    title: detail.title,
    company: detail.company,
    location: detail.location,
    country: null,
    description: detail.description,
    engagementType: detail.employmentType || null,
    remote: true,
    tags: tagsFromTitle(detail.title),
    postedAt: detail.postedAt || null,
  };
}

function hasJobRadarPrefix(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /^\[job radar(?: [^\]]+)?\](?:\s|$)/.test(error.message)
  );
}

function toLinkedInError(error: unknown): Error {
  if (hasJobRadarPrefix(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${ERROR_PREFIX} LinkedIn discovery failed: ${message}`, {
    cause: error,
  });
}

function jobUrl(value: string): string | null {
  try {
    const url = new URL(value, "https://www.linkedin.com");
    const isLinkedIn =
      url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
    if (!isLinkedIn || !url.pathname.startsWith("/jobs/view/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function optionalText(locator: LinkedInLocatorPort): Promise<string> {
  try {
    return (await locator.first().innerText()).trim();
  } catch {
    return "";
  }
}

class PlaywrightLinkedInSession implements LinkedInBrowserSession {
  private detailNavigationCompleted = false;

  constructor(
    private readonly page: LinkedInPagePort,
    private readonly wait: (milliseconds: number) => Promise<void>,
    private readonly now: () => number,
    private readonly loginTimeoutMs: number,
  ) {}

  private async currentStatus(status: number | null): Promise<PageStatus> {
    const text = await this.page.locator("body").innerText();
    return classifyPageStatus({
      status,
      url: this.page.url(),
      text,
    });
  }

  private async navigate(url: string): Promise<PageStatus> {
    const response = await this.page.goto(url, {
      waitUntil: "domcontentloaded",
    });
    return this.currentStatus(response?.status() ?? null);
  }

  private assertAccessible(status: PageStatus, operation: string): void {
    if (status === "blocked") throw new Error(BLOCKED_ERROR);
    if (status === "login-required") throw new Error(LOGIN_REQUIRED_ERROR);
    if (status === "inactive") {
      throw new Error(`${ERROR_PREFIX} LinkedIn ${operation} navigation failed`);
    }
  }

  async ensureAuthenticated(): Promise<void> {
    const status = await this.navigate(FEED_URL);
    if (status === "blocked") throw new Error(BLOCKED_ERROR);
    if (status !== "login-required") {
      this.assertAccessible(status, "feed");
      return;
    }

    console.error(
      `${ERROR_PREFIX} LinkedIn login required in the visible Chromium window`,
    );
    const deadline = this.now() + this.loginTimeoutMs;

    while (this.now() < deadline) {
      const remaining = deadline - this.now();
      await this.wait(Math.min(1_000, remaining));
      const currentStatus = await this.currentStatus(null);
      if (currentStatus === "blocked") throw new Error(BLOCKED_ERROR);
      if (currentStatus === "login-required") continue;

      const verifiedStatus = await this.navigate(FEED_URL);
      if (verifiedStatus === "login-required") continue;
      this.assertAccessible(verifiedStatus, "feed");
      return;
    }

    throw new Error(LOGIN_REQUIRED_ERROR);
  }

  async search(url: string, limit: number): Promise<LinkedInJobReference[]> {
    const status = await this.navigate(url);
    this.assertAccessible(status, "search");

    const cards = this.page.locator(CARD_SELECTOR);
    const count = Math.min(await cards.count(), limit);
    const references: LinkedInJobReference[] = [];

    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const nestedId = await card
        .locator("[data-job-id]")
        .first()
        .getAttribute("data-job-id");
      const externalId =
        (await card.getAttribute("data-job-id")) || nestedId || undefined;
      const href =
        (await card.getAttribute("href")) ||
        (await card
          .locator(JOB_LINK_SELECTOR)
          .first()
          .getAttribute("href"));
      const url = href ? jobUrl(href) : null;
      if (url) references.push({ externalId, url });
    }

    return references;
  }

  async detail(reference: LinkedInJobReference): Promise<LinkedInDetail | null> {
    if (this.detailNavigationCompleted) await this.wait(1_500);
    const status = await this.navigate(reference.url);
    this.detailNavigationCompleted = true;
    if (status === "blocked") throw new Error(BLOCKED_ERROR);
    if (status === "login-required") throw new Error(LOGIN_REQUIRED_ERROR);
    if (status === "inactive") return null;

    const title = await optionalText(this.page.locator(TITLE_SELECTOR));
    const company = await optionalText(this.page.locator(COMPANY_SELECTOR));
    const description = await optionalText(
      this.page.locator(DESCRIPTION_SELECTOR),
    );
    if (!title || !company || !description) {
      throw new Error(
        `${ERROR_PREFIX} LinkedIn detail parser failed for ${reference.url}`,
      );
    }

    const location =
      (await optionalText(this.page.locator(LOCATION_SELECTOR))) ||
      "Location not specified";
    const employmentType =
      (await optionalText(this.page.locator(EMPLOYMENT_SELECTOR))) || null;
    const postedAt =
      (await this.page
        .locator("time[datetime]")
        .first()
        .getAttribute("datetime")) || null;

    return {
      externalId: reference.externalId,
      url: jobUrl(this.page.url()) || reference.url,
      title,
      company,
      location,
      description,
      employmentType,
      postedAt,
    };
  }
}

export class PlaywrightLinkedInBrowserPort implements LinkedInBrowserPort {
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly loginTimeoutMs: number;

  constructor(
    private readonly runtime: BrowserRuntime,
    options: PlaywrightLinkedInBrowserOptions = {},
  ) {
    this.wait =
      options.wait ||
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now || Date.now;
    this.loginTimeoutMs = options.loginTimeoutMs ?? 300_000;
  }

  async run<T>(task: (session: LinkedInBrowserSession) => Promise<T>): Promise<T> {
    return this.runtime.run(async (context) => {
      const page = (context.pages()[0] ||
        (await context.newPage())) as LinkedInPagePort;
      const session = new PlaywrightLinkedInSession(
        page,
        this.wait,
        this.now,
        this.loginTimeoutMs,
      );

      try {
        return await task(session);
      } catch (error) {
        throw toLinkedInError(error);
      }
    });
  }
}

export interface LinkedInConnectorFactoryOptions
  extends PlaywrightLinkedInBrowserOptions {
  state?: LinkedInStatePort;
  runtime?: BrowserRuntime;
  clock?: () => Date;
}

export function createLinkedInConnector(
  config: BrowserDiscoveryConfig,
  options: LinkedInConnectorFactoryOptions = {},
): LinkedInConnector {
  const state = options.state || new BrowserStateStore(config.statePath);
  const runtime = options.runtime || new BrowserRuntime(config.profilePath);
  const browser = new PlaywrightLinkedInBrowserPort(runtime, options);
  return new LinkedInConnector(config, state, browser, options.clock);
}

export class LinkedInConnector implements JobConnector {
  readonly name = "LinkedIn";
  readonly execution = "browser" as const;

  constructor(
    private readonly config: BrowserDiscoveryConfig,
    private readonly state: LinkedInStatePort,
    private readonly browser: LinkedInBrowserPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async fetchJobs(): Promise<SourceJob[]> {
    try {
      const state = await this.state.load();
      const resultLimit = state.linkedinBootstrapCompleted
        ? this.config.linkedinIncrementalMaxResults
        : this.config.linkedinBootstrapMaxResults;

      const jobs = await this.browser.run(async (session) => {
        await session.ensureAuthenticated();
        const references = new Map<string, LinkedInJobReference>();

        for (const savedSearchUrl of this.config.linkedinSearchUrls) {
          const remaining = resultLimit - references.size;
          if (remaining <= 0) break;
          const searchUrl = withLinkedInRecency(
            savedSearchUrl,
            state.linkedinBootstrapCompleted,
          );
          const results = await session.search(searchUrl, remaining);

          for (const reference of results) {
            if (!reference.url?.trim()) {
              throw new Error("LinkedIn search result is missing a job URL");
            }
            const key = referenceKey(reference);
            if (!references.has(key)) references.set(key, reference);
            if (references.size >= resultLimit) break;
          }
        }

        const details: SourceJob[] = [];
        const boundedReferences = [...references.values()].slice(
          0,
          this.config.linkedinMaxDetails,
        );
        for (const reference of boundedReferences) {
          const detail = await session.detail(reference);
          if (detail) details.push(mapLinkedInJob(detail));
        }
        return details;
      });

      await this.state.save({
        ...state,
        linkedinBootstrapCompleted: true,
        linkedinLastSuccessfulAt: this.clock().toISOString(),
      });
      return jobs;
    } catch (error) {
      const failure = toLinkedInError(error);
      console.error(failure.message, failure);
      throw failure;
    }
  }
}
