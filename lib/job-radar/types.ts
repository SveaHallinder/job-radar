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
}
