export type JobCategory = "Sales" | "Marketing";
export type SyncStatus = "success" | "partial" | "failed";

export interface SourceJob {
  source: string;
  externalId: string;
  sourceUrl: string;
  originalUrl: string;
  title: string;
  company: string;
  location: string;
  country: string | null;
  description: string;
  engagementType: string | null;
  remote: boolean | null;
  tags: string[];
  postedAt: string | null;
}

export interface MatchedJob extends SourceJob {
  canonicalUrl: string;
  category: JobCategory;
  normalizedEngagementType: string;
  matchReasons: string[];
}

export type MatchResult =
  | {
      matched: true;
      category: JobCategory;
      engagementType: string;
      matchReasons: string[];
    }
  | {
      matched: false;
      rejectionReason: string;
    };

export interface StoredJob extends MatchedJob {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SourceResult {
  source: string;
  status: "success" | "failed" | "skipped";
  fetched: number;
  accepted: number;
  rejected: number;
  message?: string;
}

export interface SyncSummary {
  runId: string;
  status: SyncStatus;
  startedAt: string;
  completedAt: string;
  fetched: number;
  accepted: number;
  rejected: number;
  newJobs: number;
  updatedJobs: number;
  sourceResults: SourceResult[];
  sourceErrors: string[];
}

export interface DashboardStats {
  totalJobs: number;
  newJobs: number;
  lastRun: SyncSummary | null;
  latestBrowserRequest: SyncRequest | null;
}

// A user-defined search. `keywords` drives every source's query; `location`
// is used by Jooble and the LinkedIn URL; `remoteOnly` narrows LinkedIn to
// remote roles (the matcher enforces remote regardless).
export interface SearchSpec {
  keywords: string;
  location: string;
  remoteOnly: boolean;
}

export interface SearchRecord extends SearchSpec {
  id: string;
  createdAt: string;
}

export type SyncRequestKind = "linkedin";

export type SyncRequestStatus = "pending" | "running" | "done" | "failed";

export interface SyncRequest {
  id: string;
  kind: SyncRequestKind;
  status: SyncRequestStatus;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  runId: string | null;
  message: string | null;
}

export interface JobConnector {
  name: string;
  execution?: "parallel" | "browser";
  fetchJobs(): Promise<SourceJob[]>;
}

export interface JobRepository {
  startSyncRun(startedAt: string): Promise<string>;
  upsertJob(job: MatchedJob, seenAt: string): Promise<"created" | "updated">;
  deleteJobBySourceId(source: string, externalId: string): Promise<void>;
  listJobsForValidation(
    sources: string[],
    afterId: string | null,
    limit: number,
  ): Promise<StoredJob[]>;
  deleteJobById(id: string): Promise<void>;
  finishSyncRun(summary: SyncSummary): Promise<void>;
  listJobs(): Promise<StoredJob[]>;
  getDashboardStats(): Promise<DashboardStats>;
  // Most recent run's start time (any status) — used to rate-limit manual syncs.
  getLatestRunStartedAt(): Promise<string | null>;
  // Browser-sync request queue (button → local worker).
  requestBrowserSync(kind: SyncRequestKind, requestedAt: string): Promise<SyncRequest>;
  getLatestBrowserRequest(kind: SyncRequestKind): Promise<SyncRequest | null>;
  claimNextBrowserRequest(
    kind: SyncRequestKind,
    startedAt: string,
  ): Promise<SyncRequest | null>;
  completeBrowserRequest(
    id: string,
    status: Extract<SyncRequestStatus, "done" | "failed">,
    completedAt: string,
    details: { runId?: string | null; message?: string | null },
  ): Promise<void>;
  // User-managed searches.
  listSearches(): Promise<SearchRecord[]>;
  addSearch(spec: SearchSpec, createdAt: string): Promise<SearchRecord>;
  deleteSearch(id: string): Promise<void>;
}
