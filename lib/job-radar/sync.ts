import type { ActiveValidator } from "./active-validation";
import { getConnectorConfiguration } from "./connectors";
import { getJobRepository } from "./db";
import { resolveRedirect } from "./fetch";
import { canonicalizeUrl, matchJob } from "./matcher";
import type {
  JobConnector,
  JobRepository,
  MatchedJob,
  SourceJob,
  SourceResult,
  SyncSummary,
} from "./types";

interface SyncOptions {
  connectors?: JobConnector[];
  skippedSources?: string[];
  repository?: JobRepository;
  clock?: () => Date;
  resolveUrl?: (url: string) => Promise<string>;
  browserDiscovery?: boolean;
  activeValidator?: ActiveValidator;
}

interface FetchedSource {
  connector: JobConnector;
  jobs: SourceJob[];
  error?: Error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown source error";
}

function duplicateKey(job: SourceJob): string {
  return `${job.company}|${job.title}`
    .toLocaleLowerCase("en")
    .normalize("NFKD")
    .replace(/[^a-z0-9|]+/g, " ")
    .trim();
}

function needsRedirectResolution(job: SourceJob): boolean {
  return job.source === "Arbeitnow" || job.source === "Jooble";
}

async function fetchSource(connector: JobConnector): Promise<FetchedSource> {
  try {
    return { connector, jobs: await connector.fetchJobs() };
  } catch (error) {
    console.error(`[job radar] ${connector.name} sync failed`, error);
    return {
      connector,
      jobs: [],
      error: error instanceof Error ? error : new Error(errorMessage(error)),
    };
  }
}

export async function syncJobs(options: SyncOptions = {}): Promise<SyncSummary> {
  const clock = options.clock ?? (() => new Date());
  const repository = options.repository ?? getJobRepository();
  const resolveUrl = options.resolveUrl ?? resolveRedirect;
  const browserDiscovery = options.browserDiscovery ?? true;
  const configured = options.connectors
    ? {
        connectors: options.connectors,
        skippedSources: options.skippedSources ?? [],
        activeValidator: options.activeValidator,
      }
    : getConnectorConfiguration();
  const activeValidator = browserDiscovery
    ? (options.activeValidator ?? configured.activeValidator)
    : undefined;
  const startedAt = clock().toISOString();
  const runId = repository.startSyncRun(startedAt);

  const parallelConnectors = configured.connectors.filter(
    (connector) => connector.execution !== "browser",
  );
  const browserConnectors = configured.connectors.filter(
    (connector) => connector.execution === "browser",
  );
  const skippedSources = [...configured.skippedSources];
  if (!browserDiscovery) {
    for (const connector of browserConnectors) {
      skippedSources.push(`${connector.name} · skipped in hosted environment`);
    }
  }

  // API connectors run concurrently; browser connectors must run serially so
  // only one visible Chromium session is active at a time.
  const fetchedSources: FetchedSource[] = await Promise.all(
    parallelConnectors.map(fetchSource),
  );
  if (browserDiscovery) {
    for (const connector of browserConnectors) {
      fetchedSources.push(await fetchSource(connector));
    }
  }

  const sourceResults: SourceResult[] = [];
  const sourceErrors: string[] = [];
  const acceptedJobs: MatchedJob[] = [];
  const canonicalUrls = new Set<string>();
  const companyTitles = new Set<string>();
  let fetched = 0;
  let rejected = 0;

  for (const source of fetchedSources) {
    if (source.error) {
      const message = `${source.connector.name}: ${errorMessage(source.error).replace(/^\[job radar\]\s*/, "")}`;
      sourceErrors.push(message);
      sourceResults.push({
        source: source.connector.name,
        status: "failed",
        fetched: 0,
        accepted: 0,
        rejected: 0,
        message,
      });
      continue;
    }

    fetched += source.jobs.length;
    const sourceResult: SourceResult = {
      source: source.connector.name,
      status: "success",
      fetched: source.jobs.length,
      accepted: 0,
      rejected: 0,
    };

    for (const job of source.jobs) {
      const match = matchJob(job);
      if (!match.matched) {
        rejected += 1;
        sourceResult.rejected += 1;
        repository.deleteJobBySourceId(job.source, job.externalId);
        continue;
      }

      const resolvedUrl = needsRedirectResolution(job)
        ? await resolveUrl(job.originalUrl)
        : job.originalUrl;
      const canonicalUrl = canonicalizeUrl(resolvedUrl);
      const fallbackKey = duplicateKey(job);

      if (canonicalUrls.has(canonicalUrl) || companyTitles.has(fallbackKey)) {
        continue;
      }

      canonicalUrls.add(canonicalUrl);
      companyTitles.add(fallbackKey);
      sourceResult.accepted += 1;
      acceptedJobs.push({
        ...job,
        originalUrl: resolvedUrl,
        canonicalUrl,
        category: match.category,
        normalizedEngagementType: match.engagementType,
        matchReasons: match.matchReasons,
      });
    }

    sourceResults.push(sourceResult);
  }

  for (const skippedSource of skippedSources) {
    sourceResults.push({
      source: skippedSource.split(" · ")[0],
      status: "skipped",
      fetched: 0,
      accepted: 0,
      rejected: 0,
      message: skippedSource,
    });
  }

  let newJobs = 0;
  let updatedJobs = 0;
  for (const job of acceptedJobs) {
    const result = repository.upsertJob(job, startedAt);
    if (result === "created") newJobs += 1;
    else updatedJobs += 1;
  }

  if (activeValidator) {
    try {
      const result = await activeValidator(repository);
      sourceResults.push({
        source: "Active validation",
        status: "success",
        fetched: result.checked,
        accepted: result.checked - result.deleted,
        rejected: result.deleted,
        message: `${result.deleted} inactive jobs removed; ${result.unknown} ambiguous jobs preserved`,
      });
    } catch (error) {
      const message = `[job radar browser] Active validation failed: ${errorMessage(error)}`;
      sourceErrors.push(message);
      sourceResults.push({
        source: "Active validation",
        status: "failed",
        fetched: 0,
        accepted: 0,
        rejected: 0,
        message,
      });
    }
  }

  // Final status reflects every non-skipped source, including active validation.
  const gradedResults = sourceResults.filter((result) => result.status !== "skipped");
  const failedSources = gradedResults.filter((result) => result.status === "failed").length;
  const successfulSources = gradedResults.length - failedSources;
  const status = failedSources === 0 ? "success" : successfulSources > 0 ? "partial" : "failed";
  const summary: SyncSummary = {
    runId,
    status,
    startedAt,
    completedAt: clock().toISOString(),
    fetched,
    accepted: acceptedJobs.length,
    rejected,
    newJobs,
    updatedJobs,
    sourceResults,
    sourceErrors,
  };

  repository.finishSyncRun(summary);
  return summary;
}
