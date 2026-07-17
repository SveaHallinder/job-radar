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

// Run an async mapper over items with at most `limit` calls in flight at once.
// Results are stored by original index, so ordering is independent of which
// task settles first.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await task(items[current]);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
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
  const runId = await repository.startSyncRun(startedAt);

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

    // matchJob is pure, so compute every match up front (order-independent).
    const matches = source.jobs.map((job) => matchJob(job));

    // Resolve redirect URLs for matched jobs with bounded concurrency BEFORE the
    // sequential dedup pass. Only matched jobs that need resolution hit the
    // network; everything else keeps its original URL. Results are keyed by the
    // original job index so the dedup pass below stays fully deterministic.
    const resolvedUrls = new Array<string>(source.jobs.length);
    const pendingIndexes: number[] = [];
    for (let i = 0; i < source.jobs.length; i += 1) {
      if (!matches[i].matched) continue;
      const job = source.jobs[i];
      if (needsRedirectResolution(job)) {
        pendingIndexes.push(i);
      } else {
        resolvedUrls[i] = job.originalUrl;
      }
    }
    const resolved = await mapWithConcurrency(pendingIndexes, 8, (index) =>
      resolveUrl(source.jobs[index].originalUrl),
    );
    pendingIndexes.forEach((index, position) => {
      resolvedUrls[index] = resolved[position];
    });

    // Sequential dedup/accept pass in original order using the resolved URLs.
    for (let i = 0; i < source.jobs.length; i += 1) {
      const job = source.jobs[i];
      const match = matches[i];
      if (!match.matched) {
        rejected += 1;
        sourceResult.rejected += 1;
        await repository.deleteJobBySourceId(job.source, job.externalId);
        continue;
      }

      const resolvedUrl = resolvedUrls[i];
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
    const result = await repository.upsertJob(job, startedAt);
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

  await repository.finishSyncRun(summary);
  return summary;
}
